# Change: Add bulk refunds

## Why
Support agents refund orders one by one after an incident; a single request should refund many.

## What Changes
- New endpoint `POST /orders/refunds` in orders
- New endpoint `POST /refunds` in payments
