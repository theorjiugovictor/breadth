import { OrdersClient } from "../clients/orders";

export interface CartItem {
  sku: string;
  qty: number;
}

export interface Cart {
  customerId: string;
  items: CartItem[];
  coupon?: string;
}

const orders = new OrdersClient();

/** Validate the cart and place an order. */
export async function checkout(req: { body: Cart }, res: { status: (n: number) => { json: (b: unknown) => void } }) {
  const cart = validateCart(req.body);
  const order = await orders.createOrder(cart);
  res.status(order.status === "paid" ? 201 : 402).json(order);
}

/** Reject empty carts and non-positive quantities. */
export function validateCart(cart: Cart): Cart {
  if (!cart.items.length) throw new Error("empty cart");
  for (const item of cart.items) {
    if (item.qty <= 0) throw new Error(`bad quantity for ${item.sku}`);
  }
  return cart;
}
