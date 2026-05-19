const { spawn } = require('child_process');
const MarketDataProvider = require('../interfaces/MarketDataProvider');
const EventEmitter = require('events');
const path = require('path');

class PythonSidecarAdapter extends MarketDataProvider {
    constructor(config = {}) {
        super();
        this.scriptPath = config.scriptPath || path.join(__dirname, '../../../working_with_eXchange1_api/eXchange1_api_!.py');
        this.symbol = config.symbol || 'btcusdt';
        this.lastPrices = new Map();
        this.events = new EventEmitter();
        this.subprocess = null;
    }

    connect() {
        const mockPrice = process.env.PYTHON_MOCK_PRICE;
        if (mockPrice) {
            const price = Number(mockPrice);
            this.lastPrices.set(this.symbol, price);
            console.log(`[PythonSidecar] Using mock price ${price} for ${this.symbol}`);
            return Promise.resolve();
        }

        console.log(`Starting Python Sidecar: ${this.scriptPath} (symbol: ${this.symbol})`);
        // -u / PYTHONUNBUFFERED: print() must flush when stdout is piped to Node
        this.subprocess = spawn('python', ['-u', this.scriptPath], {
            env: { ...process.env, MARKET_DATA_SYMBOL: this.symbol },
            cwd: path.dirname(this.scriptPath)
        });

        this.subprocess.stdout.on('data', (data) => {
            const text = data.toString();
            const lines = text.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith('CONNECTED') || trimmed.startsWith('SUBSCRIBED')) {
                    console.log(`[PythonSidecar] ${trimmed}`);
                    continue;
                }

                // Parse: "TRADE | buy | price=3124.50 | vol=0.0450 | ..."
                if (trimmed.startsWith('TRADE')) {
                    const parts = trimmed.split('|').map(s => s.trim());
                    const priceField = parts[2];
                    const priceVal = parseFloat(priceField?.split('=')[1]);
                    if (!Number.isFinite(priceVal)) {
                        console.warn('[PythonSidecar] Could not parse price from:', trimmed);
                        continue;
                    }

                    this.lastPrices.set(this.symbol, priceVal);
                    if (!this._loggedFirstPrice) {
                        this._loggedFirstPrice = true;
                        console.log(`[PythonSidecar] First price for ${this.symbol}: ${priceVal}`);
                    }

                    this.events.emit('priceUpdate', {
                        symbol: this.symbol,
                        price: priceVal,
                        timestamp: Date.now()
                    });
                }
            }
        });

        this.subprocess.stderr.on('data', (data) => {
            console.error(`Python stderr: ${data.toString()}`);
        });

        this.subprocess.on('close', (code) => {
            console.log(`Python client terminated with code ${code}. Reconnecting in 5s...`);
            setTimeout(() => this.connect(), 5000);
        });

        return Promise.resolve();
    }

    getActiveSymbol() {
        return this.symbol;
    }

    subscribe(symbol) {
        this.symbol = symbol;
    }

    getLastPrice(symbol) {
        const key = symbol || this.symbol;
        if (this.lastPrices.has(key)) return this.lastPrices.get(key);
        if (this.lastPrices.has(this.symbol)) return this.lastPrices.get(this.symbol);
        return null;
    }

    on(event, callback) {
        this.events.on(event, callback);
    }
}

module.exports = PythonSidecarAdapter;
