import os

import requests

STRIPE_KEY = os.environ.get("STRIPE_KEY", "sk_test")


def create_charge(customer: str, amount: float) -> str:
    resp = requests.post(
        "https://api.stripe.com/v1/charges",
        data={"customer": customer, "amount": int(amount * 100), "currency": "eur"},
        auth=(STRIPE_KEY, ""),
    )
    return resp.json()["id"]
