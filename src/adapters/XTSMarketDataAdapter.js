const MarketDataProvider = require('../interfaces/MarketDataProvider');
const ioClient = require('socket.io-client');
const WebSocket = require('ws');
const axios = require('axios');
const https = require('https');
const EventEmitter = require('events');

const TAG = '[MarketData]';

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
        this.client = axios.create({
            baseURL: config.baseUrl,
            headers: { 'Content-Type': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
    }

    async login() {
        if (this.config.baseUrl.startsWith('ws://') || this.config.baseUrl.startsWith('wss://')) {
            return; // raw WebSocket — no login needed
        }

        console.log(`${TAG} Logging in...`);
        try {
            const response = await this.client.post('/auth/login', {
                appKey: this.config.appKey,
                secretKey: this.config.secretKey
            });

            const data = Array.isArray(response.data) ? response.data[0] : response.data;
            this.token = data?.result?.token;
            this.userID = data?.result?.userID;

            if (!this.token) throw new Error('Login failed: Token not received');
            this.client.defaults.headers.common['authorization'] = this.token;
            this.client.defaults.headers.common['token'] = this.token;
            console.log(`${TAG} Login successful (userID: ${this.userID})`);
        } catch (error) {
            console.error(`${TAG} Login failed:`, error.response?.data?.description || error.message);
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

        console.log(`${TAG} Connecting to Socket.io at ${baseUrl}${socketPath}`);
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
        console.log(`${TAG} Connecting to raw WebSocket at ${this.config.baseUrl}`);
        this.socket = new WebSocket(this.config.baseUrl);

        this.socket.on('open', () => console.log(`${TAG} WebSocket connected`));
        this.socket.on('message', (data) => {
            try {
                this.handleMarketData(JSON.parse(data.toString()));
            } catch (_) {
                // Ignore non-JSON frames
            }
        });
        this.socket.on('error', (err) => console.error(`${TAG} WebSocket error:`, err.message));
        this.socket.on('close', () => console.log(`${TAG} WebSocket closed`));
    }

    setupSocketIOEvents() {
        this.socket.on('connect', () => {
            console.log(`${TAG} Socket.io connected`);
            this.events.emit('connected');
        });

        this.socket.on('disconnect', (reason) => {
            console.log(`${TAG} Socket.io disconnected:`, reason);
            this.events.emit('disconnected', reason);
        });

        // Handle both known event names (server-side typo 'fkull' vs 'full')
        const onTick = (data) => {
            try {
                this.handleMarketData(typeof data === 'string' ? JSON.parse(data) : data);
            } catch (error) {
                console.error(`${TAG} Failed to parse tick:`, error.message);
            }
        };
        this.socket.on('1502-json-full', onTick);
        this.socket.on('1502-json-fkull', onTick);

        this.socket.on('error', (err) => {
            console.error(`${TAG} Socket.io error:`, err);
            this.events.emit('error', err);
        });
    }

    handleMarketData(parsed) {
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
            console.warn(`${TAG} Tick missing price for ${symbol}`);
        }
    }

    /**
     * Subscribe to instruments for real-time market data.
     * @param {Array<{exchangeSegment: number, exchangeInstrumentID: number}>} instruments
     */
    async subscribeInstruments(instruments) {
        if (!this.token) await this.login();

        const normalizedInstruments = instruments.map(instr => ({
            exchangeSegment: Number(instr.exchangeSegment),
            exchangeInstrumentID: Number(instr.exchangeInstrumentID)
        }));

        normalizedInstruments
            .map(i => `${i.exchangeSegment}_${i.exchangeInstrumentID}`)
            .forEach(key => this.subscribedInstruments.add(key));

        try {
            const response = await this.client.post('/instruments/subscription', {
                instruments: normalizedInstruments,
                xtsMessageCode: 1502
            });
            const keys = normalizedInstruments.map(i => `${i.exchangeSegment}_${i.exchangeInstrumentID}`).join(', ');
            console.log(`${TAG} Subscribed: [${keys}]`);
            return response.data;
        } catch (error) {
            // Token expired — re-login once and retry
            if (error.response?.data?.code === 'e-session-0007' ||
                error.response?.data?.description === 'Invalid Token') {
                console.warn(`${TAG} Token expired, re-logging in...`);
                this.token = null;
                await this.login();
                const retryResponse = await this.client.post('/instruments/subscription', {
                    instruments: normalizedInstruments,
                    xtsMessageCode: 1502
                });
                console.log(`${TAG} Subscribed after re-login`);
                return retryResponse.data;
            }

            console.error(`${TAG} Subscription failed:`, error.response?.data?.description || error.message);
            if (error.response?.data?.result?.errors) {
                console.error(`${TAG} Errors:`, error.response.data.result.errors);
            }
            throw error;
        }
    }

    /**
     * Subscribe to a single symbol string (format: "segment_instrumentId").
     */
    async subscribe(symbol) {
        const [exchangeSegment, exchangeInstrumentID] = symbol.split('_');
        return this.subscribeInstruments([{
            exchangeSegment: Number(exchangeSegment),
            exchangeInstrumentID: Number(exchangeInstrumentID)
        }]);
    }

    /**
     * Unsubscribe from instruments.
     * @param {Array<{exchangeSegment: number, exchangeInstrumentID: number}>} instruments
     */
    async unsubscribeInstruments(instruments) {
        if (!this.token) await this.login();

        instruments
            .map(i => `${i.exchangeSegment}_${i.exchangeInstrumentID}`)
            .forEach(key => this.subscribedInstruments.delete(key));

        try {
            const response = await this.client.put('/instruments/subscription', {
                instruments,
                xtsMessageCode: 1502
            });
            console.log(`${TAG} Unsubscribed ${instruments.length} instrument(s)`);
            return response.data;
        } catch (error) {
            console.error(`${TAG} Unsubscribe failed:`, error.response?.data?.description || error.message);
            throw error;
        }
    }

    getLastPrice(symbol) {
        const targetSymbol = symbol || this.lastSymbol;
        if (targetSymbol) {
            const direct = this.lastPrices.get(targetSymbol);
            if (Number.isFinite(direct) && direct > 0) return direct;
            if (symbol) return null; // Specific symbol not found — don't bleed another symbol's price
        }
        if (this.lastPrices.size > 0) {
            for (const v of this.lastPrices.values()) {
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }
        return null;
    }

    /**
     * Fetch quotes for instruments via HTTP REST (POST /instruments/quotes).
     * @param {Array<{exchangeSegment: number, exchangeInstrumentID: number}>} instruments
     */
    async getQuotes(instruments) {
    if (!this.token) await this.login();
    const normalizedInstruments = instruments.map(instr => ({
        exchangeSegment: Number(instr.exchangeSegment),
        exchangeInstrumentID: Number(instr.exchangeInstrumentID)
    }));

    const payload = {
        instruments: normalizedInstruments,
        xtsMessageCode: 1502,
        publishFormat: 'JSON'
    };

    try {
        const response = await this.client.post('/instruments/quotes', payload);
        return response.data;

    } catch (error) {

        const invalidToken =
            error.response?.data?.code === 'e-session-0007' ||
            error.response?.data?.description === 'Invalid Token';

        if (invalidToken) {
            console.warn(`${TAG} Token expired during getQuotes(), re-logging in...`);

            this.token = null;

            await this.login();

            const retryResponse = await this.client.post(
                '/instruments/quotes',
                payload
            );

            return retryResponse.data;
        }

        console.error(
            `${TAG} getQuotes failed:`,
            error.response?.data?.description || error.message
        );

        throw error;
    }
}    
    // async getQuotes(instruments) {
    //     if (!this.token) await this.login();

    //     const normalizedInstruments = instruments.map(instr => ({
    //         exchangeSegment: Number(instr.exchangeSegment),
    //         exchangeInstrumentID: Number(instr.exchangeInstrumentID)
    //     }));

    //     try {
    //         const response = await this.client.post('/instruments/quotes', {
    //             instruments: normalizedInstruments,
    //             xtsMessageCode: 1512,
    //             publishFormat: 'JSON'
    //         });
    //         return response.data;
    //     } catch (error) {
    //         console.error(`${TAG} getQuotes failed:`, error.response?.data?.description || error.message);
    //         throw error;
    //     }
    // }


    /**
     * Fetch LTP for a symbol via HTTP REST when no WebSocket tick exists yet.
     * Caches the result in lastPrices.
     * @param {string} symbol - Format: "segment_instrumentId" (e.g. "1_26000")
     * @returns {Promise<number|null>}
     */
    async fetchLTP(symbol) {

    if (!symbol) return null;

    // Dummy WebSocket mode
    const isDummy =
        this.config.baseUrl &&
        (
            this.config.baseUrl.startsWith('ws://') ||
            this.config.baseUrl.startsWith('wss://')
        );

    if (isDummy) {
        return this.getLastPrice(symbol);
    }

    // Return cached price first if available
    const cached = this.getLastPrice(symbol);
    if (cached !== null) {
        return cached;
    }

    const [exchangeSegment, exchangeInstrumentID] = symbol.split('_');

    if (!exchangeSegment || !exchangeInstrumentID) {
        console.warn(`${TAG} fetchLTP: invalid symbol format "${symbol}"`);
        return null;
    }

    try {

        console.log(`${TAG} Fetching LTP via HTTP for ${symbol}`);

        const response = await this.getQuotes([
            {
                exchangeSegment: Number(exchangeSegment),
                exchangeInstrumentID: Number(exchangeInstrumentID)
            }
        ]);

        // console.log(
        //     `${TAG} QUOTES RESPONSE:`,
        //     JSON.stringify(response.data || response, null, 2)
        // );

        const result = response?.result || response?.data?.result || {};
        const listQuotes = result?.listQuotes || [];

        if (!Array.isArray(listQuotes) || listQuotes.length === 0) {
            console.warn(`${TAG} fetchLTP: empty listQuotes for ${symbol}`);
            return null;
        }

        for (const quoteItem of listQuotes) {

            let q = quoteItem;

            // Some XTS brokers return quote as JSON string
            if (typeof q === 'string') {
                try {
                    q = JSON.parse(q);
                } catch (e) {
                    console.warn(`${TAG} Failed to parse quote string`);
                    continue;
                }
            }

            // console.log(
            //     `${TAG} PARSED QUOTE:`,
            //     JSON.stringify(q, null, 2)
            // );

            const price =
                q?.Touchline?.LastTradedPrice ??
                q?.LastTradedPrice ??
                q?.LastPrice ??
                q?.LTP ??
                q?.ltp ??
                q?.Close ??
                q?.close;

            const numPrice = Number(price);

            if (Number.isFinite(numPrice) && numPrice > 0) {

                this.lastPrices.set(symbol, numPrice);
                this.lastSymbol = symbol;

                console.log(`${TAG} LTP for ${symbol}: ${numPrice}`);

                return numPrice;
            }
        }

        console.warn(
            `${TAG} fetchLTP: no valid price in response for ${symbol}`
        );

        return null;

    } catch (error) {

        console.error(
            `${TAG} fetchLTP failed for ${symbol}:`,
            error.response?.data || error.message
        );

        return null;
    }
    }
    
    // async fetchLTP(symbol) {
    //     if (!symbol) return null;

    //     // Dummy WebSocket mode — no REST endpoint available
    //     const isDummy = this.config.baseUrl && (this.config.baseUrl.startsWith('ws://') || this.config.baseUrl.startsWith('wss://'));
    //     if (isDummy) return this.getLastPrice(symbol);

    //     const [exchangeSegment, exchangeInstrumentID] = symbol.split('_');
    //     if (!exchangeSegment || !exchangeInstrumentID) {
    //         console.warn(`${TAG} fetchLTP: invalid symbol format "${symbol}"`);
    //         return null;
    //     }

    //     try {
    //         console.log(`${TAG} Fetching LTP via HTTP for ${symbol}`);
    //         const response = await this.getQuotes([{
    //             exchangeSegment: Number(exchangeSegment),
    //             exchangeInstrumentID: Number(exchangeInstrumentID)
    //         }]);

    //         const listQuotes = response?.result?.listQuotes || [];
    //         for (const quoteStr of listQuotes) {
    //             const q = typeof quoteStr === 'string' ? (() => { try { return JSON.parse(quoteStr); } catch { return null; } })() : quoteStr;
    //             if (!q) continue;
    //             // const price = q.LastTradedPrice ?? q.LTP ?? q.LastPrice;
    //             const price = q.Touchline?.LastTradedPrice ?? q.LastTradedPrice ?? q.LTP ?? q.LastPrice;
    //             const numPrice = Number(price);
    //             if (Number.isFinite(numPrice) && numPrice > 0) {
    //                 this.lastPrices.set(symbol, numPrice);
    //                 this.lastSymbol = symbol;
    //                 console.log(`${TAG} LTP for ${symbol}: ${numPrice}`);
    //                 return numPrice;
    //             }
    //         }

    //         console.warn(`${TAG} fetchLTP: no valid price in response for ${symbol}`);
    //         return null;
    //     } catch (error) {
    //         console.error(`${TAG} fetchLTP failed for ${symbol}:`, error.message);
    //         return null;
    //     }
    // }

    getActiveSymbol() {
        return this.lastSymbol;
    }

    on(event, callback) {
        this.events.on(event, callback);
    }
}

module.exports = XTSMarketDataAdapter;
