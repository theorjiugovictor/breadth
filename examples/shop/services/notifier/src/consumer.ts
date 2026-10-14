import { Kafka } from "kafkajs";
import { sendConfirmation } from "./email";

const kafka = new Kafka({ clientId: "notifier", brokers: ["kafka:9092"] });
const consumer = kafka.consumer({ groupId: "notifier" });

/** Listen for new orders and email the customer. */
export async function run() {
  await consumer.connect();
  await consumer.subscribe({ topic: "order-created" });
  await consumer.run({
    eachMessage: async ({ message }) => handleOrderCreated(JSON.parse(String(message.value))),
  });
}

export async function handleOrderCreated(order: { id: string; customer_id: string; total: number }) {
  await sendConfirmation(order.customer_id, order.id, order.total);
}
