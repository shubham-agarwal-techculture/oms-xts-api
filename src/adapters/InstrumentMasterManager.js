const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

class InstrumentMasterManager {
    constructor(config) {
        this.config = config;
        this.masterDir = path.join(process.cwd(), 'data', 'masters');
        this.token = null;
        this.client = axios.create({
            baseURL: config.baseUrl,
            headers: { 'Content-Type': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        
        // Map exchange segment codes to numeric IDs for order placement
        this.segmentCodeToId = {
            'NSECM': 1,
            'NSEFO': 2,
            'NSECD': 3,
            'NSECO': 4,
            'BSECM': 11,
            'BSEFO': 12,
            'BSECD': 13,
            'BSECO': 14,
            'MCXFO': 21,
            'NCDEX': 41
        };
    }

    /**
     * Ensure master directory exists
     */
    ensureMasterDir() {
        if (!fs.existsSync(this.masterDir)) {
            fs.mkdirSync(this.masterDir, { recursive: true });
            console.log(`Created instrument master directory: ${this.masterDir}`);
        }
    }

    /**
     * Get master file path for a specific exchange segment
     * @param {string} exchangeSegmentCode - Exchange segment code (e.g., "NSECM")
     * @returns {string} File path
     */
    getMasterFilePath(exchangeSegmentCode) {
        return path.join(this.masterDir, `instrument_master_${exchangeSegmentCode}.json`);
    }

    /**
     * Check if master file exists for exchange segment
     * @param {string} exchangeSegmentCode 
     * @returns {boolean}
     */
    masterFileExists(exchangeSegmentCode) {
        const filePath = this.getMasterFilePath(exchangeSegmentCode);
        return fs.existsSync(filePath);
    }

    /**
     * Login to XTS API (if not already logged in)
     */
    async login() {
        if (this.token) {
            console.log('Already logged in for instrument master');
            return;
        }

        console.log('Logging in to XTS for instrument master...');
        try {
            const response = await this.client.post('/auth/login', {
                appKey: this.config.appKey,
                secretKey: this.config.secretKey
            });

            const data = Array.isArray(response.data) ? response.data[0] : response.data;
            this.token = data?.result?.token;
            
            if (!this.token) {
                throw new Error('No token received in login response');
            }
            
            this.client.defaults.headers.common['authorization'] = this.token;
            console.log('Instrument master login successful');
        } catch (error) {
            console.error('Instrument master login failed:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Parse pipe-separated instrument master data
     * @param {string} pipeData - Pipe-separated string from API
     * @param {string} exchangeSegmentCode - Exchange segment code
     * @returns {Array} Parsed instruments
     */
    parsePipeData(pipeData, exchangeSegmentCode) {
        const instruments = [];
        
        // Split by newlines first - each line is an instrument
        const instrumentLines = pipeData.split('\n').filter(line => line.trim());
        
        for (const line of instrumentLines) {
            const parts = line.split('|');
            if (parts.length >= 20) {
                const symbol = parts[3];
                const tradingSymbol = parts[4];
                const exchangeInstrumentID = parts[1];
                const description = parts[18];
                
                // Get numeric segment ID
                const exchangeSegment = this.segmentCodeToId[exchangeSegmentCode] || 1;
                
                if (symbol) {
                    instruments.push({
                        symbol,
                        tradingSymbol,
                        description,
                        exchangeSegment,
                        exchangeInstrumentID,
                        exchangeSegmentCode
                    });
                }
            }
        }
        
        return instruments;
    }

    /**
     * Download instrument master for exchange segment
     * @param {string} exchangeSegmentCode - Exchange segment code (e.g., "NSECM")
     * @returns {Promise<Array>} Instrument list
     */
    async downloadMaster(exchangeSegmentCode) {
        await this.login();
        
        console.log(`Downloading instrument master for exchange segment ${exchangeSegmentCode}...`);
        
        try {
            const response = await this.client.post('/instruments/master', {
                exchangeSegmentList: [exchangeSegmentCode]
            });
            
            const pipeData = response.data?.result || '';
            const instruments = this.parsePipeData(pipeData, exchangeSegmentCode);
            
            // Save to file
            this.ensureMasterDir();
            const filePath = this.getMasterFilePath(exchangeSegmentCode);
            fs.writeFileSync(filePath, JSON.stringify(instruments, null, 2));
            console.log(`Saved instrument master to ${filePath} (${instruments.length} instruments)`);
            
            return instruments;
        } catch (error) {
            console.error(`Failed to download instrument master for segment ${exchangeSegmentCode}:`, error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Load instrument master from file or download if missing
     * @param {string} exchangeSegmentCode - Exchange segment code
     * @returns {Promise<Array>} Instrument list
     */
    async loadMaster(exchangeSegmentCode) {
        this.ensureMasterDir();
        
        if (this.masterFileExists(exchangeSegmentCode)) {
            console.log(`Loading instrument master from file for segment ${exchangeSegmentCode}`);
            const filePath = this.getMasterFilePath(exchangeSegmentCode);
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        } else {
            console.log(`Instrument master file not found for segment ${exchangeSegmentCode}`);
            return this.downloadMaster(exchangeSegmentCode);
        }
    }

    /**
     * Build symbol map from instrument masters
     * @param {Array<string>} exchangeSegmentCodes - List of exchange segment codes to load
     * @returns {Promise<Object>} Symbol map { 'SYMBOL': { exchangeSegment, exchangeInstrumentID } }
     */
    async buildSymbolMap(exchangeSegmentCodes = ['NSECM']) {
        const symbolMap = {};

        for (const segmentCode of exchangeSegmentCodes) {
            try {
                const instruments = await this.loadMaster(segmentCode);
                
                instruments.forEach(inst => {
                    // Add symbol
                    if (inst.symbol) {
                        const symbolKey = String(inst.symbol).toUpperCase().trim();
                        if (symbolKey && !symbolMap[symbolKey]) {
                            symbolMap[symbolKey] = {
                                exchangeSegment: inst.exchangeSegment,
                                exchangeInstrumentID: inst.exchangeInstrumentID
                            };
                        }
                    }
                    
                    // Add trading symbol
                    if (inst.tradingSymbol) {
                        const tradingSymbolKey = String(inst.tradingSymbol).toUpperCase().trim();
                        if (tradingSymbolKey && !symbolMap[tradingSymbolKey]) {
                            symbolMap[tradingSymbolKey] = {
                                exchangeSegment: inst.exchangeSegment,
                                exchangeInstrumentID: inst.exchangeInstrumentID
                            };
                        }
                    }
                    
                    // Also add description as symbol if available
                    if (inst.description) {
                        const descKey = String(inst.description).toUpperCase().trim();
                        if (descKey && !symbolMap[descKey]) {
                            symbolMap[descKey] = {
                                exchangeSegment: inst.exchangeSegment,
                                exchangeInstrumentID: inst.exchangeInstrumentID
                            };
                        }
                    }
                });
                
                console.log(`Loaded ${instruments.length} instruments for segment ${segmentCode}`);
            } catch (error) {
                console.error(`Failed to load instrument master for segment ${segmentCode}:`, error.message);
            }
        }

        // Add default NIFTY mapping (in case master download fails)
        if (!symbolMap.NIFTY) {
            console.warn('Adding default NIFTY mapping');
            symbolMap.NIFTY = { exchangeSegment: 1, exchangeInstrumentID: 22 };
            symbolMap.NIFTY50 = { exchangeSegment: 1, exchangeInstrumentID: 22 };
        }

        console.log(`Symbol map built with ${Object.keys(symbolMap).length} symbols`);
        return symbolMap;
    }
}

module.exports = InstrumentMasterManager;
