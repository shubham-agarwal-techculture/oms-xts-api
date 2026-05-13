const SignalSource = require('../interfaces/SignalSource');
const express = require('express');
const EventEmitter = require('events');

class RESTSignalReceiver extends SignalSource {
    constructor(port = 5001) {
        super();
        this.port = port;
        this.app = express();
        this.app.use(express.json());
        this.events = new EventEmitter();
        this.setupRoutes();
    }

    setupRoutes() {
        this.app.post('/signal', (req, res) => {
            const { symbol, action, quantity, priceType } = req.body;

            if (!symbol || !action || !quantity) {
                return res.status(400).json({ error: 'Missing required fields: symbol, action, quantity' });
            }

            console.log(`Received signal: ${action} ${quantity} ${symbol}`);

            this.events.emit('signal', {
                symbol,
                action: action.toUpperCase(),
                quantity: Number(quantity),
                priceType: priceType || 'MARKET',
                timestamp: Date.now()
            });

            res.json({ status: 'Signal received' });
        });
    }

    start() {
        this.server = this.app.listen(this.port, () => {
            console.log(`Signal Receiver listening on port ${this.port}`);
        });
    }

    stop() {
        if (this.server) this.server.close();
    }

    on(event, callback) {
        this.events.on(event, callback);
    }
}

module.exports = RESTSignalReceiver;
