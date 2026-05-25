const OrderExecutor = require('../interfaces/OrderExecutor');
const InstrumentMasterManager = require('./InstrumentMasterManager');
const axios = require('axios');
const https = require('https');

class XTSOrderExecutor extends OrderExecutor {
    constructor(config) {
        super();
        this.config = config;
        this.token = null;
        this.userID = null;
        this.client = axios.create({
            baseURL: config.baseUrl,
            headers: { 'Content-Type': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        
        // Initialize Instrument Master Manager with Market Data API config
        this.masterManager = new InstrumentMasterManager(config.marketDataConfig || config);
        
        // Store all loaded instruments for option selection
        this.instruments = [];
        
        // Default symbol map (will be replaced with loaded master data)
        this.symbolMap = {
            'NIFTY': { exchangeSegment: 1, exchangeInstrumentID: 22 },
            'NIFTY50': { exchangeSegment: 1, exchangeInstrumentID: 22 }
        };
        
        // Flag to track if symbol map is loaded
        this.symbolMapLoaded = false;
    }
    
    /**
     * Load instrument masters and build symbol map
     * @param {Array<string>} exchangeSegmentCodes - Exchange segment codes to load
     */
    async loadSymbolMap(exchangeSegmentCodes = ['NSEFO']) {
        if (this.symbolMapLoaded) {
            console.log('Symbol map already loaded');
            return;
        }
        
        console.log('Loading instrument masters and building symbol map...');
        
        // Load all instruments and store them
        this.instruments = [];
        for (const segmentCode of exchangeSegmentCodes) {
            try {
                const instruments = await this.masterManager.loadMaster(segmentCode);
                this.instruments.push(...instruments);
            } catch (error) {
                console.error(`Failed to load instruments for segment ${segmentCode}:`, error.message);
            }
        }
        
        this.symbolMap = await this.masterManager.buildSymbolMap(exchangeSegmentCodes);
        this.symbolMapLoaded = true;
        console.log(`Symbol map loaded with ${Object.keys(this.symbolMap).length} symbols`);
    }

    /**
     * Select OTM option for a given underlying and action
     * @param {string} underlying - Underlying symbol
     * @param {string} action - Action (BUY/SELL)
     * @param {number} underlyingPrice - Current underlying price (optional)
     * @returns {Object|null} Selected option with tradingSymbol and instrument details
     */
    selectOTMOption(underlying, action, underlyingPrice = null) {
        if (this.instruments.length === 0) {
            console.warn('No instruments loaded - cannot select option');
            return null;
        }

        const selectedOption = this.masterManager.selectOTMOption(
            this.instruments,
            underlying,
            action,
            underlyingPrice
        );

        if (selectedOption) {
            return {
                tradingSymbol: selectedOption.tradingSymbol,
                exchangeSegment: selectedOption.exchangeSegment,
                exchangeInstrumentID: selectedOption.exchangeInstrumentID
            };
        }

        return null;
    }
    
    /**
     * Resolve symbol to XTS instrument (exchangeSegment and exchangeInstrumentID)
     * @param {string} symbol - Symbol name or 'segment_instrumentId' format
     * @returns {Object} { exchangeSegment, exchangeInstrumentID }
     */
    resolveInstrument(symbol) {
        // If symbol is already in 'segment_instrumentId' format
        if (symbol && symbol.includes('_')) {
            const [exchangeSegment, exchangeInstrumentID] = symbol.split('_');

            return {
                exchangeSegment: Number(exchangeSegment) || exchangeSegment,
                exchangeInstrumentID: Number(exchangeInstrumentID) || exchangeInstrumentID
            };
        }
        
        // Default to NIFTY if symbol is not provided or empty
        const targetSymbol = (symbol || 'NIFTY').toUpperCase().trim();
        
        // Check if symbol exists in our mapping
        if (this.symbolMap[targetSymbol]) {
            const result = this.symbolMap[targetSymbol];
            console.log(`Resolved symbol '${symbol}' to exchangeSegment ${result.exchangeSegment} and exchangeInstrumentID ${result.exchangeInstrumentID}`);
            return result;
        }
        
        // Fallback: try to use as instrument ID with default segment (1 = NSE)
        console.warn(`Symbol '${targetSymbol}' not found in mapping, using as instrument ID with segment 1`);
        return {
            exchangeSegment: 1,
            exchangeInstrumentID: Number(targetSymbol) || targetSymbol
        };
    }

    async login() {
        console.log('Logging in to XTS Interactive...');
        const response = await this.client.post('/auth/login', {
            appKey: this.config.appKey,
            secretKey: this.config.secretKey
        });

        const data = Array.isArray(response.data) ? response.data[0] : response.data;
        this.token = data?.result?.token;
        this.userID = data?.result?.userID;

        if (!this.token) throw new Error('Interactive Login failed');
        // Set both authorization and token headers as required by XTS API
        this.client.defaults.headers.common['authorization'] = this.token;
        this.client.defaults.headers.common['token'] = this.token;
        console.log('Set authorization header (raw):', this.client.defaults.headers.common['authorization'] ? 'Header set' : 'Header NOT set');
        console.log('Set token header:', this.client.defaults.headers.common['token'] ? 'Header set' : 'Header NOT set');
        console.log('Interactive Login successful');
    }

    async placeOrder(orderDetails) {
        console.log('=== XTSOrderExecutor.placeOrder() CALLED ===');
        console.log('Input orderDetails:', JSON.stringify(orderDetails, null, 2));
        
        if (!this.token) {
            console.log('Token not available, logging in first...');
            await this.login();
        } else {
            console.log('Token already available (length:', this.token.length + ')');
        }

        console.log('Resolving instrument for symbol:', orderDetails.symbol);
        const { exchangeSegment, exchangeInstrumentID } = this.resolveInstrument(orderDetails.symbol);
        console.log('Resolved instrument:', { exchangeSegment, exchangeInstrumentID });

        const payload = {
            exchangeSegment: Number(exchangeSegment) || exchangeSegment,
            exchangeInstrumentID: Number(exchangeInstrumentID) || exchangeInstrumentID,
            productType: orderDetails.productType || 'MIS',
            orderType: orderDetails.orderType || 'LIMIT',
            orderSide: orderDetails.action,
            orderQuantity: orderDetails.quantity,
            disclosedQuantity: 0,
            validity: 'DAY',
            orderValue: 0,
            isStopLossOrder: orderDetails.orderType === 'COVER',
            stopLossPrice: orderDetails.stopLossPrice || 0,
            limitPrice: orderDetails.limitPrice || 0,
            isVTDOrder: false,
            vtdMarketProtectionPercentage: 0,
            isIOCOrder: false,
            clientOrderID: `OMS_${Date.now()}`
        };

        console.log('=== ORDER PAYLOAD READY TO SEND TO XTS API ===');
        console.log(JSON.stringify(payload, null, 2));
        console.log('==============================================');

        try {
            console.log(`Placing ${orderDetails.orderType || 'LIMIT'} order: ${orderDetails.action} ${orderDetails.quantity} for ${orderDetails.symbol} (instrument: ${exchangeSegment}_${exchangeInstrumentID})`);
            console.log('Sending POST request to:', this.config.baseUrl + '/interactive/orders');
            
            const response = await this.client.post('/interactive/orders', payload);
            
            console.log('=== XTS API RESPONSE RECEIVED ===');
            console.log('Response status:', response.status);
            console.log('Response data:', JSON.stringify(response.data, null, 2));
            console.log('=================================');
            
            return response.data;
        } catch (error) {
            console.error('=== XTS API ORDER PLACEMENT FAILED ===');
            console.error('Error message:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response statusText:', error.response.statusText);
                console.error('Response data:', JSON.stringify(error.response.data, null, 2));
                console.error('Response headers:', JSON.stringify(error.response.headers, null, 2));
            }
            console.error('======================================');
            throw error;
        }
    }

    /**
     * @deprecated Use placeOrder() instead
     */
    async placeMarketOrder(orderDetails) {
        return this.placeOrder({ ...orderDetails, orderType: 'MARKET' });
    }

    async getOrderStatus(orderId) {
        if (!this.token) await this.login();
        const response = await this.client.get(`/interactive/orders/${orderId}`);
        return response.data;
    }

    async getPositions() {
        if (!this.token) await this.login();
        console.log('Fetching positions from XTS...');
        const response = await this.client.get('/portfolio/positions');
        return response.data;
    }

    async squareOffPosition(details) {
        console.log('=== XTSOrderExecutor.squareOffPosition() CALLED ===');
        console.log('Input details:', JSON.stringify(details, null, 2));
        
        if (!this.token) {
            console.log('Token not available, logging in first...');
            await this.login();
        } else {
            console.log('Token already available (length:', this.token.length + ')');
        }

        console.log('Resolving instrument for symbol:', details.symbol);
        const { exchangeSegment, exchangeInstrumentID } = this.resolveInstrument(details.symbol);
        console.log('Resolved instrument:', { exchangeSegment, exchangeInstrumentID });

        const payload = {
            exchangeSegment: Number(exchangeSegment) || exchangeSegment,
            exchangeInstrumentID: Number(exchangeInstrumentID) || exchangeInstrumentID,
            productType: 'MIS',
            squareOffMode: 'Full',
            orderQuantity: details.quantity
        };

        console.log('=== SQUARE-OFF PAYLOAD READY TO SEND TO XTS API ===');
        console.log(JSON.stringify(payload, null, 2));
        console.log('================================================');

        try {
            console.log(`Squaring off position: ${details.symbol} (${details.quantity}) for instrument ${exchangeSegment}_${exchangeInstrumentID}`);
            console.log('Sending POST request to:', this.config.baseUrl + '/interactive/positions/squareoff');
            
            const response = await this.client.post('/interactive/positions/squareoff', payload);
            
            console.log('=== XTS API SQUARE-OFF RESPONSE RECEIVED ===');
            console.log('Response status:', response.status);
            console.log('Response data:', JSON.stringify(response.data, null, 2));
            console.log('=========================================');
            
            return response.data;
        } catch (error) {
            console.error('=== XTS API SQUARE-OFF FAILED ===');
            console.error('Error message:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response statusText:', error.response.statusText);
                console.error('Response data:', JSON.stringify(error.response.data, null, 2));
            }
            console.error('=================================');
            throw error;
        }
    }
}

module.exports = XTSOrderExecutor;
