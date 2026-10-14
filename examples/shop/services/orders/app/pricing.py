"""Pricing rules."""
PRICES = {"sku-1": 12.5, "sku-2": 30.0, "sku-3": 4.25}
PRICE_CACHE = {}


def get_price(sku: str) -> float:
    """Unit price for a SKU, memoised."""
    if sku not in PRICE_CACHE:
        PRICE_CACHE[sku] = PRICES.get(sku, 0.0)
    return PRICE_CACHE[sku]


def apply_discounts(total: float, codes: list[str]) -> float:
    """Apply coupon codes one by one (recursive)."""
    if not codes:
        return total
    rate = 0.1 if codes[0] == "WELCOME10" else 0.0
    return apply_discounts(total * (1 - rate), codes[1:])


def price_order(items, coupon: str | None = None) -> float:
    total = 0.0
    for item in items:
        total += get_price(item.sku) * item.qty
    return round(apply_discounts(total, [coupon] if coupon else []), 2)
