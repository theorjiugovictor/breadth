<!-- breadth-diff -->
### breadth · what this change does

**12 changes worth a close look** · +6 functions · 1 changed · +2 endpoints · 22 connections added, 1 removed

#### Against the spec
**OpenSpec change `add-bulk-refunds`**: Add bulk refunds · tasks 1/3 · requirements implemented 2/2 (2 by this pull request) <sub>(code in the pull request implements its requirements; branch add-bulk-refunds)</sub>

**Outside the spec change** (4): not reached from the code or targets its requirements name.
- 🔴 postgresql is now reachable from the internet (tcp/5432): PostgreSQL (5432)
- 🔴 shop-payments is now allowed s3:* on *
- 🔴 charge no longer calls risk_score: a check was removed
- 🔴 new datastore shop-refund-receipts

#### Worth a close look
- 🔴 postgresql is now reachable from the internet (tcp/5432): PostgreSQL (5432) <sub>`infra/terraform/data.tf`</sub> · **outside spec change `add-bulk-refunds`**
- 🔴 shop-payments is now allowed s3:* on * <sub>`infra/terraform/iam.tf`</sub> · **outside spec change `add-bulk-refunds`**
- 🔴 charge no longer calls risk_score: a check was removed <sub>`services/payments/app/main.py`</sub> · **outside spec change `add-bulk-refunds`**
- 🔴 mark_refunded now writes to postgresql (UPDATE orders) <sub>`services/orders/app/repository.py`</sub>
- 🔴 store_receipt now writes to shop-refund-receipts (s3:PutObject) <sub>`services/payments/app/receipts.py`</sub>
- 🔴 create_refund now calls the external API api.stripe.com (POST /v1/refunds) <sub>`services/payments/app/stripe_client.py`</sub>
- 🔴 refund_orders now calls load_order inside a loop, and load_order does I/O (database or network) <sub>`services/orders/app/main.py`</sub>
- 🔴 refund_orders now calls mark_refunded inside a loop, and mark_refunded does I/O (database or network) <sub>`services/orders/app/main.py`</sub>
- 🔴 new endpoint POST /orders/refunds in orders <sub>`services/orders/app/main.py`</sub>
- 🔴 new endpoint POST /refunds in payments <sub>`services/payments/app/main.py`</sub>
- 🔴 new datastore shop-refund-receipts <sub>`infra/terraform/receipts.tf`</sub> · **outside spec change `add-bulk-refunds`**
- 🔴 payments can now write to shop-refund-receipts (IAM: s3:*) <sub>`services/payments/app`</sub>

#### Also changes
- 🟠 refund now calls POST /refunds <sub>`services/orders/app/payments.py`</sub>
- 🟠 payments can now read from shop-refund-receipts (IAM: s3:*) <sub>`services/payments/app`</sub>
- ⚪ refund_orders now implements "Support agents can refund many orders at once" <sub>`services/orders/app/main.py`</sub>
- ⚪ POST /orders/refunds now implements "Support agents can refund many orders at once" <sub>`services/orders/app/main.py`</sub>
- ⚪ POST /refunds now implements "Support agents can refund many orders at once" <sub>`services/payments/app/main.py`</sub>
- ⚪ store_receipt now implements "Each refund gets a receipt" <sub>`services/payments/app/receipts.py`</sub>
- ⚪ new infrastructure payments-receipts (aws_iam_role_policy) <sub>`infra/terraform/receipts.tf`</sub>
- ⚪ new finding: charge and refund are nearly identical <sub>`services/orders/app/payments.py`</sub>
- ⚪ new finding: payments may read from shop-refund-receipts, but its code never does <sub>`services/payments/app`</sub>
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
  n6["store_receipt<br/><small>receipts.py</small>"]
  n7["shop-refund-receipts<br/><small>datastore</small>"]
  n8["create_refund<br/><small>stripe_client.py</small>"]
  n9["api.stripe.com<br/><small>external api</small>"]
  n10["refund_orders<br/><small>main.py</small>"]
  n11["load_order<br/><small>repository.py</small>"]
  n12["POST /orders/refunds<br/><small>network endpoint</small>"]
  n13["POST /refunds<br/><small>network endpoint</small>"]
  n14["payments<br/><small>service</small>"]
  n15["refund<br/><small>payments.py</small>"]
  n16["Support agents can refund many orders at once<br/><small>artifact</small>"]
  n17["Each refund gets a receipt<br/><small>artifact</small>"]
  n0 -->|"tcp/5432"| n1
  n3 -.-> n4
  n5 -->|"UPDATE orders"| n1
  n6 -->|"s3:PutObject"| n7
  n8 -->|"POST /v1/refunds"| n9
  n10 --> n11
  n10 --> n5
  n14 -->|"s3:*"| n7
  n15 -->|"POST /refunds"| n13
  n7 -->|"s3:*"| n14
  n10 -->|"depends_on"| n16
  n12 -->|"depends_on"| n16
  n13 -->|"depends_on"| n16
  n6 -->|"depends_on"| n17
  n12 --> n10
  n10 --> n15
  n1 -->|"SELECT orders"| n11
  n16 -->|"depends_on"| n14
  n17 -->|"depends_on"| n14
  classDef added fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef removed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-dasharray:4 3
  classDef changed fill:#fef3c7,stroke:#d97706,color:#78350f
  class n5,n6,n7,n8,n10,n12,n13,n15 added
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
  linkStyle 11 stroke:#16a34a
  linkStyle 12 stroke:#16a34a
  linkStyle 13 stroke:#16a34a
  linkStyle 14 stroke:#16a34a
  linkStyle 15 stroke:#16a34a
```

</details>

✅ Resolves: "Each refund gets a receipt" refers to store_receipt, which does not exist; "Support agents can refund many orders at once" refers to refund_orders, POST /orders/refunds, POST /refunds, which do not exist

<details><summary>All structural changes</summary>

**Added** (8): `refund_orders`, `refund`, `mark_refunded`, `refund`, `store_receipt`, `create_refund`, `POST /orders/refunds`, `POST /refunds`

**Changed** (1): `charge`

</details>

<sub>breadth compared main → add-bulk-refunds by scanning both versions. It maps structure and data flow; dynamic calls and runtime-only behaviour are not visible.</sub>
