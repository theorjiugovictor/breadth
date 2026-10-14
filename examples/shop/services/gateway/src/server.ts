import express from "express";
import { checkout } from "./routes/checkout";
import { getOrder } from "./routes/orders";

const app = express();
app.use(express.json());

app.post("/checkout", checkout);
app.get("/orders/:id", getOrder);

export function start(port = 8080) {
  app.listen(port);
}
