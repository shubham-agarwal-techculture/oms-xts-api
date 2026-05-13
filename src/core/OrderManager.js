class OrderManager {
    /**
     * @param {Object} options
     * @param {import('../interfaces/MarketDataProvider')} options.marketData
     * @param {import('../interfaces/SignalSource')} options.signalSource
     * @param {import('../interfaces/OrderExecutor')} options.orderExecutor
     */
    constructor({ marketData, signalSource, orderExecutor }) {
        this.marketData = marketData;
        this.signalSource = signalSource;
        this.orderExecutor = orderExecutor;
        this.orders = [];
    }

    init() {
        console.log('Initializing Order Manager...');
        
        // Listen for signals
        this.signalSource.on('signal', async (signal) => {
            await this.handleSignal(signal);
        });

        // Listen for price updates (logging/tracking)
        this.marketData.on('priceUpdate', ({ symbol, price }) => {
            // Optional: Log price if needed
            // console.log(`Price Update: ${symbol} @ ${price}`);
        });
    }

    async handleSignal(signal) {
        const { symbol, action, quantity } = signal;
        
        // Get last price from market data adapter
        const currentPrice = this.marketData.getLastPrice(symbol);
        console.log(`Processing signal: ${action} ${quantity} ${symbol}. Last Price: ${currentPrice || 'N/A'}`);

        try {
            const result = await this.orderExecutor.placeMarketOrder({
                symbol,
                action,
                quantity
            });

            console.log(`Order Placed Successfully:`, JSON.stringify(result));
            
            this.orders.push({
                signal,
                result,
                timestamp: Date.now(),
                status: 'PLACED'
            });
        } catch (error) {
            console.error(`Order Placement Failed for ${symbol}:`, error.message);
            this.orders.push({
                signal,
                error: error.message,
                timestamp: Date.now(),
                status: 'FAILED'
            });
        }
    }
}

module.exports = OrderManager;
