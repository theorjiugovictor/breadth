import os

import httpx

PAYMENTS_URL = os.environ.get("PAYMENTS_URL", "http://payments:9000")


def charge(customer_id: str, amount: float) -> dict:
    """Ask the payments service to charge the customer."""
    resp = httpx.post(f"{PAYMENTS_URL}/charges", json={"customer": customer_id, "amount": amount})
    return resp.json()
