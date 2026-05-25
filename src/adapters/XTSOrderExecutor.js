const OrderExecutor = require('../interfaces/OrderExecutor');
const InstrumentMasterManager = require('./InstrumentMasterManager');
const axios = require('axios');
const https = require('https');

const TAG = '[OrderExecutor]';

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

        this.masterManager = new InstrumentMasterManager(config.marketDataConfig || config);
        this.instruments = [];
        this.symbolMap = {
            'NIFTY':  { exchangeSegment: 1, exchangeInstrumentID: 22 },
            'NIFTY50': { exchangeSegment: 1, exchangeInstrumentID: 22 }
        };
        this.symbolMapLoaded = false;
    }

    /**
     * Load instrument masters and build the symbol map.
     * @param {string[]} exchangeSegmentCodes
     */
    async loadSymbolMap(exchangeSegmentCodes = ['NSEFO']) {
        if (this.symbolMapLoaded) {
            console.log(`${TAG} Symbol map already loaded`);
            return;
        }

        console.log(`${TAG} Loading instrument masters for: ${exchangeSegmentCodes.join(', ')}`);
        this.instruments = [];
        for (const segmentCode of exchangeSegmentCodes) {
            try {
                const instruments = await this.masterManager.loadMaster(segmentCode);
                this.instruments.push(...instruments);
            } catch (error) {
                console.error(`${TAG} Failed to load segment ${segmentCode}:`, error.message);
            }
        }

        this.symbolMap = await this.masterManager.buildSymbolMap(exchangeSegmentCodes);
        this.symbolMapLoaded = true;
        console.log(`${TAG} Symbol map ready — ${Object.keys(this.symbolMap).length} symbols, ${this.instruments.length} instruments`);
    }

    /**
     * Select ATM option contract for a given underlying and signal action.
     * @param {string} underlying
     * @param {string} action - 'BUY' | 'SELL'
     * @param {number|null} underlyingPrice
     * @returns {Object|null}
     */
    selectOTMOption(underlying, action, underlyingPrice = null) {
        if (this.instruments.length === 0) {
            console.warn(`${TAG} No instruments loaded — cannot select option`);
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
     * Resolve a symbol name (e.g. "WIPRO") or "segment_instrumentId" string
     * to the XTS instrument object.
     * @param {string} symbol
     * @returns {{ exchangeSegment: number, exchangeInstrumentID: number }}
     */
    resolveInstrument(symbol) {
        if (symbol && symbol.includes('_')) {
            const [seg, id] = symbol.split('_');
            return {
                exchangeSegment: Number(seg) || seg,
                exchangeInstrumentID: Number(id) || id
            };
        }

        const targetSymbol = (symbol || 'NIFTY').toUpperCase().trim();
        if (this.symbolMap[targetSymbol]) {
            const result = this.symbolMap[targetSymbol];
            console.log(`${TAG} Resolved "${symbol}" → seg=${result.exchangeSegment} id=${result.exchangeInstrumentID}`);
            return result;
        }

        console.warn(`${TAG} Symbol "${targetSymbol}" not found in map — falling back to segment 1`);
        return { exchangeSegment: 1, exchangeInstrumentID: Number(targetSymbol) || targetSymbol };
    }

    async login() {
        console.log(`${TAG} Logging in to XTS Interactive...`);
        try {
            const response = await this.client.post('/auth/login', {
                appKey: this.config.appKey,
                secretKey: this.config.secretKey
            });
            const data = Array.isArray(response.data) ? response.data[0] : response.data;
            this.token = data?.result?.token;
            this.userID = data?.result?.userID;

            if (!this.token) throw new Error('Interactive login failed: no token');
            this.client.defaults.headers.common['authorization'] = this.token;
            this.client.defaults.headers.common['token'] = this.token;
            console.log(`${TAG} Login successful (userID: ${this.userID})`);
        } catch (error) {
            console.error(`${TAG} Login failed:`, error.response?.data?.description || error.message);
            throw error;
        }
    }

    async placeOrder(orderDetails) {
        if (!this.token) await this.login();

        const { exchangeSegment, exchangeInstrumentID } = this.resolveInstrument(orderDetails.symbol);

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

        console.log(`${TAG} Placing ${payload.orderType} ${payload.orderSide} x${payload.orderQuantity} ${orderDetails.symbol} @ ${payload.limitPrice}`);

        try {
            const response = await this.client.post('/interactive/orders', payload);
            const appOrderID = response.data?.result?.AppOrderID;
            console.log(`${TAG} Order placed — AppOrderID: ${appOrderID}`);
            return response.data;
        } catch (error) {
            const errDetail = error.response?.data?.description || error.response?.data || error.message;
            console.error(`${TAG} Order placement failed for ${orderDetails.symbol}: ${errDetail}`);
            throw error;
        }
    }

    /** @deprecated Use placeOrder() instead */
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
        const response = await this.client.get('/portfolio/positions');
        return response.data;
    }

    async squareOffPosition(details) {
        if (!this.token) await this.login();

        const { exchangeSegment, exchangeInstrumentID } = this.resolveInstrument(details.symbol);

        const payload = {
            exchangeSegment: Number(exchangeSegment) || exchangeSegment,
            exchangeInstrumentID: Number(exchangeInstrumentID) || exchangeInstrumentID,
            productType: 'MIS',
            squareOffMode: 'Full',
            orderQuantity: details.quantity
        };

        console.log(`${TAG} Squaring off ${details.symbol} (qty: ${details.quantity})`);

        try {
            const response = await this.client.post('/interactive/positions/squareoff', payload);
            console.log(`${TAG} Square-off successful for ${details.symbol}`);
            return response.data;
        } catch (error) {
            const errDetail = error.response?.data?.description || error.response?.data || error.message;
            console.error(`${TAG} Square-off failed for ${details.symbol}: ${errDetail}`);
            throw error;
        }
    }
}

module.exports = XTSOrderExecutor;
