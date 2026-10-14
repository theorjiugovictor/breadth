"""Payments service: fraud checks and card charges."""
from flask import Flask, request

from .fraud import risk_score
from .stripe_client import create_charge

app = Flask(__name__)
LIMIT = 500.0


@app.route("/charges", methods=["POST"])
def charge():
    body = request.get_json()
    if risk_score(body["customer"], body["amount"]) > 0.8 or body["amount"] > LIMIT:
        return {"status": "declined", "reason": "risk"}, 402
    charge_id = create_charge(body["customer"], body["amount"])
    return {"status": "paid", "chargeId": charge_id}
