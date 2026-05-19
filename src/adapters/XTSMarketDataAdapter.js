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
    }

    async login() {
        if (this.config.baseUrl.startsWith('ws://') || this.config.baseUrl.startsWith('wss://')) {
            console.log('Skipping login for raw WebSocket dummy data');
            return;
        }
        
        console.log('Logging in to XTS Market Data...');
        try {
            const response = await axios.post(`${this.config.baseUrl}/auth/login`, {
                appKey: this.config.appKey,
                secretKey: this.config.secretKey
            }, {
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            });

            const data = Array.isArray(response.data) ? response.data[0] : response.data;
            this.token = data?.result?.token;
            this.userID = data?.result?.userID;
            
            if (!this.token) throw new Error('Login failed: Token not received');
            console.log('Login successful');
        } catch (error) {
            console.warn('Market Data Login failed, may proceed if using dummy data:', error.message);
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
        });

        this.socket.on('1502-json-fkull', (data) => {
            try {
                const parsed = JSON.parse(data);
                this.handleMarketData(parsed);
            } catch (error) {
                console.error('Failed to parse Socket.io message:', error.message);
            }
        });

        this.socket.on('error', (err) => console.error('Socket.io Error:', err));
    }

    handleMarketData(parsed) {
        // console.debug('Market data received:', JSON.stringify(parsed));
        // Handle XTS format: parsed.Touchline.LastTradedPrice
        // or a flatter dummy format: parsed.LastTradedPrice
        const isDummy = this.config.baseUrl.startsWith('ws://') || this.config.baseUrl.startsWith('wss://');
        const symbol = isDummy ? 'GOLD26' : (parsed.symbol || (parsed.ExchangeSegment && parsed.ExchangeInstrumentID ? `${parsed.ExchangeSegment}_${parsed.ExchangeInstrumentID}` : 'GOLD26'));
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

    subscribe(symbol) {
        // symbol format: "segment_instrumentId"
        const [segment, instrumentId] = symbol.split('_');
        if (this.socket && this.socket.connected) {
            console.log(`Subscribing to ${symbol}`);
            // XTS subscription logic via REST usually, but socket can also receive if already subscribed
            // Here we assume the core will handle subscription via REST or we add it here
        }
    }

    getLastPrice(symbol) {
        const targetSymbol = symbol || this.lastSymbol;
        return targetSymbol ? this.lastPrices.get(targetSymbol) : null;
    }

    getActiveSymbol() {
        return this.lastSymbol;
    }

    on(event, callback) {
        this.events.on(event, callback);
    }
}

module.exports = XTSMarketDataAdapter;
