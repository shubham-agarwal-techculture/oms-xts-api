const EventEmitter = require('events');
const path = require('path');
const OmsStateStore = require('./OmsStateStore');

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
        this.positions = new Map(); // symbol -> { qty, avgPrice, totalCost, lastOrderQty, targetQty, side }
        this.historicalPositions = [];
        this.defaultSymbol = process.env.DEFAULT_SYMBOL || 'NIFTY';
        this.maxPersistedItems = Math.max(100, Number(process.env.OMS_MAX_STATE_ITEMS) || 5000);
        this.uiStateWindow = Math.max(50, Number(process.env.OMS_UI_STATE_WINDOW) || 500);
        const statePath =
            process.env.OMS_STATE_PATH ||
            path.join(process.cwd(), 'data', 'oms-state.json');
        this.stateStore = process.env.OMS_DISABLE_PERSIST === '1' ? null : new OmsStateStore(statePath);
        this._registerShutdownFlush();
    }

    _registerShutdownFlush() {
        if (!this.stateStore) return;
        const flush = () => this.stateStore.flushSync(() => this.getPersistSnapshot());
        process.once('SIGINT', () => {
            flush();
            process.exit(0);
        });
        process.once('SIGTERM', () => {
            flush();
            process.exit(0);
        });
        process.once('beforeExit', flush);
    }

    getPersistSnapshot() {
        return {
            version: 1,
            updatedAt: Date.now(),
            orders: this.orders.slice(-this.maxPersistedItems),
            alerts: this.alerts.slice(-this.maxPersistedItems),
            positions: Object.fromEntries(this.positions),
            historicalPositions: this.historicalPositions.slice(-this.maxPersistedItems)
        };
    }

    schedulePersist() {
        if (!this.stateStore) return;
        this.stateStore.scheduleSave(() => this.getPersistSnapshot());
    }

    loadPersistedState() {
        if (!this.stateStore) return;
        const data = this.stateStore.load();
        if (!data || data.version !== 1) {
            if (data) {
                console.warn('[OrderManager] Ignoring unknown or invalid state file version');
            }
            return;
        }
        if (Array.isArray(data.orders)) {
            this.orders = data.orders.slice(-this.maxPersistedItems);
        }
        if (Array.isArray(data.alerts)) {
            this.alerts = data.alerts.slice(-this.maxPersistedItems);
        }
        if (Array.isArray(data.historicalPositions)) {
            this.historicalPositions = data.historicalPositions.slice(-this.maxPersistedItems);
        }
        if (data.positions && typeof data.positions === 'object') {
            this.positions = new Map();
            for (const [sym, row] of Object.entries(data.positions)) {
                if (!row || typeof row !== 'object') continue;
                const qty = Number(row.qty);
                if (!Number.isFinite(qty) || qty === 0) continue;
                const avg = Number(row.avgPrice) || 0;
                const totalCost = Number.isFinite(Number(row.totalCost))
                    ? Number(row.totalCost)
                    : qty * avg;
                this.positions.set(sym, {
                    qty,
                    avgPrice: avg,
                    totalCost,
                    lastOrderQty: row.lastOrderQty != null ? Number(row.lastOrderQty) : undefined,
                    targetQty: row.targetQty != null ? Number(row.targetQty) : undefined,
                    side: row.side || this.getSide(qty)
                });
            }
        }
        console.log(
            `[OrderManager] Restored state: ${this.orders.length} orders, ${this.alerts.length} alerts, ` +
                `${this.positions.size} positions, ${this.historicalPositions.length} history entries`
        );
    }

    normalizeSymbol(symbol) {
        if (!symbol) return this.defaultSymbol;
        return String(symbol);
    }

    getTargetQty(position, quantity) {
        const qty = Number(quantity) || 0;
        if (position === 'long') return qty;
        if (position === 'short') return -qty;
        return 0;
    }

    getSide(netQty) {
        if (netQty > 0) return 'LONG';
        if (netQty < 0) return 'SHORT';
        return 'FLAT';
    }

    /**
     * Try to read a fill / last traded price from broker order response.
     * @param {object} result top-level API response (often { type, result })
     * @returns {number|null}
     */
    extractFillPriceFromOrderResult(result) {
        const r = result && typeof result === 'object' ? (result.result ?? result) : null;
        if (!r || typeof r !== 'object') return null;
        const keys = [
            'OrderAverageTradedPrice',
            'AverageTradedPrice',
            'AverageTradePrice',
            'TradedPrice',
            'LastTradedPrice',
            'LastPrice',
            'LTP',
            'OrderPrice',
            'LimitPrice',
            'Price'
        ];
        for (const k of keys) {
            const n = Number(r[k]);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
    }

    /**
     * Best-effort last price for PnL / avg entry (handles cold start before first tick).
     * @param {string} symbol
     * @returns {number|null}
     */
    resolveFillPrice(symbol) {
        const sym = this.normalizeSymbol(symbol);
        const tryPrice = (s) => {
            if (s == null) return null;
            const p = this.marketData.getLastPrice(s);
            return Number.isFinite(p) && p > 0 ? p : null;
        };

        let p = tryPrice(sym);
        if (p != null) return p;

        p = tryPrice(undefined);
        if (p != null) return p;

        if (typeof this.marketData.getActiveSymbol === 'function') {
            p = tryPrice(this.marketData.getActiveSymbol());
            if (p != null) return p;
        }

        const md = this.marketData;
        if (md.lastPrices instanceof Map && md.lastPrices.size > 0) {
            for (const v of md.lastPrices.values()) {
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }

        return null;
    }

    /**
     * When avg was unknown at fill time, set avg from first usable LTP for that symbol.
     */
    repairPositionsWithUnknownAvg(symbol, price) {
        const p = Number(price);
        if (!Number.isFinite(p) || p <= 0) return;

        const norm = this.normalizeSymbol(symbol);
        let changed = false;

        for (const [sym, pos] of this.positions) {
            if (this.normalizeSymbol(sym) !== norm) continue;
            if (!pos.qty) continue;
            if (Number(pos.avgPrice) > 0) continue;

            pos.avgPrice = p;
            pos.totalCost = Math.abs(pos.qty) * p;
            pos.side = this.getSide(pos.qty);
            this.positions.set(sym, pos);
            changed = true;
            this.emit('positionUpdate', this.getPosition(sym));
        }

        if (changed) {
            this.schedulePersist();
        }
    }

    init() {
        console.log('Initializing Order Manager...');
        this.loadPersistedState();
        for (const sym of this.positions.keys()) {
            const p = this.resolveFillPrice(sym);
            if (p != null) {
                this.repairPositionsWithUnknownAvg(sym, p);
            }
        }

        // Listen for signals
        this.signalSource.on('signal', async (signal) => {
            const activeSymbol = typeof this.marketData.getActiveSymbol === 'function'
                ? this.marketData.getActiveSymbol()
                : null;
            // If no symbol in signal, use active symbol or default to 'NIFTY'
            signal.symbol = this.normalizeSymbol(signal.symbol || activeSymbol || 'NIFTY');
            console.log(`Resolved symbol ${signal.symbol} for signal processing`);
            
            this.alerts.push({ ...signal, timestamp: Date.now() });
            this.emit('alert', signal);
            try {
                await this.handleSignal(signal);
            } finally {
                this.schedulePersist();
            }
        });

        // Listen for price updates
        this.marketData.on('priceUpdate', ({ symbol, price }) => {
            this.repairPositionsWithUnknownAvg(symbol, price);
            this.emit('priceUpdate', { symbol, price });
        });

        // Periodic position sync (Optional but good for dummy APIs)
        // setInterval(() => this.syncPositions(), 30000); // every 30s
    }

    async syncPositions() {
        try {
            const response = await this.orderExecutor.getPositions();
            console.log('Synced positions from API');

            if (response && response.result && Array.isArray(response.result.positionList)) {
                // Merge broker positions (do not wipe locally tracked symbols missing from broker)
                response.result.positionList.forEach(pos => {
                    const symbol = this.normalizeSymbol(
                        `${pos.ExchangeSegment}_${pos.ExchangeInstrumentId}`
                    );
                    const qty = Number(pos.NetQty);
                    if (qty === 0) {
                        const existing = this.positions.get(symbol);
                        if (existing && existing.qty !== 0) {
                            const exitPrice = Number(pos.NetPrice) || this.resolveFillPrice(symbol) || existing.avgPrice || 0;
                            const closed = {
                                symbol,
                                entryPrice: existing.avgPrice,
                                exitPrice,
                                qty: Math.abs(existing.qty),
                                pnl: (exitPrice - existing.avgPrice) * existing.qty,
                                timestamp: Date.now()
                            };
                            this.historicalPositions.push(closed);
                            this.emit('historyUpdate', closed);
                            this.emit('order', {
                                signal: { symbol, position: 'flat', quantity: Math.abs(existing.qty) },
                                result: { message: 'Auto square-off via position sync' },
                                status: 'SQUARED_OFF',
                                timestamp: Date.now()
                            });
                        }
                        this.positions.delete(symbol);
                        return;
                    }
                    const existing = this.positions.get(symbol) || {};
                    const brokerAvg = Number(pos.NetPrice);
                    const hasBrokerAvg = Number.isFinite(brokerAvg) && brokerAvg > 0;
                    const avgPrice = hasBrokerAvg
                        ? brokerAvg
                        : (Number(existing.avgPrice) > 0 ? Number(existing.avgPrice) : 0);
                    const totalCost = hasBrokerAvg
                        ? qty * brokerAvg
                        : (avgPrice > 0 ? qty * avgPrice : (Number(existing.totalCost) || 0));

                    this.positions.set(symbol, {
                        ...existing,
                        qty,
                        avgPrice,
                        totalCost,
                        side: this.getSide(qty)
                    });
                });
                this.emit('positionsSynced', this.getAllPositions());
                this.schedulePersist();
            }
        } catch (error) {
            console.error('Failed to sync positions:', error.message);
        }
    }

    async handleSignal(signal) {
        const symbol = this.normalizeSymbol(signal.symbol);
        const { quantity, position } = signal;

        const currentPrice = this.resolveFillPrice(symbol);
        const currentQty = (this.positions.get(symbol) || { qty: 0 }).qty;
        const targetQty = this.getTargetQty(position, quantity);

        console.log(
            `Processing signal for ${symbol}: position=${position}, signalQty=${quantity}, ` +
            `currentQty=${currentQty}, targetQty=${targetQty}. Last Price: ${currentPrice ?? 'N/A'}`
        );

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

        const delta = targetQty - currentQty;
        if (delta === 0) {
            console.log(`No order needed — already at target qty ${targetQty} for ${symbol}`);
            return;
        }

        const action = delta > 0 ? 'BUY' : 'SELL';
        const orderQty = Math.abs(delta);

        try {
            // Use current market price as limit price if not provided for LIMIT orders
            const resolvedLimitPrice = signal.limitPrice || currentPrice;
            
            const result = await this.orderExecutor.placeOrder({
                symbol,
                action,
                quantity: orderQty,
                orderType: signal.orderType || 'LIMIT',
                limitPrice: resolvedLimitPrice,
                productType: signal.productType || 'MIS',
                instrumentType: signal.instrumentType
            });

            console.log(`Order Placed Successfully:`, JSON.stringify(result));

            const fillPrice =
                this.extractFillPriceFromOrderResult(result) ??
                this.resolveFillPrice(symbol) ??
                null;

            if (fillPrice == null) {
                console.warn(
                    `[OrderManager] No fill price for ${symbol} yet — avg entry will update on first market tick`
                );
            }

            const orderEntry = {
                id: result?.result?.AppOrderID || `ORD_${Date.now()}`,
                symbol,
                action,
                quantity: orderQty,
                orderQty,
                targetQty,
                positionQty: targetQty,
                marketPrice: fillPrice,
                signal,
                result,
                price: fillPrice,
                timestamp: Date.now(),
                status: 'PLACED'
            };

            this.orders.push(orderEntry);
            if (fillPrice != null) {
                this.updatePosition(symbol, action, orderQty, fillPrice, {
                    lastOrderQty: orderQty,
                    targetQty
                });
            } else {
                this.updatePosition(symbol, action, orderQty, null, {
                    lastOrderQty: orderQty,
                    targetQty
                });
            }
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
            this.schedulePersist();
        }
    }

    updatePosition(symbol, action, quantity, price, meta = {}) {
        let pos = this.positions.get(symbol) || { qty: 0, avgPrice: 0, totalCost: 0 };
        const tradeQty = action === 'BUY' ? quantity : -quantity;
        const fillPrice = price != null && Number(price) > 0 ? Number(price) : null;

        const oldQty = pos.qty;
        const newQty = oldQty + tradeQty;

        if (newQty === 0) {
            const exitPrice = fillPrice ?? this.resolveFillPrice(symbol) ?? pos.avgPrice ?? 0;
            const closed = {
                symbol,
                entryPrice: pos.avgPrice,
                exitPrice,
                qty: Math.abs(oldQty),
                pnl: (exitPrice - pos.avgPrice) * oldQty,
                timestamp: Date.now()
            };
            this.historicalPositions.push(closed);
            this.emit('historyUpdate', closed);
            this.positions.delete(symbol);
        } else {
            if ((oldQty >= 0 && tradeQty > 0) || (oldQty <= 0 && tradeQty < 0)) {
                if (fillPrice != null) {
                    const newTotalCost = pos.totalCost + (quantity * fillPrice);
                    pos.avgPrice = newTotalCost / Math.abs(newQty);
                    pos.totalCost = newTotalCost;
                } else if (pos.avgPrice > 0) {
                    pos.totalCost = pos.avgPrice * Math.abs(newQty);
                }
            } else if (pos.avgPrice > 0) {
                pos.totalCost = pos.avgPrice * Math.abs(newQty);
            }
            pos.qty = newQty;
            pos.side = this.getSide(newQty);
            pos.lastOrderQty = meta.lastOrderQty ?? quantity;
            pos.targetQty = meta.targetQty ?? pos.targetQty;
            this.positions.set(symbol, pos);
        }
        this.schedulePersist();
    }

    getPosition(symbol) {
        const data = this.positions.get(symbol) || { qty: 0, avgPrice: 0 };
        return {
            symbol,
            ...data,
            side: data.side || this.getSide(data.qty)
        };
    }

    getAllPositions() {
        return Array.from(this.positions.entries())
            .filter(([, data]) => data.qty !== 0)
            .map(([symbol, data]) => ({
                symbol,
                ...data,
                side: data.side || this.getSide(data.qty)
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
            const exitPrice =
                this.extractFillPriceFromOrderResult(result) ??
                this.resolveFillPrice(symbol);
            this.updatePosition(symbol, action, quantity, exitPrice);
            this.emit('positionUpdate', this.getPosition(symbol));

            return result;
        } catch (error) {
            console.error(`Square-off failed for ${symbol}:`, error.message);
            throw error;
        }
    }

    getState() {
        return {
            orders: this.orders.slice(-this.uiStateWindow),
            alerts: this.alerts.slice(-this.uiStateWindow),
            positions: this.getAllPositions(),
            historicalPositions: this.historicalPositions.slice(-this.uiStateWindow)
        };
    }
}

module.exports = OrderManager;

