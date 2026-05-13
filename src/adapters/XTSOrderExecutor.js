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

    async placeMarketOrder(orderDetails) {
        if (!this.token) await this.login();

        const [exchangeSegment, exchangeInstrumentID] = orderDetails.symbol.split('_');

        const payload = {
            exchangeSegment: Number(exchangeSegment),
            exchangeInstrumentID: Number(exchangeInstrumentID),
            productType: 'MIS', // Default to MIS for market orders
            orderType: 'MARKET',
            orderSide: orderDetails.action,
            orderQuantity: orderDetails.quantity,
            disclosedQuantity: 0,
            validity: 'DAY',
            orderValue: 0,
            isStopLossOrder: false,
            stopLossPrice: 0,
            isVTDOrder: false,
            vtdMarketProtectionPercentage: 0,
            isIOCOrder: false,
            clientOrderID: `OMS_${Date.now()}`
        };

        try {
            console.log(`Placing order: ${orderDetails.action} ${orderDetails.quantity} for ${orderDetails.symbol}`);
            const response = await this.client.post('/orders', payload);
            return response.data;
        } catch (error) {
            console.error('Order placement failed:', error.response?.data || error.message);
            throw error;
        }
    }

    async getOrderStatus(orderId) {
        if (!this.token) await this.login();
        const response = await this.client.get(`/orders/${orderId}`);
        return response.data;
    }
}

module.exports = XTSOrderExecutor;
