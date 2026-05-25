const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

const TAG = '[Master]';

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
        if (this.token) return;

        try {
            const response = await this.client.post('/auth/login', {
                appKey: this.config.appKey,
                secretKey: this.config.secretKey
            });
            const data = Array.isArray(response.data) ? response.data[0] : response.data;
            this.token = data?.result?.token;
            if (!this.token) throw new Error('No token received in login response');
            this.client.defaults.headers.common['authorization'] = this.token;
        } catch (error) {
            console.error(`${TAG} Login failed:`, error.response?.data?.description || error.message);
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
                // Extract and parse ALL fields from XTS instrument master data
                // Based on actual raw data from XTS API response
                const instrument = {
                    exchangeSegmentCode,
                    exchangeSegment: this.segmentCodeToId[exchangeSegmentCode] || 1,
                    
                    // Field 0: Exchange Segment
                    instrumentType: parts[0],
                    
                    // Field 1: Exchange Instrument ID
                    exchangeInstrumentID: parts[1] ? parseInt(parts[1], 10) : null,
                    
                    // Field 2: ?
                    field2: parts[2],
                    
                    // Field 3: Symbol (Underlying)
                    symbol: parts[3],
                    
                    // Field 4: Trading Symbol
                    tradingSymbol: parts[4],
                    
                    // Field 5: Instrument Type Name
                    instrumentTypeName: parts[5],
                    
                    // Field 6: ?
                    field6: parts[6],
                    
                    // Field 7: ?
                    field7: parts[7],
                    
                    // Field 8: Price Numerator
                    priceNumerator: parts[8],
                    
                    // Field 9: Price Denominator
                    priceDenominator: parts[9],
                    
                    // Field 10: ?
                    field10: parts[10],
                    
                    // Field 11: Tick Size
                    tickSize: parts[11] ? parseFloat(parts[11]) : null,
                    
                    // Field 12: Lot Size
                    lotSize: parts[12] ? parseInt(parts[12], 10) : null,
                    
                    // Field 13: ?
                    field13: parts[13],
                    
                    // Field 14: ?
                    field14: parts[14],
                    
                    // Field 15: Symbol again?
                    field15: parts[15],
                    
                    // Field 16: Expiry Date (ISO format: YYYY-MM-DDTHH:mm:ss)
                    expiry: parts[16],
                    
                    // Field 17: Strike Price
                    strikePrice: parts[17] ? parseFloat(parts[17]) : null,
                    
                    // Field 18: ?
                    field18: parts[18],
                    
                    // Field 19: Description (contains option type)
                    description: parts[19],
                    
                    // Additional fields (if any)
                    raw: parts
                };
                
                // Parse expiry date from field 16 (ISO format)
                if (instrument.expiry) {
                    instrument.expiryDate = new Date(instrument.expiry);
                }
                
                // Parse option type from description (field 19)
                if (instrument.description) {
                    if (instrument.description.includes(' CE ')) {
                        instrument.optionType = 'CE';
                    } else if (instrument.description.includes(' PE ')) {
                        instrument.optionType = 'PE';
                    }
                }
                
                // Fallback: parse strike and option type from trading symbol if needed
                if ((!instrument.strikePrice || !instrument.optionType) && instrument.tradingSymbol) {
                    const parsed = this.parseTradingSymbol(instrument.tradingSymbol);
                    if (parsed) {
                        if (!instrument.strikePrice) instrument.strikePrice = parsed.strike;
                        if (!instrument.optionType) instrument.optionType = parsed.optionType;
                    }
                }
                
                if (instrument.symbol) {
                    instruments.push(instrument);
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
        console.log(`${TAG} Downloading master for ${exchangeSegmentCode}...`);
        try {
            const response = await this.client.post('/instruments/master', {
                exchangeSegmentList: [exchangeSegmentCode]
            });
            const pipeData = response.data?.result || '';
            const instruments = this.parsePipeData(pipeData, exchangeSegmentCode);
            this.ensureMasterDir();
            const filePath = this.getMasterFilePath(exchangeSegmentCode);
            fs.writeFileSync(filePath, JSON.stringify(instruments, null, 2));
            console.log(`${TAG} Downloaded ${instruments.length} instruments for ${exchangeSegmentCode}`);
            return instruments;
        } catch (error) {
            console.error(`${TAG} Download failed for ${exchangeSegmentCode}:`, error.response?.data?.description || error.message);
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
            const filePath = this.getMasterFilePath(exchangeSegmentCode);
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        return this.downloadMaster(exchangeSegmentCode);
    }

    /**
     * Build symbol map from instrument masters
     * @param {Array<string>} exchangeSegmentCodes - List of exchange segment codes to load
     * @returns {Promise<Object>} Symbol map { 'SYMBOL': { exchangeSegment, exchangeInstrumentID } }
     */
    async buildSymbolMap(exchangeSegmentCodes = ['NSEFO']) {
        const symbolMap = {};

        // Process NSECM (spot) FIRST to prioritize spot instruments
        const processedSegments = new Set();
        
        // Always process NSECM first if it's in the list
        const sortedSegments = [...exchangeSegmentCodes].sort((a, b) => {
            if (a === 'NSECM') return -1;
            if (b === 'NSECM') return 1;
            return 0;
        });

        for (const segmentCode of sortedSegments) {
            if (processedSegments.has(segmentCode)) continue;
            processedSegments.add(segmentCode);
            
            try {
                const instruments = await this.loadMaster(segmentCode);
                const isSpotSegment = segmentCode === 'NSECM';
                
                instruments.forEach(inst => {
                    // Add symbol - spot instruments take priority
                    if (inst.symbol) {
                        const symbolKey = String(inst.symbol).toUpperCase().trim();
                        if (symbolKey && (!symbolMap[symbolKey] || isSpotSegment)) {
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
                
                console.log(`${TAG} Loaded ${instruments.length} instruments for ${segmentCode}`);
            } catch (error) {
                console.error(`${TAG} Failed to load ${segmentCode}:`, error.message);
            }
        }

        // Fallback NIFTY mapping in case master download failed
        if (!symbolMap.NIFTY) {
            console.warn(`${TAG} NIFTY not found in master — using default mapping`);
            symbolMap.NIFTY  = { exchangeSegment: 1, exchangeInstrumentID: 22 };
            symbolMap.NIFTY50 = { exchangeSegment: 1, exchangeInstrumentID: 22 };
        }

        console.log(`${TAG} Symbol map built — ${Object.keys(symbolMap).length} entries`);
        return symbolMap;
    }

    /**
     * Parse trading symbol into its components
     * @param {string} tradingSymbol - Trading symbol (e.g., "SBIN26JUN660PE")
     * @returns {Object|null} Parsed components or null if invalid
     */
    parseTradingSymbol(tradingSymbol) {
        // Pattern: [Underlying][2-digit year][3-letter month][Strike][Option Type]
        // Example: SBIN26JUN660PE → underlying=SBIN, year=26, month=JUN, strike=660, optionType=PE
        const match = tradingSymbol.match(/^([A-Z0-9]+)(\d{2})([A-Z]{3})(\d+)(PE|CE)$/);
        if (!match) return null;

        const [, underlying, yearStr, month, strikeStr, optionType] = match;
        const strike = parseFloat(strikeStr);
        const year = 2000 + parseInt(yearStr, 10);

        // Convert month abbreviation to number (0-11)
        const monthMap = {
            JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
            JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
        };
        const monthNum = monthMap[month];
        if (monthNum === undefined) return null;

        // Create a date object for expiry (approximate, just for comparison)
        const expiryDate = new Date(year, monthNum, 1);

        return {
            underlying,
            year,
            month,
            monthNum,
            strike,
            optionType,
            expiryDate
        };
    }

    /**
     * Get all options for a specific underlying from loaded instruments
     * @param {Array} instruments - List of instruments
     * @param {string} underlying - Underlying symbol (e.g., "SBIN")
     * @returns {Array} Filtered list of option instruments
     */
    getOptionsForUnderlying(instruments, underlying) {
        const upperUnderlying = underlying.toUpperCase();
        return instruments
            .filter(inst => inst.exchangeSegmentCode === 'NSEFO')
            .filter(inst => inst.symbol && inst.symbol.toUpperCase() === upperUnderlying);
    }

    /**
     * Find the most recent expiry from a list of options
     * @param {Array} options - List of options
     * @returns {Date|null} Most recent expiry date
     */
    findMostRecentExpiry(options) {
        const now = new Date();
        // Set time to start of day to avoid time issues
        now.setHours(0, 0, 0, 0);
        
        const validExpiries = options
            .filter(opt => opt.expiryDate)
            .map(opt => {
                const date = new Date(opt.expiryDate);
                date.setHours(0, 0, 0, 0);
                return date;
            })
            .filter(date => date >= now)
            .sort((a, b) => a - b);

        return validExpiries.length > 0 ? validExpiries[0] : null;
    }

    /**
     * Select OTM strike option for a given underlying and signal
     * @param {Array} instruments - List of all instruments
     * @param {string} underlying - Underlying symbol
     * @param {string} action - Signal action (BUY/SELL)
     * @param {number} underlyingPrice - Current price of the underlying (optional)
     * @returns {Object|null} Selected option instrument
     */
    selectOTMOption(instruments, underlying, action, underlyingPrice = null) {
        const options = this.getOptionsForUnderlying(instruments, underlying);
        if (options.length === 0) {
            console.warn(`${TAG} No options found for underlying: ${underlying}`);
            return null;
        }

        const recentExpiry = this.findMostRecentExpiry(options);
        if (!recentExpiry) {
            console.warn(`${TAG} No valid future expiry found for ${underlying}`);
            return null;
        }

        // Filter options with the most recent expiry (using actual expiryDate)
        const recentExpiryOptions = options.filter(opt => {
            if (!opt.expiryDate) return false;
            const optDate = new Date(opt.expiryDate);
            optDate.setHours(0, 0, 0, 0);
            return optDate.getTime() === recentExpiry.getTime();
        });

        // Determine option type based on action:
        // - BUY signal → CE (Call Option)
        // - SELL signal → PE (Put Option)
        const targetOptionType = action === 'BUY' ? 'CE' : 'PE';
        const targetOptions = recentExpiryOptions.filter(opt => 
            opt.optionType === targetOptionType
        );

        if (targetOptions.length === 0) {
            console.warn(`${TAG} No ${targetOptionType} options for ${underlying} expiry ${recentExpiry.toDateString()}`);
            return null;
        }

        // Sort by strike price (use actual strikePrice from master data)
        targetOptions.sort((a, b) => {
            const strikeA = a.strikePrice || 0;
            const strikeB = b.strikePrice || 0;
            return strikeA - strikeB;
        });

        // Select ATM strike (closest to underlying price)
        let selectedOption;
        if (underlyingPrice && typeof underlyingPrice === 'number' && !isNaN(underlyingPrice)) {
            let minDiff = Infinity;
            for (const opt of targetOptions) {
                const strike = opt.strikePrice || 0;
                const diff = Math.abs(strike - underlyingPrice);
                if (diff < minDiff) {
                    minDiff = diff;
                    selectedOption = opt;
                }
            }
        } else {
            // If we don't have underlying price, pick the middle strike as a fallback
            const middleIndex = Math.floor(targetOptions.length / 2);
            selectedOption = targetOptions[middleIndex];
        }

        console.log(`${TAG} ATM option selected: ${selectedOption.tradingSymbol} (strike ${selectedOption.strikePrice}, ${targetOptionType})`);
        return selectedOption;
    }
}

module.exports = InstrumentMasterManager;
