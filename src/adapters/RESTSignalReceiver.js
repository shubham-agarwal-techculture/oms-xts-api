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
            // const { symbol, action, quantity, priceType, position } = req.body;
            const { action, quantity, position } = req.body;


            if (!position || !action || !quantity) {
                console.warn('Invalid signal received:', req.body, req.query);
                return res.status(400).json({
                    error: 'Missing required fields: symbol, action, quantity, position',
                    received: { body: req.body, query: req.query }
                });
            }

            console.log(`Received signal: ${action} ${quantity} (Position: ${position || 'N/A'})`);

            this.events.emit('signal', {
                action: action.toUpperCase(),
                quantity: Number(quantity),
                position: position, // Pass through position if provided
                timestamp: Date.now()
            });

            res.json({ status: 'Signal received', action, quantity, position });
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
