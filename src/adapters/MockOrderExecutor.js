const OrderExecutor = require('../interfaces/OrderExecutor');

/**
 * Logs orders locally without calling a broker API.
 * Use ORDER_EXECUTOR=mock for end-to-end verification.
 */
class MockOrderExecutor extends OrderExecutor {
    async placeOrder(orderDetails) {
        const result = {
            type: 'success',
            result: {
                AppOrderID: `MOCK_${Date.now()}`,
                ...orderDetails
            }
        };
        console.log('[MockOrderExecutor] placeOrder:', JSON.stringify(orderDetails));
        return result;
    }

    async getOrderStatus(orderId) {
        return { type: 'success', result: { AppOrderID: orderId, OrderStatus: 'Filled' } };
    }

    async getPositions() {
        return { type: 'success', result: { positionList: [] } };
    }

    async squareOffPosition(details) {
        console.log('[MockOrderExecutor] squareOffPosition:', JSON.stringify(details));
        return { type: 'success', result: { message: 'Mock square-off', ...details } };
    }
}

module.exports = MockOrderExecutor;
