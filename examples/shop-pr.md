<!-- breadth-diff -->
### breadth · what this change does

**11 changes worth a close look** · +5 functions · 1 changed · +2 endpoints · 16 connections added, 1 removed

#### Worth a close look
- 🔴 postgresql is now reachable from the internet (tcp/5432): PostgreSQL (5432) <sub>`infra/terraform/data.tf`</sub>
- 🔴 shop-payments is now allowed s3:* on * <sub>`infra/terraform/iam.tf`</sub>
- 🔴 charge no longer calls risk_score: a check was removed <sub>`services/payments/app/main.py`</sub>
- 🔴 mark_refunded now writes to postgresql (UPDATE orders) <sub>`services/orders/app/repository.py`</sub>
- 🔴 create_refund now calls the external API api.stripe.com (POST /v1/refunds) <sub>`services/payments/app/stripe_client.py`</sub>
- 🔴 refund_orders now calls load_order inside a loop, and load_order does I/O (database or network) <sub>`services/orders/app/main.py`</sub>
- 🔴 refund_orders now calls mark_refunded inside a loop, and mark_refunded does I/O (database or network) <sub>`services/orders/app/main.py`</sub>
- 🔴 new endpoint POST /orders/refunds in orders <sub>`services/orders/app/main.py`</sub>
- 🔴 new endpoint POST /refunds in payments <sub>`services/payments/app/main.py`</sub>
- 🔴 new datastore shop-refund-receipts <sub>`infra/terraform/receipts.tf`</sub>
- 🔴 payments can now write to shop-refund-receipts (IAM: s3:*) <sub>`services/payments/app`</sub>

#### Also changes
- 🟠 refund now calls POST /refunds <sub>`services/orders/app/payments.py`</sub>
- 🟠 payments can now read from shop-refund-receipts (IAM: s3:*) <sub>`services/payments/app`</sub>
- ⚪ new infrastructure payments-receipts (aws_iam_role_policy) <sub>`infra/terraform/receipts.tf`</sub>
- ⚪ new finding: charge and refund are nearly identical <sub>`services/orders/app/payments.py`</sub>
- ⚪ new finding: create_refund calls api.stripe.com with no error handling <sub>`services/payments/app/stripe_client.py`</sub>
- ⚪ new finding: refund calls POST /refunds with no error handling <sub>`services/orders/app/payments.py`</sub>

<details open><summary><b>Picture of the change</b> (green added, red removed, amber changed)</summary>

```mermaid
flowchart LR
  n0["Internet<br/><small>network endpoint</small>"]
  n1["postgresql<br/><small>datastore</small>"]
  n2["shop-payments<br/><small>infra resource</small>"]
  n3["charge<br/><small>main.py</small>"]
  n4["risk_score<br/><small>fraud.py</small>"]
  n5["mark_refunded<br/><small>repository.py</small>"]
  n6["create_refund<br/><small>stripe_client.py</small>"]
  n7["api.stripe.com<br/><small>external api</small>"]
  n8["refund_orders<br/><small>main.py</small>"]
  n9["load_order<br/><small>repository.py</small>"]
  n10["POST /orders/refunds<br/><small>network endpoint</small>"]
  n11["POST /refunds<br/><small>network endpoint</small>"]
  n12["shop-refund-receipts<br/><small>datastore</small>"]
  n13["payments<br/><small>service</small>"]
  n14["refund<br/><small>payments.py</small>"]
  n15["payments-receipts<br/><small>infra resource</small>"]
  n0 -->|"tcp/5432"| n1
  n3 -.-> n4
  n5 -->|"UPDATE orders"| n1
  n6 -->|"POST /v1/refunds"| n7
  n8 --> n9
  n8 --> n5
  n13 -->|"s3:*"| n12
  n14 -->|"POST /refunds"| n11
  n12 -->|"s3:*"| n13
  n10 --> n8
  n8 --> n14
  n1 -->|"SELECT orders"| n9
  n15 -->|"depends_on"| n2
  n15 -->|"depends_on"| n12
  classDef added fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef removed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-dasharray:4 3
  classDef changed fill:#fef3c7,stroke:#d97706,color:#78350f
  class n5,n6,n8,n10,n11,n12,n14,n15 added
  class n2,n3 changed
  linkStyle 0 stroke:#16a34a
  linkStyle 1 stroke:#dc2626
  linkStyle 2 stroke:#16a34a
  linkStyle 3 stroke:#16a34a
  linkStyle 4 stroke:#16a34a
  linkStyle 5 stroke:#16a34a
  linkStyle 6 stroke:#16a34a
  linkStyle 7 stroke:#16a34a
  linkStyle 8 stroke:#16a34a
  linkStyle 9 stroke:#16a34a
  linkStyle 10 stroke:#16a34a
  linkStyle 12 stroke:#16a34a
  linkStyle 13 stroke:#16a34a
```

</details>

<details><summary>All structural changes</summary>

**Added** (7): `refund_orders`, `refund`, `mark_refunded`, `refund`, `create_refund`, `POST /orders/refunds`, `POST /refunds`

**Changed** (1): `charge`

</details>

<sub>breadth compared main → add-bulk-refunds by scanning both versions. It maps structure and data flow; dynamic calls and runtime-only behaviour are not visible.</sub>
