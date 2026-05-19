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
            // Resolve symbol if missing
            if (!signal.symbol && typeof this.marketData.getActiveSymbol === 'function') {
                signal.symbol = this.marketData.getActiveSymbol();
            }
            if (!signal.symbol) {
                signal.symbol = 'GOLD26';
            }
            console.log(`Resolved symbol ${signal.symbol} for signal processing`);
            
            this.alerts.push({ ...signal, timestamp: Date.now() });
            this.emit('alert', signal);
            await this.handleSignal(signal);
        });

        // Listen for price updates
        this.marketData.on('priceUpdate', ({ symbol, price }) => {
            this.emit('priceUpdate', { symbol, price });
        });

        // Periodic position sync (Optional but good for dummy APIs)
        setInterval(() => this.syncPositions(), 30000); // every 30s
    }

    async syncPositions() {
        try {
            const response = await this.orderExecutor.getPositions();
            console.log('Synced positions from API');

            if (response && response.result && Array.isArray(response.result.positionList)) {
                // Update local positions map based on API data
                // This ensures the dashboard shows what the broker/dummy API sees
                response.result.positionList.forEach(pos => {
                    const symbol = `${pos.ExchangeSegment}_${pos.ExchangeInstrumentId}`;
                    this.positions.set(symbol, {
                        qty: Number(pos.NetQty),
                        avgPrice: Number(pos.NetPrice),
                        totalCost: Number(pos.NetQty) * Number(pos.NetPrice)
                    });
                });
                this.emit('positionsSynced', this.getAllPositions());
            }
        } catch (error) {
            console.error('Failed to sync positions:', error.message);
        }
    }

    async handleSignal(signal) {
        const { symbol, action, quantity, position } = signal;

        const currentPrice = this.marketData.getLastPrice(symbol);
        console.log(`Processing signal for ${symbol}: Action=${action}, Qty=${quantity}, TargetPos=${position || 'N/A'}. Last Price: ${currentPrice || 'N/A'}`);

        // Handle target position 'flat' as a square-off signal
        if (position === 'flat') {
            console.log(`Signal indicates 'flat' position. Squaring off ${symbol}...`);
            try {
                const result = await this.squareOff(symbol);
                this.emit('order', {
                    signal,
                    result,
                    status: 'SQUARED_OFF',
                    timestamp: Date.now()
                });
                this.emit('positionUpdate', this.getPosition(symbol));
                return;
            } catch (error) {
                console.error(`Automatic square-off failed for ${symbol}:`, error.message);
            }
        }

        try {
            const result = await this.orderExecutor.placeMarketOrder({
                symbol,
                action,
                quantity
            });

            console.log(`Order Placed Successfully:`, JSON.stringify(result));

            const orderEntry = {
                id: result?.result?.AppOrderID || `ORD_${Date.now()}`,
                symbol,
                action,
                quantity,
                marketPrice: currentPrice ?? null,
                signal,
                result,
                price: currentPrice || 0,
                timestamp: Date.now(),
                status: 'PLACED'
            };

            this.orders.push(orderEntry);
            this.updatePosition(symbol, action, quantity, orderEntry.price);
            this.emit('order', orderEntry);
            this.emit('positionUpdate', this.getPosition(symbol));

            console.log('=== ORDER CREATED ===');
            console.log(JSON.stringify({
                id: orderEntry.id,
                symbol: orderEntry.symbol,
                action: orderEntry.action,
                quantity: orderEntry.quantity,
                marketPrice: orderEntry.marketPrice,
                trackingPrice: orderEntry.price,
                status: orderEntry.status,
                timestamp: orderEntry.timestamp
            }, null, 2));

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
            const closed = {
                symbol,
                entryPrice: pos.avgPrice,
                exitPrice: price,
                qty: Math.abs(oldQty),
                pnl: (price - pos.avgPrice) * oldQty,
                timestamp: Date.now()
            };
            this.historicalPositions.push(closed);
            this.emit('historyUpdate', closed);
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
        const data = this.positions.get(symbol) || { qty: 0, avgPrice: 0 };
        return { symbol, ...data };
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

        const quantity = Math.abs(pos.qty);

        console.log(`Manual Square-off triggered for ${symbol}: Qty ${quantity}`);

        try {
            const result = await this.orderExecutor.squareOffPosition({ symbol, quantity });
            console.log(`Square-off result for ${symbol}:`, JSON.stringify(result));

            // Still update local position tracking
            const action = pos.qty > 0 ? 'SELL' : 'BUY';
            this.updatePosition(symbol, action, quantity, this.marketData.getLastPrice(symbol) || 0);
            this.emit('positionUpdate', this.getPosition(symbol));

            return result;
        } catch (error) {
            console.error(`Square-off failed for ${symbol}:`, error.message);
            throw error;
        }
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

