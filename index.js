require('dotenv').config();
const XTSMarketDataAdapter = require('./src/adapters/XTSMarketDataAdapter');
const PythonSidecarAdapter = require('./src/adapters/PythonSidecarAdapter');
const RESTSignalReceiver = require('./src/adapters/RESTSignalReceiver');
const XTSOrderExecutor = require('./src/adapters/XTSOrderExecutor');
const MockOrderExecutor = require('./src/adapters/MockOrderExecutor');
const DashboardAdapter = require('./src/adapters/DashboardAdapter');
const OrderManager = require('./src/core/OrderManager');

function createMarketData() {
    if (process.env.MARKET_DATA_PROVIDER === 'python') {
        return new PythonSidecarAdapter({
            scriptPath: process.env.PYTHON_MARKET_DATA_SCRIPT,
            symbol: process.env.MARKET_DATA_SYMBOL || 'btcusdt'
        });
    }
    return new XTSMarketDataAdapter({
        baseUrl: process.env.XTS_MARKET_DATA_URL,
        appKey: process.env.XTS_MARKET_DATA_APP_KEY,
        secretKey: process.env.XTS_MARKET_DATA_SECRET_KEY
    });
}

function createOrderExecutor(marketDataConfig) {
    if (process.env.ORDER_EXECUTOR === 'mock') {
        console.log('Using MockOrderExecutor (no broker API calls)');
        return new MockOrderExecutor();
    }
    return new XTSOrderExecutor({
        baseUrl: process.env.XTS_INTERACTIVE_URL,
        appKey: process.env.XTS_INTERACTIVE_APP_KEY,
        secretKey: process.env.XTS_INTERACTIVE_SECRET_KEY,
        userId: process.env.XTS_INTERACTIVE_USER_ID,
        marketDataConfig: marketDataConfig
    });
}

async function main() {
    try {
        // 1. Initialize Adapters
        const marketDataConfig = {
            baseUrl: process.env.XTS_MARKET_DATA_URL,
            appKey: process.env.XTS_MARKET_DATA_APP_KEY,
            secretKey: process.env.XTS_MARKET_DATA_SECRET_KEY
        };
        const marketData = new XTSMarketDataAdapter(marketDataConfig);
        const signalSource = new RESTSignalReceiver(process.env.SIGNAL_PORT || 5001);
        const orderExecutor = createOrderExecutor(marketDataConfig);

        // 2. Initialize Core
        const oms = new OrderManager({
            marketData,
            signalSource,
            orderExecutor
        });

        // 3. Initialize Dashboard (Loosely coupled)
        const dashboard = new DashboardAdapter(oms, process.env.DASHBOARD_PORT || 3000);

        // 4. Connect and Start
        console.log('Starting OMS...');

        await marketData.connect();
        
        // Load instrument masters and symbol map
        console.log('Loading instrument masters...');
        await orderExecutor.loadSymbolMap(['NSECM', 'NSEFO']); // Load NSECM (spot) and NSEFO (options) segments

        // Subscribe to underlying instrument (e.g., NIFTY spot - exchangeSegment=1, exchangeInstrumentID=26000)
        try {
            await marketData.subscribeInstruments([
                { exchangeSegment: 1, exchangeInstrumentID: 26000 } // NIFTY spot
            ]);
        } catch (error) {
            console.error('Failed to subscribe to underlying instrument:', error.message);
        }

        signalSource.start();
        dashboard.start();

        oms.init();

        console.log('OMS and Dashboard are running.');

    } catch (error) {
        console.error('Failed to start OMS:', error);
        process.exit(1);
    }
}

main();

