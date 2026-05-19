const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

class DashboardAdapter {
    constructor(oms, port = 3000) {
        this.oms = oms;
        this.port = port;
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = new Server(this.server);

        this.setupRoutes();
        this.setupWebSockets();
    }

    setupRoutes() {
        // Serve static files from 'public' directory
        this.app.use(express.static(path.join(__dirname, '../../public')));
        
        this.app.get('/api/state', (req, res) => {
            res.json(this.oms.getState());
        });

        this.app.post('/api/squareoff/:symbol', async (req, res) => {
            try {
                const result = await this.oms.squareOff(req.params.symbol);
                res.json({ success: true, result });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
    }

    setupWebSockets() {
        this.io.on('connection', (socket) => {
            console.log('Dashboard client connected');
            
            // Send initial state
            socket.emit('state', this.oms.getState());

            // Forward events from OMS to dashboard
            const onAlert = (data) => socket.emit('alert', { ...data, timestamp: Date.now() });
            const onOrder = (data) => socket.emit('order', data);
            const onPositionUpdate = (data) => socket.emit('positionUpdate', data);
            const onPriceUpdate = (data) => socket.emit('priceUpdate', data);
            const onPositionsSynced = (positions) => socket.emit('positionsSynced', positions);
            const onHistoryUpdate = (item) => socket.emit('historyUpdate', item);

            this.oms.on('alert', onAlert);
            this.oms.on('order', onOrder);
            this.oms.on('positionUpdate', onPositionUpdate);
            this.oms.on('priceUpdate', onPriceUpdate);
            this.oms.on('positionsSynced', onPositionsSynced);
            this.oms.on('historyUpdate', onHistoryUpdate);

            socket.on('disconnect', () => {
                console.log('Dashboard client disconnected');
                this.oms.off('alert', onAlert);
                this.oms.off('order', onOrder);
                this.oms.off('positionUpdate', onPositionUpdate);
                this.oms.off('priceUpdate', onPriceUpdate);
                this.oms.off('positionsSynced', onPositionsSynced);
                this.oms.off('historyUpdate', onHistoryUpdate);
            });
        });
    }

    start() {
        this.server.listen(this.port, () => {
            console.log(`Dashboard available at http://localhost:${this.port}`);
        });
    }
}

module.exports = DashboardAdapter;
