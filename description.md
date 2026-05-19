# Order Management System

A loosely coupled OMS that receives trade signals over REST, resolves market prices from a pluggable feed, places market orders through a broker adapter, and streams live state to a web dashboard. Orders, alerts, open positions, and trade history are persisted to disk (default `data/oms-state.json`) and restored on restart unless `OMS_DISABLE_PERSIST=1`.

## Integrations (ports)

| Port | Default adapter | Alternatives |
| :--- | :--- | :--- |
| Signal source | `RESTSignalReceiver` | Implement `SignalSource` |
| Market data | `XTSMarketDataAdapter` | `PythonSidecarAdapter` |
| Order execution | `XTSOrderExecutor` | `MockOrderExecutor` |
| Dashboard | `DashboardAdapter` | Any consumer of OMS events |

See [README.md](./README.md) for setup, signal API, and configuration.
