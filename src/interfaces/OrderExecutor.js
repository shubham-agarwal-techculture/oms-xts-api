const EventEmitter = require('events');

/**
 * Interface for Order Executor.
 * Responsible for placing orders and emitting status updates.
 */
class OrderExecutor extends EventEmitter {
    constructor() {
        super();
        if (this.constructor === OrderExecutor) {
            throw new Error("Abstract class cannot be instantiated");
        }
    }

    /**
     * Place an order (market, limit, cover, etc.).
     * @param {Object} orderDetails 
     * @param {string} orderDetails.symbol
     * @param {string} orderDetails.action (BUY/SELL)
     * @param {number} orderDetails.quantity
     * @param {string} [orderDetails.orderType] (MARKET/LIMIT/COVER) - default: LIMIT
     * @param {number} [orderDetails.limitPrice] - required for LIMIT orders
     * @param {string} [orderDetails.productType] (MIS/NRML/CNC) - default: MIS
     * @param {string} [orderDetails.instrumentType] (EQUITY/OPTIONS/FUTURES/COMMODITY)
     * @returns {Promise<Object>} The result of order placement.
     */

    /**
     * Place an order (market, limit, cover, etc.).
     * @param {Object} orderDetails 
    async placeOrder(orderDetails) {
        throw new Error("Method 'placeOrder()' must be implemented");
    }

    /**
     * Connect to any necessary services (e.g., WebSocket). Must be called before any order actions.
     */
    async connect() {
        // Default no-op for adapters that do not need a persistent connection.
    }

    /**
     * @deprecated Use placeOrder() instead
     * Place a market order (backward compatibility).
     */
    async placeMarketOrder(orderDetails) {
        return this.placeOrder({ ...orderDetails, orderType: 'MARKET' });
    }

    /**
     * Get order status by ID.
     * @param {string} orderId 
     * @returns {Promise<Object>}
     */
    async getOrderStatus(orderId) {
        throw new Error("Method 'getOrderStatus()' must be implemented");
    }

    /**
     * Fetch all open positions.
     * @returns {Promise<Array>}
     */
    async getPositions() {
        throw new Error("Method 'getPositions()' must be implemented");
    }

    /**
     * Square off a specific position.
     * @param {Object} details
     * @param {string} details.symbol
     * @param {number} details.quantity
     * @returns {Promise<Object>}
     */
    async squareOffPosition(details) {
        throw new Error("Method 'squareOffPosition()' must be implemented");
    }
}

module.exports = OrderExecutor;
