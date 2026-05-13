# Implementation Plan: Order Management System (OMS)

This document outlines the plan for building a loosely coupled Order Management System that processes signal intents and executes market orders using real-time price data.

## 1. System Architecture
The system will be designed with a "Port and Adapters" (Hexagonal) architecture to ensure loose coupling between core logic and external integrations.

### Core Modules
- **Order Engine**: Core business logic for processing signals and mapping them to exchange orders.
- **Order Store**: In-memory or persistent storage for tracking order lifecycles.

### Adapters (Interfaces)
- **Market Data Adapter**: Interface for receiving real-time ticks (e.g., from XTS WebSocket).
- **Signal Adapter**: Interface for receiving trade signals (e.g., Webhook, REST, or MQ).
- **Exchange Adapter**: Interface for communicating with the broker (e.g., XTS Interactive API).

## 2. Phase 1: Foundation & Interfaces
- [x] Define Abstract Base Classes or Interfaces for:
    - `MarketDataProvider`
    - `SignalSource`
    - `OrderExecutor`
- [x] Setup project structure in `oms/` directory.
- [x] Initialize `package.json` and basic environment configuration.

## 3. Phase 2: Integration Components
- [x] **Market Data Client**: Implement an adapter that connects to the existing XTS Market Data stream.
- [x] **Signal Receiver**: Implement a simple REST/Webhook endpoint to receive trade intents (Symbol, Action, Quantity).
- [x] **XTS Order Executor**: Implement an adapter using XTS Interactive API to place `MARKET` orders.

## 4. Phase 3: Core Logic & Execution
- [x] Implement the `OrderManager` to:
    - Listen for signals.
    - Fetch the latest price from the `MarketDataProvider`.
    - Format and dispatch orders via the `OrderExecutor`.
- [x] Implement error handling and logging for order rejections.

## 5. Phase 4: Monitoring & UI (Optional)
- [ ] Create a simple dashboard to view live order logs and statuses.
- [ ] Add persistence (SQLite/JSON) for historical order tracking.

## 6. Technical Stack
- **Language**: Node.js (JavaScript/TypeScript)
- **Communication**: WebSockets (for price), REST (for signals/orders)
- **Broker API**: XTS Interactive
- **Logging**: Winston or Pino for audit trails
