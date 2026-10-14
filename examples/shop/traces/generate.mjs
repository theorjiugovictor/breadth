// Generates checkout.otlp.json: two realistic OTLP/JSON traces through the shop services.
// Run: node examples/shop/traces/generate.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIND = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
const T0 = 1760430000000; // ms, fixed so the file is reproducible

function attr(key, value) {
  if (typeof value === "number") return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "object") return { key, value: { stringValue: JSON.stringify(value) } };
  return { key, value: { stringValue: String(value) } };
}

function makeTrace(traceId, scenario) {
  const spans = [];
  let seq = 0;
  const id = () => (traceId.slice(0, 8) + String(++seq).padStart(8, "0")).slice(0, 16);
  const span = (service, parent, name, kind, start, dur, attrs = {}, error) => {
    const s = {
      service,
      span: {
        traceId,
        spanId: id(),
        parentSpanId: parent?.span.spanId ?? "",
        name,
        kind: KIND[kind],
        startTimeUnixNano: String(Math.round((T0 + start) * 1e6)),
        endTimeUnixNano: String(Math.round((T0 + start + dur) * 1e6)),
        attributes: Object.entries(attrs).map(([k, v]) => attr(k, v)),
        status: error ? { code: 2, message: error } : { code: 1 },
      },
    };
    spans.push(s);
    return s;
  };

  const declined = scenario === "declined";
  const cart = declined
    ? { customerId: "cus_fraud", items: [{ sku: "sku-2", qty: 20 }], coupon: null }
    : { customerId: "cus_42", items: [{ sku: "sku-1", qty: 2 }, { sku: "sku-2", qty: 1 }, { sku: "sku-3", qty: 4 }], coupon: "WELCOME10" };
  const total = declined ? 600 : 53.1;
  const order = declined
    ? { orderId: "a71c09e2", status: "declined", total }
    : { orderId: "5f3b2c1d", status: "paid", total };

  // gateway
  const gw = span("gateway", null, "POST /checkout", "server", 0, declined ? 61 : 148, {
    "http.request.method": "POST",
    "http.route": "/checkout",
    "url.path": "/checkout",
    "http.response.status_code": declined ? 402 : 201,
    "noodles.input": { body: cart },
    "noodles.output": { status: declined ? 402 : 201, body: order },
  }, declined ? "payment declined" : undefined);
  const co = span("gateway", gw, "checkout", "internal", 1, declined ? 59 : 146, {
    "code.function": "checkout",
    "code.filepath": "src/routes/checkout.ts",
    "noodles.input": { cart },
    "noodles.output": order,
  }, declined ? "payment declined" : undefined);
  span("gateway", co, "validateCart", "internal", 1.5, 0.4, {
    "code.function": "validateCart",
    "code.filepath": "src/routes/checkout.ts",
    "noodles.input": { cart },
    "noodles.output": cart,
  });
  const cc = span("gateway", co, "OrdersClient.createOrder", "internal", 2, declined ? 57 : 143, {
    "code.function": "OrdersClient.createOrder",
    "code.filepath": "src/clients/orders.ts",
    "noodles.input": { cart },
    "noodles.output": order,
  });
  const hc = span("gateway", cc, "POST", "client", 2.5, declined ? 56 : 142, {
    "http.request.method": "POST",
    "url.full": "http://orders:8000/orders",
    "server.address": "orders",
    "http.response.status_code": declined ? 402 : 200,
  });

  // orders
  const os = span("orders", hc, "POST /orders", "server", 4, declined ? 53 : 138, {
    "http.request.method": "POST",
    "http.route": "/orders",
    "http.response.status_code": declined ? 402 : 200,
    "noodles.input": { customer_id: cart.customerId, items: cart.items, coupon: cart.coupon },
    "noodles.output": { id: order.orderId, status: order.status, total },
  });
  const cr = span("orders", os, "create_order", "internal", 5, declined ? 51 : 136, {
    "code.function": "create_order",
    "code.namespace": "app.main",
    "code.filepath": "app/main.py",
    "noodles.input": { req: { customer_id: cart.customerId, items: cart.items, coupon: cart.coupon } },
    "noodles.output": { id: order.orderId, customer_id: cart.customerId, total, status: order.status },
  });
  const po = span("orders", cr, "price_order", "internal", 6, 2.2, {
    "code.function": "price_order",
    "code.filepath": "app/pricing.py",
    "noodles.input": { items: cart.items, coupon: cart.coupon },
    "noodles.output": total,
  });
  const prices = { "sku-1": 12.5, "sku-2": 30.0, "sku-3": 4.25 };
  cart.items.forEach((it, i) => {
    span("orders", po, "get_price", "internal", 6.2 + i * 0.4, 0.2, {
      "code.function": "get_price",
      "code.filepath": "app/pricing.py",
      "noodles.input": { sku: it.sku },
      "noodles.output": prices[it.sku],
    });
  });
  if (!declined) {
    const d1 = span("orders", po, "apply_discounts", "internal", 7.6, 0.4, {
      "code.function": "apply_discounts",
      "code.filepath": "app/pricing.py",
      "noodles.input": { total: 59.0, codes: ["WELCOME10"] },
      "noodles.output": 53.1,
    });
    span("orders", d1, "apply_discounts", "internal", 7.8, 0.1, {
      "code.function": "apply_discounts",
      "code.filepath": "app/pricing.py",
      "noodles.input": { total: 53.1, codes: [] },
      "noodles.output": 53.1,
    });
  }
  const ch = span("orders", cr, "charge", "internal", 9, declined ? 40 : 96, {
    "code.function": "charge",
    "code.filepath": "app/payments.py",
    "noodles.input": { customer_id: cart.customerId, amount: total },
    "noodles.output": declined ? { status: "declined", reason: "risk" } : { status: "paid", chargeId: "ch_3PqL9x" },
  });
  const hp = span("orders", ch, "POST", "client", 9.5, declined ? 39 : 95, {
    "http.request.method": "POST",
    "url.full": "http://payments:9000/charges",
    "server.address": "payments",
    "http.response.status_code": declined ? 402 : 200,
  });

  // payments
  const ps = span("payments", hp, "POST /charges", "server", 11, declined ? 35 : 91, {
    "http.request.method": "POST",
    "http.route": "/charges",
    "http.response.status_code": declined ? 402 : 200,
    "noodles.input": { customer: cart.customerId, amount: total },
    "noodles.output": declined ? { status: "declined", reason: "risk" } : { status: "paid", chargeId: "ch_3PqL9x" },
  });
  const pc = span("payments", ps, "charge", "internal", 12, declined ? 33 : 89, {
    "code.function": "charge",
    "code.filepath": "app/main.py",
    "noodles.input": { customer: cart.customerId, amount: total },
    "noodles.output": declined ? { status: "declined", reason: "risk" } : { status: "paid", chargeId: "ch_3PqL9x" },
  }, declined ? "declined: risk score 1.0" : undefined);
  span("payments", pc, "risk_score", "internal", 12.5, 1.2, {
    "code.function": "risk_score",
    "code.filepath": "app/fraud.py",
    "noodles.input": { customer: cart.customerId, amount: total },
    "noodles.output": declined ? 1.0 : 0.0531,
  });
  if (!declined) {
    const sc = span("payments", pc, "create_charge", "internal", 14, 85, {
      "code.function": "create_charge",
      "code.filepath": "app/stripe_client.py",
      "noodles.input": { customer: cart.customerId, amount: total },
      "noodles.output": "ch_3PqL9x",
    });
    span("payments", sc, "POST", "client", 14.5, 84, {
      "http.request.method": "POST",
      "url.full": "https://api.stripe.com/v1/charges",
      "server.address": "api.stripe.com",
      "http.response.status_code": 200,
      "noodles.input": { customer: cart.customerId, amount: Math.round(total * 100), currency: "eur" },
      "noodles.output": { id: "ch_3PqL9x", object: "charge", paid: true, amount: Math.round(total * 100) },
    });
  }

  // back in orders: persist + publish
  const after = declined ? 50 : 106;
  const so = span("orders", cr, "save_order", "internal", after, 6, {
    "code.function": "save_order",
    "code.filepath": "app/repository.py",
    "noodles.input": { order: { id: order.orderId, customer_id: cart.customerId, total, status: order.status } },
    "noodles.output": null,
  });
  span("orders", so, "INSERT shop.orders", "client", after + 0.5, 5, {
    "db.system": "postgresql",
    "db.name": "shop",
    "db.operation": "INSERT",
    "db.sql.table": "orders",
    "db.statement": "INSERT INTO orders (id, customer_id, total, status) VALUES (%s, %s, %s, %s)",
    "server.address": "postgres",
    "noodles.input": { params: [order.orderId, cart.customerId, total, order.status] },
    "noodles.output": { rowcount: 1 },
  });
  if (!declined) {
    const ev = span("orders", cr, "order_created", "internal", after + 7, 3, {
      "code.function": "order_created",
      "code.filepath": "app/events.py",
      "noodles.input": { order: { id: order.orderId, customer_id: cart.customerId, total, status: "paid" } },
      "noodles.output": null,
    });
    const pub = span("orders", ev, "order-created publish", "producer", after + 7.5, 2, {
      "messaging.system": "kafka",
      "messaging.destination.name": "order-created",
      "messaging.operation": "publish",
      "noodles.input": { key: order.orderId, value: { id: order.orderId, customer_id: cart.customerId, total, status: "paid" } },
      "noodles.output": { partition: 2, offset: 18233 },
    });

    // notifier (async, after the HTTP response)
    const cons = span("notifier", pub, "order-created process", "consumer", 160, 240, {
      "messaging.system": "kafka",
      "messaging.destination.name": "order-created",
      "messaging.operation": "process",
      "code.function": "handleOrderCreated",
      "code.filepath": "src/consumer.ts",
      "noodles.input": { order: { id: order.orderId, customer_id: cart.customerId, total } },
      "noodles.output": { emailed: true },
    });
    const se = span("notifier", cons, "sendConfirmation", "internal", 161, 236, {
      "code.function": "sendConfirmation",
      "code.filepath": "src/email.ts",
      "noodles.input": { customerId: cart.customerId, orderId: order.orderId, total },
      "noodles.output": null,
    });
    span("notifier", se, "POST", "client", 162, 234, {
      "http.request.method": "POST",
      "url.full": "https://api.sendgrid.com/v3/mail/send",
      "server.address": "api.sendgrid.com",
      "http.response.status_code": 202,
      "noodles.input": { to: cart.customerId, subject: `Order ${order.orderId} confirmed` },
      "noodles.output": { status: 202 },
    });
  }
  return spans;
}

function toOtlp(spans) {
  const byService = new Map();
  for (const s of spans) {
    if (!byService.has(s.service)) byService.set(s.service, []);
    byService.get(s.service).push(s.span);
  }
  return {
    resourceSpans: [...byService.entries()].map(([service, list]) => ({
      resource: { attributes: [attr("service.name", service), attr("deployment.environment", "demo")] },
      scopeSpans: [{ scope: { name: "noodles-demo" }, spans: list }],
    })),
  };
}

const spans = [
  ...makeTrace("4bf92f3577b34da6a3ce929d0e0e4736", "ok"),
  ...makeTrace("9c1a2b3c4d5e6f708192a3b4c5d6e7f8", "declined").map((s) => ({
    ...s,
    span: {
      ...s.span,
      startTimeUnixNano: String(BigInt(s.span.startTimeUnixNano) + 5_000_000_000n),
      endTimeUnixNano: String(BigInt(s.span.endTimeUnixNano) + 5_000_000_000n),
    },
  })),
];
const out = join(dirname(fileURLToPath(import.meta.url)), "checkout.otlp.json");
writeFileSync(out, JSON.stringify(toOtlp(spans), null, 1) + "\n");
console.log(`wrote ${out} (${spans.length} spans)`);
