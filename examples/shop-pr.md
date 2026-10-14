<!-- breadth-diff -->
### breadth · what this change does

**7 changes worth a close look** · +5 functions · 1 changed · +2 endpoints · 11 connections added, 1 removed

#### Worth a close look
- 🔴 charge no longer calls risk_score: a check was removed <sub>`services/payments/app/main.py`</sub>
- 🔴 mark_refunded now writes to postgresql (UPDATE orders) <sub>`services/orders/app/repository.py`</sub>
- 🔴 create_refund now calls the external API api.stripe.com (POST /v1/refunds) <sub>`services/payments/app/stripe_client.py`</sub>
- 🔴 refund_orders now calls load_order inside a loop, and load_order does I/O (database or network) <sub>`services/orders/app/main.py`</sub>
- 🔴 refund_orders now calls mark_refunded inside a loop, and mark_refunded does I/O (database or network) <sub>`services/orders/app/main.py`</sub>
- 🔴 new endpoint POST /orders/refunds in orders <sub>`services/orders/app/main.py`</sub>
- 🔴 new endpoint POST /refunds in payments <sub>`services/payments/app/main.py`</sub>

#### Also changes
- 🟠 refund now calls POST /refunds <sub>`services/orders/app/payments.py`</sub>
- ⚪ new finding: charge and refund are nearly identical <sub>`services/orders/app/payments.py`</sub>
- ⚪ new finding: create_refund calls api.stripe.com with no error handling <sub>`services/payments/app/stripe_client.py`</sub>
- ⚪ new finding: refund calls POST /refunds with no error handling <sub>`services/orders/app/payments.py`</sub>

<details open><summary><b>Picture of the change</b> (green added, red removed, amber changed)</summary>

```mermaid
flowchart LR
  n0["charge<br/><small>main.py</small>"]
  n1["risk_score<br/><small>fraud.py</small>"]
  n2["mark_refunded<br/><small>repository.py</small>"]
  n3["postgresql<br/><small>datastore</small>"]
  n4["create_refund<br/><small>stripe_client.py</small>"]
  n5["api.stripe.com<br/><small>external api</small>"]
  n6["refund_orders<br/><small>main.py</small>"]
  n7["load_order<br/><small>repository.py</small>"]
  n8["POST /orders/refunds<br/><small>network endpoint</small>"]
  n9["POST /refunds<br/><small>network endpoint</small>"]
  n10["refund<br/><small>payments.py</small>"]
  n0 -.-> n1
  n2 -->|"UPDATE orders"| n3
  n4 -->|"POST /v1/refunds"| n5
  n6 --> n7
  n6 --> n2
  n10 -->|"POST /refunds"| n9
  n8 --> n6
  n6 --> n10
  n3 -->|"SELECT orders"| n7
  classDef added fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef removed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-dasharray:4 3
  classDef changed fill:#fef3c7,stroke:#d97706,color:#78350f
  class n2,n4,n6,n8,n9,n10 added
  class n0 changed
  linkStyle 0 stroke:#dc2626
  linkStyle 1 stroke:#16a34a
  linkStyle 2 stroke:#16a34a
  linkStyle 3 stroke:#16a34a
  linkStyle 4 stroke:#16a34a
  linkStyle 5 stroke:#16a34a
  linkStyle 6 stroke:#16a34a
  linkStyle 7 stroke:#16a34a
```

</details>

<details><summary>All structural changes</summary>

**Added** (7): `refund_orders`, `refund`, `mark_refunded`, `refund`, `create_refund`, `POST /orders/refunds`, `POST /refunds`

**Changed** (1): `charge`

</details>

<sub>breadth compared main → add-bulk-refunds by scanning both versions. It maps structure and data flow; dynamic calls and runtime-only behaviour are not visible.</sub>
