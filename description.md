# Order Management System

A loosely coupled OMS that receives trade signals over REST, resolves market prices from a pluggable feed, places market orders through a broker adapter, and streams live state to a web dashboard.

## Integrations (ports)

| Port | Default adapter | Alternatives |
| :--- | :--- | :--- |
| Signal source | `RESTSignalReceiver` | Implement `SignalSource` |
| Market data | `XTSMarketDataAdapter` | `PythonSidecarAdapter` |
| Order execution | `XTSOrderExecutor` | `MockOrderExecutor` |
| Dashboard | `DashboardAdapter` | Any consumer of OMS events |

See [README.md](./README.md) for setup, signal API, and configuration.
