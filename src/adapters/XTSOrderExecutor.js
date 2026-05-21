const OrderExecutor = require('../interfaces/OrderExecutor');
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
        this.client.defaults.headers.common['authorization'] = this.token;
        console.log('Interactive Login successful');
    }

    async placeOrder(orderDetails) {
        if (!this.token) await this.login();

        let exchangeSegment, exchangeInstrumentID;
        if (orderDetails.symbol.includes('_')) {
            [exchangeSegment, exchangeInstrumentID] = orderDetails.symbol.split('_');
        } else {
            exchangeSegment = 1;
            exchangeInstrumentID = orderDetails.symbol;
        }

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

        console.log(`Payload: ${JSON.stringify(payload)}`);

        try {
            console.log(`Placing ${orderDetails.orderType || 'LIMIT'} order: ${orderDetails.action} ${orderDetails.quantity} for ${orderDetails.symbol}`);
            const response = await this.client.post('/interactive/orders', payload);
            return response.data;
        } catch (error) {
            console.error('Order placement failed:', error.response?.data || error.message);
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
        if (!this.token) await this.login();
        let exchangeSegment, exchangeInstrumentID;
        if (details.symbol.includes('_')) {
            [exchangeSegment, exchangeInstrumentID] = details.symbol.split('_');
        } else {
            exchangeSegment = 1;
            exchangeInstrumentID = details.symbol;
        }

        const payload = {
            exchangeSegment: Number(exchangeSegment) || exchangeSegment,
            exchangeInstrumentID: Number(exchangeInstrumentID) || exchangeInstrumentID,
            productType: 'MIS',
            squareOffMode: 'Full',
            orderQuantity: details.quantity
        };

        console.log(`Squaring off position: ${details.symbol} (${details.quantity})`);
        const response = await this.client.post('/interactive/positions/squareoff', payload);
        return response.data;
    }
}

module.exports = XTSOrderExecutor;
