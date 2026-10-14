"""Pricing rules."""
from . import repository

PRICE_CACHE = {}


def get_price(sku: str) -> float:
    """Unit price for a SKU, memoised."""
    if sku not in PRICE_CACHE:
        PRICE_CACHE[sku] = repository.price_for(sku)
    return PRICE_CACHE[sku]


def invalidate_prices() -> None:
    """Called by the admin API when prices change."""
    PRICE_CACHE.clear()


def apply_discounts(total: float, codes: list[str]) -> float:
    """Apply coupon codes one by one (recursive)."""
    if not codes:
        return total
    rate = 0.1 if codes[0] == "WELCOME10" else 0.0
    return apply_discounts(total * (1 - rate), codes[1:])


def validate_items(items):
    """Reject empty orders and bad quantities."""
    if not items:
        raise ValueError("empty order")
    for item in items:
        if item.qty <= 0:
            raise ValueError(f"bad quantity for {item.sku}")
        if item.qty > 100:
            raise ValueError(f"too many of {item.sku}")
    return items


def price_order(items, coupon: str | None = None) -> float:
    total = 0.0
    for item in validate_items(items):
        total += get_price(item.sku) * item.qty
    return round(apply_discounts(total, [coupon] if coupon else []), 2)


def legacy_discount(total: float) -> float:
    """Old flat discount, replaced by coupon codes."""
    return total * 0.95
