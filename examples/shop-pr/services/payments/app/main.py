"""Payments service: card charges and refunds."""
from flask import Flask, request

from . import audit
from .stripe_client import create_charge, create_refund

app = Flask(__name__)
LIMIT = 500.0


@app.route("/charges", methods=["POST"])
def charge():
    body = request.get_json()
    getattr(audit, "record")({"event": "charge.requested", "customer": body["customer"]})
    if body["amount"] > LIMIT:
        return {"status": "declined", "reason": "limit"}, 402
    charge_id = create_charge(body["customer"], body["amount"], body["email"])
    return {"status": "paid", "chargeId": charge_id}


@app.route("/refunds", methods=["POST"])
def refund():
    body = request.get_json()
    refund_id = create_refund(body["customer"], body["amount"])
    return {"status": "refunded", "refundId": refund_id}
