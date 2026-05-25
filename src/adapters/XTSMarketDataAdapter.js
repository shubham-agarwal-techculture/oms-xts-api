const MarketDataProvider = require('../interfaces/MarketDataProvider');
const ioClient = require('socket.io-client');
const WebSocket = require('ws');
const axios = require('axios');
const https = require('https');
const EventEmitter = require('events');

class XTSMarketDataAdapter extends MarketDataProvider {
    constructor(config) {
        super();
        this.config = config;
        this.socket = null;
        this.token = null;
        this.userID = null;
        this.lastPrices = new Map();
        this.lastSymbol = null;
        this.events = new EventEmitter();
        this.subscribedInstruments = new Set();
        // Create axios client for REST API calls
        this.client = axios.create({
            baseURL: config.baseUrl,
            headers: { 'Content-Type': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        // Add request interceptor to log outgoing requests
        this.client.interceptors.request.use(request => {
            console.log('Outgoing Request:', {
                method: request.method?.toUpperCase(),
                url: request.baseURL + request.url,
                headers: request.headers
            });
            return request;
        }, error => {
            console.error('Request Error:', error);
            return Promise.reject(error);
        });

        // Add response interceptor to log incoming responses
        this.client.interceptors.response.use(response => {
            console.log('Incoming Response:', {
                status: response.status,
                statusText: response.statusText,
                data: response.data
            });
            return response;
        }, error => {
            console.error('Response Error:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data
            });
            return Promise.reject(error);
        });
    }

    async login() {
        if (this.config.baseUrl.startsWith('ws://') || this.config.baseUrl.startsWith('wss://')) {
            console.log('Skipping login for raw WebSocket dummy data');
            return;
        }
        
        console.log('Logging in to XTS Market Data...');
        try {
            const response = await this.client.post('/auth/login', {
                appKey: this.config.appKey,
                secretKey: this.config.secretKey
            });

            console.log('Login response data:', JSON.stringify(response.data));
            const data = Array.isArray(response.data) ? response.data[0] : response.data;
            console.log('Parsed login data:', JSON.stringify(data));
            this.token = data?.result?.token;
            this.userID = data?.result?.userID;
            
            console.log('Extracted token:', this.token ? 'Token received (length: ' + this.token.length + ')' : 'No token');
            console.log('Extracted userID:', this.userID);
            
            if (!this.token) throw new Error('Login failed: Token not received');
            // Set both authorization and token headers as required by XTS API
            this.client.defaults.headers.common['authorization'] = this.token;
            this.client.defaults.headers.common['token'] = this.token;
            console.log('Set authorization header (raw):', this.client.defaults.headers.common['authorization'] ? 'Header set' : 'Header NOT set');
            console.log('Set token header:', this.client.defaults.headers.common['token'] ? 'Header set' : 'Header NOT set');
            console.log('Market Data login successful');
        } catch (error) {
            console.error('Market Data Login failed:', error.response?.data || error.message);
            if (error.response) {
                console.error('Login error response status:', error.response.status);
                console.error('Login error response headers:', JSON.stringify(error.response.headers));
            }
            throw error;
        }
    }

    async connect() {
        await this.login();

        if (this.config.baseUrl.startsWith('ws://') || this.config.baseUrl.startsWith('wss://')) {
            this.connectRawWebSocket();
            return;
        }

        const url = new URL(this.config.baseUrl);
        const baseUrl = url.origin;
        const socketPath = url.pathname === '/' ? '/socket.io' : `${url.pathname}/socket.io`;

        console.log(`Connecting to XTS Socket.io at ${baseUrl} with path ${socketPath}`);
        this.socket = ioClient(baseUrl, {
            path: socketPath,
            query: {
                token: this.token,
                userID: this.userID,
                publishFormat: 'JSON',
                broadcastMode: 'Full',
                apiType: 'MARKETDATA',
                source: 'WebAPI'
            },
            transports: ['websocket'],
            reconnection: true
        });

        this.setupSocketIOEvents();
    }

    connectRawWebSocket() {
        console.log(`Connecting to raw WebSocket at ${this.config.baseUrl}`);
        this.socket = new WebSocket(this.config.baseUrl);

        this.socket.on('open', () => {
            console.log('Raw Market Data WebSocket connected');
        });

        this.socket.on('message', (data) => {
            try {
                const message = data.toString();
                // Check if it's JSON or other format. Assuming JSON for dummy.
                const parsed = JSON.parse(message);
                this.handleMarketData(parsed);
            } catch (error) {
                // Ignore non-JSON messages or handle accordingly
            }
        });

        this.socket.on('error', (err) => console.error('Raw WebSocket Error:', err));
        this.socket.on('close', () => console.log('Raw WebSocket closed'));
    }

    setupSocketIOEvents() {
        this.socket.on('connect', () => {
            console.log('XTS Market Data (Socket.io) connected');
            this.events.emit('connected');
        });

        this.socket.on('disconnect', (reason) => {
            console.log('XTS Market Data (Socket.io) disconnected:', reason);
            this.events.emit('disconnected', reason);
        });

        // Try both possible event names (fixing possible typo 'fkull' → 'full')
        this.socket.on('1502-json-full', (data) => {
            try {
                const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                this.handleMarketData(parsed);
            } catch (error) {
                console.error('Failed to parse Socket.io message (1502-json-full):', error.message);
            }
        });

        this.socket.on('1502-json-fkull', (data) => {
            try {
                const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                this.handleMarketData(parsed);
            } catch (error) {
                console.error('Failed to parse Socket.io message (1502-json-fkull):', error.message);
            }
        });

        this.socket.on('error', (err) => {
            console.error('Socket.io Error:', err);
            this.events.emit('error', err);
        });
    }

    handleMarketData(parsed) {
        // console.debug('Market data received:', JSON.stringify(parsed));
        // Handle XTS format: parsed.Touchline.LastTradedPrice
        // or a flatter dummy format: parsed.LastTradedPrice
        const defaultSymbol = process.env.DEFAULT_SYMBOL || '1_22';
        const isDummy = this.config.baseUrl.startsWith('ws://') || this.config.baseUrl.startsWith('wss://');
        const symbol = isDummy
            ? defaultSymbol
            : (parsed.symbol || (parsed.ExchangeSegment && parsed.ExchangeInstrumentID
                ? `${parsed.ExchangeSegment}_${parsed.ExchangeInstrumentID}`
                : defaultSymbol));
        const price = parsed.price || parsed.Touchline?.LastTradedPrice || parsed.LastTradedPrice || parsed.close || parsed.last;
        
        if (price) {
            this.lastPrices.set(symbol, price);
            this.lastSymbol = symbol;
            this.events.emit('priceUpdate', { 
                symbol, 
                price, 
                timestamp: parsed.timestamp || parsed.ExchangeTransmitTime || Date.now() 
            });
        } else {
            console.warn('Market data missing price:', { symbol, price, parsed });
        }
    }

    /**
     * Subscribe to instruments for market data
     * @param {Array<{exchangeSegment: number, exchangeInstrumentID: number}>} instruments - Instruments to subscribe
     * @returns {Promise<Object>} API response
     */
    async subscribeInstruments(instruments) {
        if (!this.token) await this.login();
        
        // Ensure numeric values for exchangeSegment and exchangeInstrumentID
        const normalizedInstruments = instruments.map(instr => ({
            exchangeSegment: Number(instr.exchangeSegment),
            exchangeInstrumentID: Number(instr.exchangeInstrumentID)
        }));
        
        const instrumentKeys = normalizedInstruments.map(instr => `${instr.exchangeSegment}_${instr.exchangeInstrumentID}`);
        instrumentKeys.forEach(key => this.subscribedInstruments.add(key));
        
        console.log(`Subscribing to ${normalizedInstruments.length} instruments...`);
        console.log('Current token:', this.token ? 'Token exists (length: ' + this.token.length + ')' : 'No token');
        console.log('Authorization header in client:', this.client.defaults.headers.common['authorization'] ? 'Header present' : 'Header NOT present');
        console.log('Subscription payload:', JSON.stringify({
            instruments: normalizedInstruments,
            xtsMessageCode: 1502
        }));
        
        try {
            const response = await this.client.post('/instruments/subscription', {
                instruments: normalizedInstruments,
                xtsMessageCode: 1502 // 1502 = Market Data Touchline
                // xtsMessageCode: 1501// 1501 = Market Data Touchline

            });
            
            console.log('Subscription response:', JSON.stringify(response.data));
            console.log('Subscription successful');
            return response.data;
        } catch (error) {
            // If token is invalid, try to re-login once
            if (error.response?.data?.code === 'e-session-0007' || 
                error.response?.data?.description === 'Invalid Token') {
                console.warn('Token invalid, attempting to re-login...');
                this.token = null;
                await this.login();
                // Retry the subscription once
                console.log('Retrying subscription after re-login...');
                const retryResponse = await this.client.post('/instruments/subscription', {
                    instruments: normalizedInstruments,
                    xtsMessageCode: 1502
                    // xtsMessageCode: 1501// 1501 = Market Data Touchline
                });
                console.log('Retry subscription response:', JSON.stringify(retryResponse.data));
                console.log('Retry subscription successful');
                return retryResponse.data;
            }
            
            console.error('Failed to subscribe:', error.response?.data || error.message);
            if (error.response?.data?.result?.errors) {
                console.error('Detailed errors:', JSON.stringify(error.response.data.result.errors, null, 2));
            }
            if (error.response) {
                console.error('Subscription error response status:', error.response.status);
                console.error('Subscription error response headers:', JSON.stringify(error.response.headers));
            }
            throw error;
        }
    }

    /**
     * Subscribe to a single symbol (format: "segment_instrumentId")
     * @param {string} symbol - Symbol to subscribe
     */
    async subscribe(symbol) {
        const [exchangeSegment, exchangeInstrumentID] = symbol.split('_');
        const instruments = [{
            exchangeSegment: Number(exchangeSegment),
            exchangeInstrumentID: Number(exchangeInstrumentID)
        }];
        return this.subscribeInstruments(instruments);
    }

    /**
     * Unsubscribe from instruments
     * @param {Array<{exchangeSegment: number, exchangeInstrumentID: number}>} instruments - Instruments to unsubscribe
     * @returns {Promise<Object>} API response
     */
    async unsubscribeInstruments(instruments) {
        if (!this.token) await this.login();
        
        const instrumentKeys = instruments.map(instr => `${instr.exchangeSegment}_${instr.exchangeInstrumentID}`);
        instrumentKeys.forEach(key => this.subscribedInstruments.delete(key));
        
        console.log(`Unsubscribing from ${instruments.length} instruments...`);
        
        try {
            const response = await this.client.put('/instruments/subscription', {
                instruments,
                xtsMessageCode: 1502
                // xtsMessageCode: 1501// 1501 = Market Data Touchline
            });
            
            console.log('Unsubscription successful');
            return response.data;
        } catch (error) {
            console.error('Failed to unsubscribe:', error.response?.data || error.message);
            throw error;
        }
    }

    getLastPrice(symbol) {
        console.log("last price: ", this.lastPrices);
        const targetSymbol = symbol || this.lastSymbol;
        if (targetSymbol) {
            const direct = this.lastPrices.get(targetSymbol);
            if (Number.isFinite(direct) && direct > 0) return direct;
        }
        if (this.lastPrices.size > 0) {
            for (const v of this.lastPrices.values()) {
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }
        return null;
    }

    getActiveSymbol() {
        return this.lastSymbol;
    }

    on(event, callback) {
        this.events.on(event, callback);
    }
}

module.exports = XTSMarketDataAdapter;
