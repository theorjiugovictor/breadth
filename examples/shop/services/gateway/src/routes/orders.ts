import { OrdersClient } from "../clients/orders";

const client = new OrdersClient();

export async function getOrder(req: { params: { id: string } }, res: { json: (b: unknown) => void }) {
  res.json(await client.getOrder(req.params.id));
}
