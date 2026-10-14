BLOCKLIST = {"cus_fraud"}


def risk_score(customer: str, amount: float) -> float:
    """Toy risk model."""
    if customer in BLOCKLIST:
        return 1.0
    return min(amount / 1000.0, 1.0)


def check_lines(lines):
    """Validate charge line items."""
    if not lines:
        raise ValueError("no lines")
    for line in lines:
        if line.qty <= 0:
            raise ValueError(f"bad quantity for {line.sku}")
        if line.qty > 100:
            raise ValueError(f"too many of {line.sku}")
    return lines
