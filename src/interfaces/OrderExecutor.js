/**
 * Interface for Order Executor.
 * Responsible for placing orders and emitting status updates.
 */
class OrderExecutor {
    constructor() {
        if (this.constructor === OrderExecutor) {
            throw new Error("Abstract class cannot be instantiated");
        }
    }

    /**
     * Place a market order.
     * @param {Object} orderDetails 
     * @param {string} orderDetails.symbol
     * @param {string} orderDetails.action (BUY/SELL)
     * @param {number} orderDetails.quantity
     * @returns {Promise<Object>} The result of order placement.
     */
    async placeMarketOrder(orderDetails) {
        throw new Error("Method 'placeMarketOrder()' must be implemented");
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
