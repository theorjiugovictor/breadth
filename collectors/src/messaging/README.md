# `messaging` collector

Implemented: AsyncAPI 2.x and 3.x documents (channels, operations, messages, servers). Reading brokers themselves (Kafka admin API, SQS/SNS listings, RabbitMQ definitions, schema registries) is still planned, as below.

Describes message brokers from their own metadata: which topics and queues exist, who produces to them and who consumes from them.

The code collector already finds producer and consumer calls in source code (Kafka, RabbitMQ, SQS, NATS...), and the OTel importer sees them at runtime. This collector adds the broker's view, so topics with no instrumented client still appear.

## Inputs (planned)

| Source | How |
|---|---|
| Kafka | Admin API (`listTopics`, `describeConsumerGroups`, group offsets) or `kafka-consumer-groups --describe` output |
| Confluent Schema Registry | subject list, so ports get message types |
| AWS SQS / SNS | `aws sqs list-queues`, `aws sns list-subscriptions` JSON |
| RabbitMQ | management API `/api/definitions` export (exchanges, queues, bindings) |
| AsyncAPI | `asyncapi.yaml` documents (channels, publish/subscribe operations, message schemas) |

## Mapping

| Observed | Becomes |
|---|---|
| broker / cluster | `queue` node `queue:<system>` (e.g. `queue:kafka`), layer `messaging` |
| topic / queue / exchange | `queue` node `queue:<system>:<name>`, parent = broker, alias `topic:<name>` |
| consumer group | `service` node aliased `service:<group>` (matches code/k8s services by name) |
| group consumes topic | `event` edge topic -> group, `label` = `consume <topic>`, `metadata.lag` |
| known producer (ACLs, AsyncAPI `publish`) | `event` edge producer -> topic |
| message schema | `outputs` port on the topic: `{ name: "message", type: "<schema subject>" }` |
| SNS -> SQS subscription | `event` edge topic -> queue |

The ids match what the code collector emits (`queue:kafka`, `queue:kafka:order-created`), so the views merge.
