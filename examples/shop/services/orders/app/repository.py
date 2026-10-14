"""Postgres persistence for orders."""
import uuid

import psycopg2

from .models import Order

_conn = None


def connection():
    global _conn
    if _conn is None:
        _conn = psycopg2.connect("dbname=shop host=postgres")
    return _conn


def next_id() -> str:
    return uuid.uuid4().hex[:8]


def save_order(order: Order) -> None:
    cur = connection().cursor()
    cur.execute(
        "INSERT INTO orders (id, customer_id, total, status) VALUES (%s, %s, %s, %s)",
        (order.id, order.customer_id, order.total, order.status),
    )
    connection().commit()


def load_order(order_id: str) -> Order:
    cur = connection().cursor()
    cur.execute("SELECT id, customer_id, total, status FROM orders WHERE id = %s", (order_id,))
    return Order(*cur.fetchone())


def price_for(sku: str) -> float:
    cur = connection().cursor()
    cur.execute("SELECT price FROM products WHERE sku = %s", (sku,))
    return cur.fetchone()[0]


def fetch_customer(customer_id: str) -> dict:
    cur = connection().cursor()
    cur.execute("SELECT id, email, tier FROM customers WHERE id = %s", (customer_id,))
    row = cur.fetchone()
    return {"id": row[0], "email": row[1], "tier": row[2]}
