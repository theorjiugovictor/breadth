# Refunds Specification

## ADDED Requirements

### Requirement: Support agents can refund many orders at once
The system SHALL refund a list of orders in one request and report each order's outcome.
Implemented by: refund_orders, POST /orders/refunds
Target: service orders

#### Scenario: Refund a batch
- **WHEN** an agent refunds 50 orders
- **THEN** every order is refunded once and p95 <= 2 s
