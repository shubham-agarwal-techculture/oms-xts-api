const EventEmitter = require('events');

class OrderManager extends EventEmitter {
    /**
     * @param {Object} options
     * @param {import('../interfaces/MarketDataProvider')} options.marketData
     * @param {import('../interfaces/SignalSource')} options.signalSource
     * @param {import('../interfaces/OrderExecutor')} options.orderExecutor
     */
    constructor({ marketData, signalSource, orderExecutor }) {
        super();
        this.marketData = marketData;
        this.signalSource = signalSource;
        this.orderExecutor = orderExecutor;
        this.orders = [];
        this.alerts = [];
        this.positions = new Map(); // symbol -> { qty, avgPrice, totalCost }
        this.historicalPositions = [];
    }

    init() {
        console.log('Initializing Order Manager...');
        
        // Listen for signals
        this.signalSource.on('signal', async (signal) => {
            this.alerts.push({ ...signal, timestamp: Date.now() });
            this.emit('alert', signal);
            await this.handleSignal(signal);
        });

        // Listen for price updates
        this.marketData.on('priceUpdate', ({ symbol, price }) => {
            this.emit('priceUpdate', { symbol, price });
        });
    }

    async handleSignal(signal) {
        const { symbol, action, quantity } = signal;
        
        const currentPrice = this.marketData.getLastPrice(symbol);
        console.log(`Processing signal: ${action} ${quantity} ${symbol}. Last Price: ${currentPrice || 'N/A'}`);

        try {
            const result = await this.orderExecutor.placeMarketOrder({
                symbol,
                action,
                quantity
            });

            console.log(`Order Placed Successfully:`, JSON.stringify(result));
            
            const orderEntry = {
                id: result?.result?.AppOrderID || `ORD_${Date.now()}`,
                signal,
                result,
                price: currentPrice || 0, // Using last known price as execution price for tracking
                timestamp: Date.now(),
                status: 'PLACED'
            };

            this.orders.push(orderEntry);
            this.updatePosition(symbol, action, quantity, orderEntry.price);
            this.emit('order', orderEntry);
            this.emit('positionUpdate', this.getPosition(symbol));

        } catch (error) {
            console.error(`Order Placement Failed for ${symbol}:`, error.message);
            const failedOrder = {
                signal,
                error: error.message,
                timestamp: Date.now(),
                status: 'FAILED'
            };
            this.orders.push(failedOrder);
            this.emit('order', failedOrder);
        }
    }

    updatePosition(symbol, action, quantity, price) {
        let pos = this.positions.get(symbol) || { qty: 0, avgPrice: 0, totalCost: 0 };
        const tradeQty = action === 'BUY' ? quantity : -quantity;
        
        const oldQty = pos.qty;
        const newQty = oldQty + tradeQty;

        if (newQty === 0) {
            // Position closed
            this.historicalPositions.push({
                symbol,
                entryPrice: pos.avgPrice,
                exitPrice: price,
                qty: Math.abs(oldQty),
                pnl: (price - pos.avgPrice) * oldQty,
                timestamp: Date.now()
            });
            this.positions.delete(symbol);
        } else {
            // Update position
            if ((oldQty >= 0 && tradeQty > 0) || (oldQty <= 0 && tradeQty < 0)) {
                // Adding to position
                const newTotalCost = pos.totalCost + (quantity * price);
                pos.avgPrice = newTotalCost / Math.abs(newQty);
                pos.totalCost = newTotalCost;
            } else {
                // Reducing position - avg price doesn't change for the remaining part in simple FIFO/Average logic
                // But for simplicity, we just adjust total cost
                pos.totalCost = pos.avgPrice * Math.abs(newQty);
            }
            pos.qty = newQty;
            this.positions.set(symbol, pos);
        }
    }

    getPosition(symbol) {
        return this.positions.get(symbol) || { qty: 0, avgPrice: 0 };
    }

    getAllPositions() {
        return Array.from(this.positions.entries()).map(([symbol, data]) => ({
            symbol,
            ...data
        }));
    }

    async squareOff(symbol) {
        const pos = this.positions.get(symbol);
        if (!pos || pos.qty === 0) return { error: 'No open position' };

        const action = pos.qty > 0 ? 'SELL' : 'BUY';
        const quantity = Math.abs(pos.qty);

        console.log(`Manual Square-off triggered for ${symbol}: ${action} ${quantity}`);
        return await this.handleSignal({ symbol, action, quantity, source: 'MANUAL_SQUAREOFF' });
    }

    getState() {
        return {
            orders: this.orders.slice(-50), // Last 50 orders
            alerts: this.alerts.slice(-50), // Last 50 alerts
            positions: this.getAllPositions(),
            historicalPositions: this.historicalPositions.slice(-50)
        };
    }
}

module.exports = OrderManager;

