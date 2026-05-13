# Order Management System (OMS)

A loosely coupled Order Management System designed to process trade signals and execute market orders using real-time price data from XTS.

## Features
- **Loosely Coupled Architecture**: Uses an interface-driven approach (Ports and Adapters) for easy swapping of data sources or brokers.
- **Real-time Price Tracking**: Subscribes to XTS Market Data WebSocket to maintain the latest price for order execution logic.
- **REST Signal Receiver**: Exposes a simple HTTP endpoint to receive trade intents from external sources (e.g., TradingView, custom algorithms).
- **Automated Order Execution**: Automatically places MARKET orders via the XTS Interactive API upon receiving a signal.

## Project Structure
```text
oms/
├── src/
│   ├── interfaces/     # Abstract base classes for core components
│   ├── adapters/       # Concrete implementations (XTS, REST, etc.)
│   └── core/           # Business logic (OrderManager)
├── .env                # Configuration (API keys, URLs)
├── index.js            # Entry point
└── package.json
```

## Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   Update the `.env` file with your XTS credentials:
   ```env
   XTS_MARKET_DATA_URL="https://eztrade.wealthdiscovery.in/apimarketdata"
   XTS_INTERACTIVE_URL="https://eztrade.wealthdiscovery.in/apiinteractive"
   XTS_APP_KEY="your_app_key"
   XTS_SECRET_KEY="your_secret_key"
   XTS_SOURCE="WebAPI"
   SIGNAL_PORT=5001
   ```

## Running the System

Start the OMS:
```bash
node index.js
```

## Sending Trade Signals

You can trigger a trade by sending a JSON POST request to the signal receiver endpoint:

**Endpoint**: `POST http://localhost:5001/signal`

**Payload**:
```json
{
  "symbol": "1_22",
  "action": "BUY",
  "quantity": 1
}
```

**Example (cURL)**:
```bash
curl -X POST http://localhost:5001/signal \
     -H "Content-Type: application/json" \
     -d '{"symbol": "1_22", "action": "BUY", "quantity": 1}'
```

## Architecture Details

- **MarketDataProvider**: Emits `priceUpdate` events and provides `getLastPrice(symbol)`.
- **SignalSource**: Emits `signal` events when a trade intent is received.
- **OrderExecutor**: Handles the actual communication with the broker API.
- **OrderManager**: The "brain" that listens for signals, fetches context from the market data, and dispatches orders.
