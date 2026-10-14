from dataclasses import dataclass, field


@dataclass
class Item:
    sku: str
    qty: int


@dataclass
class OrderRequest:
    customer_id: str
    items: list[Item] = field(default_factory=list)
    coupon: str | None = None


@dataclass
class Order:
    id: str
    customer_id: str
    total: float
    status: str
