import json

from kafka import KafkaProducer

producer = KafkaProducer(bootstrap_servers="kafka:9092")


def order_created(order) -> None:
    """Publish an order-created event."""
    producer.send("order-created", json.dumps(order.__dict__).encode())
