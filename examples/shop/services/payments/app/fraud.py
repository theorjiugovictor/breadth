BLOCKLIST = {"cus_fraud"}


def risk_score(customer: str, amount: float) -> float:
    """Toy risk model."""
    if customer in BLOCKLIST:
        return 1.0
    return min(amount / 1000.0, 1.0)
