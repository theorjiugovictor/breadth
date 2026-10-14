import axios from "axios";
import { validateCart, type Cart } from "../routes/checkout";

const ORDERS_URL = process.env.ORDERS_URL ?? "http://orders:8000";

export interface Order {
  orderId: string;
  status: "paid" | "declined";
  total: number;
}

/** Thin HTTP client for the orders service. */
export class OrdersClient {
  async createOrder(cart: Cart): Promise<Order> {
    validateCart(cart);
    const res = await axios.post(`${ORDERS_URL}/orders`, cart);
    return res.data;
  }

  async getOrder(id: string): Promise<Order> {
    const res = await axios.get(`${ORDERS_URL}/orders/${id}`);
    return res.data;
  }
}
