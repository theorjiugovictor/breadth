"""Resilience checks run against a deployed orders service (see openspec/specs/checkout)."""
import pytest


@pytest.mark.requirement("checkout-survives-a-slow-database")
def test_postgres_latency(client, toxiproxy):
    toxiproxy.add_latency("postgres", ms=100, seconds=10)
    assert client.post("/orders", json={"items": []}).status_code < 500
