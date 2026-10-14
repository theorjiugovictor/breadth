"""Orders service: prices carts, charges payment, stores orders."""
from fastapi import FastAPI

from .models import OrderRequest, Order
from .pricing import price_order
from .payments import charge
from . import repository, events

app = FastAPI()


@app.post("/orders")
def create_order(req: OrderRequest) -> Order:
    """Price the cart, charge the customer and persist the order."""
    customer = repository.fetch_customer(req.customer_id)
    total = price_order(req.items, req.coupon)
    payment = charge(req.customer_id, total, customer["email"])
    order = Order(id=repository.next_id(), customer_id=req.customer_id, total=total, status=payment["status"])
    repository.save_order(order)
    if order.status == "paid":
        events.order_created(order)
    return order


@app.get("/orders/{order_id}")
def get_order(order_id: str) -> Order:
    return repository.load_order(order_id)
