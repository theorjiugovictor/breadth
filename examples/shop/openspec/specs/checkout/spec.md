# Checkout Specification

## Purpose
Customers can place orders even when a dependency is slow or briefly down.

## Requirements

### Requirement: Checkout survives a slow database
Placing an order SHALL keep working while Postgres is slow, and SHALL recover on its own when it is back.
Implemented by: create_order, POST /orders
Target: service orders

#### Scenario: Postgres latency
- **WHEN** Postgres adds 100 ms to every query for 10 s at 10 req/s
- **THEN** p95 <= 300 ms and errors <= 1 % during and after the fault
Verified by: services/orders/tests/test_resilience.py::test_postgres_latency

#### Scenario: Postgres unavailable
- **WHEN** Postgres refuses connections for 10 s
- **THEN** errors <= 5 % over the run and the service recovers within 30 s
