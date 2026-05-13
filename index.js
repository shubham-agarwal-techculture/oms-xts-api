require('dotenv').config();
const XTSMarketDataAdapter = require('./src/adapters/XTSMarketDataAdapter');
const RESTSignalReceiver = require('./src/adapters/RESTSignalReceiver');
const XTSOrderExecutor = require('./src/adapters/XTSOrderExecutor');
const OrderManager = require('./src/core/OrderManager');

async function main() {
    try {
        // 1. Initialize Adapters
        const marketData = new XTSMarketDataAdapter({
            baseUrl: process.env.XTS_MARKET_DATA_URL,
            appKey: process.env.XTS_APP_KEY,
            secretKey: process.env.XTS_SECRET_KEY
        });

        const signalSource = new RESTSignalReceiver(process.env.SIGNAL_PORT || 5001);

        const orderExecutor = new XTSOrderExecutor({
            baseUrl: process.env.XTS_INTERACTIVE_URL,
            appKey: process.env.XTS_APP_KEY,
            secretKey: process.env.XTS_SECRET_KEY
        });

        // 2. Initialize Core
        const oms = new OrderManager({
            marketData,
            signalSource,
            orderExecutor
        });

        // 3. Connect and Start
        console.log('Starting OMS...');
        
        await marketData.connect();
        // marketData.subscribe('1_22'); // Example subscription if needed

        signalSource.start();
        
        oms.init();

        console.log('OMS is running and waiting for signals.');

    } catch (error) {
        console.error('Failed to start OMS:', error);
        process.exit(1);
    }
}

main();
