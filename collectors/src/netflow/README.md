# `netflow` collector (stub, not implemented)

Turns observed network traffic into `network` edges between the things that talk to each other.

## Inputs (planned)

| Source | Format |
|---|---|
| AWS VPC Flow Logs | v2+ text records or Parquet (`srcaddr dstaddr srcport dstport protocol packets bytes action`) |
| GCP VPC Flow Logs | JSON log entries (`jsonPayload.connection`) |
| Azure NSG flow logs | JSON (`flowTuples`) |
| Service mesh | Istio/Envoy access logs, Linkerd `tap` JSON, Cilium Hubble flows (`hubble observe -o json`) |

## Mapping

| Observed | Becomes |
|---|---|
| an IP/ENI that belongs to a known resource | that resource's node, matched by alias `ip:<addr>` or `eni:<id>` (the infra collector should emit these aliases) |
| an unknown private IP | `network_endpoint` node `net:<cidr /24>` (grouped, so the canvas stays readable) |
| a public IP | `network_endpoint` `net:internet`, or `ext:http:<host>` when reverse DNS is known |
| a flow `A -> B:port` | `network` edge, `protocol` = tcp/udp/icmp, `label` = `tcp/5432`, `count` = number of flows, `metadata.bytes` |
| `REJECT` flows | same edge with `metadata.rejected = true` (the UI can style it) |
| mesh request (L7) | `call` edge with `protocol` = http/grpc and `label` = `GET /path`, plus `samples` (status codes, latency) |

Node ids reuse the infra ids (`tf:...`, `k8s:<ns>/<Kind>/<name>`) through aliases, so flows land on existing nodes after `mergeGraphs`.

## Notes

- Aggregate before emitting: one edge per (source, destination, port), never one per flow record.
- Never store payloads; flow logs have none anyway.
