/**
 * Interface for Market Data Provider.
 * Must emit 'priceUpdate' events with { symbol, price, timestamp }
 */
class MarketDataProvider {
    constructor() {
        if (this.constructor === MarketDataProvider) {
            throw new Error("Abstract class cannot be instantiated");
        }
    }

    /**
     * Subscribe to a symbol for real-time updates.
     * @param {string} symbol 
     */
    subscribe(symbol) {
        throw new Error("Method 'subscribe()' must be implemented");
    }

    /**
     * Unsubscribe from a symbol.
     * @param {string} symbol 
     */
    unsubscribe(symbol) {
        throw new Error("Method 'unsubscribe()' must be implemented");
    }

    /**
     * Get the last known price for a symbol.
     * @param {string} symbol 
     * @returns {number|null}
     */
    getLastPrice(symbol) {
        throw new Error("Method 'getLastPrice()' must be implemented");
    }
}

module.exports = MarketDataProvider;
