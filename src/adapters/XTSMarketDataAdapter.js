const MarketDataProvider = require('../interfaces/MarketDataProvider');
const ioClient = require('socket.io-client');
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
        this.events = new EventEmitter();
    }

    async login() {
        console.log('Logging in to XTS Market Data...');
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
    }

    async connect() {
        if (!this.token) await this.login();

        const url = new URL(this.config.baseUrl);
        const baseUrl = url.origin;
        const socketPath = url.pathname === '/' ? '/socket.io' : `${url.pathname}/socket.io`;

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

        this.socket.on('connect', () => {
            console.log('XTS Market Data connected');
        });

        this.socket.on('1502-json-full', (data) => {
            const parsed = JSON.parse(data);
            const symbol = `${parsed.ExchangeSegment}_${parsed.ExchangeInstrumentID}`;
            const price = parsed.Touchline?.LastTradedPrice || parsed.LastTradedPrice;
            
            if (price) {
                this.lastPrices.set(symbol, price);
                this.events.emit('priceUpdate', { symbol, price, timestamp: parsed.ExchangeTransmitTime });
            }
        });

        this.socket.on('error', (err) => console.error('Socket Error:', err));
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
        return this.lastPrices.get(symbol) || null;
    }

    on(event, callback) {
        this.events.on(event, callback);
    }
}

module.exports = XTSMarketDataAdapter;
