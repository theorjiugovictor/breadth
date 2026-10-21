import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateGraph, type FlowGraph } from "@breadth/schema";
import { infraCollector } from "./index.js";
import { parseTerraform } from "./terraform.js";
import { parseK8s } from "./k8s.js";

const infra = path.resolve(__dirname, "../../../examples/shop/infra");
const edge = (g: FlowGraph, kind: string, from: string, to: string) => g.edges.find((e) => e.kind === kind && e.from.node === from && e.to.node === to);

describe("infra collector", async () => {
  const g = await infraCollector.collect(infra, {});

  it("produces a valid graph", () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  });

  it("maps terraform resources, modules and references from .tf source", () => {
    const db = g.nodes.find((n) => n.id === "tf:terraform/aws_db_instance.orders")!;
    expect(db.kind).toBe("datastore");
    expect(db.name).toBe("shop-orders");
    expect(db.aliases).toContain("datastore:postgresql");
    expect(db.source).toMatchObject({ file: "terraform/data.tf", line: 6, resource_ref: "aws_db_instance.orders" });
    expect(db.metadata).toMatchObject({ encrypted: true, settings: { instance_class: "db.t4g.medium", deletion_protection: true } });
    expect(g.nodes.find((n) => n.id === "tf:terraform/module.network.aws_vpc.main")!.parent).toBe("tf:terraform/module.network");
    expect(edge(g, "depends_on", "tf:terraform/module.network.aws_subnet.private_a", "tf:terraform/module.network.aws_vpc.main")).toBeTruthy();
    // module outputs resolve to the resources behind them
    expect(edge(g, "depends_on", "tf:terraform/aws_lb.public", "tf:terraform/module.network.aws_subnet.public_a")).toBeTruthy();
  });

  it("turns security group rules into network edges between the workloads behind them", () => {
    expect(g.nodes.some((n) => n.id.includes("security_group_rule"))).toBe(false);
    // EKS cluster merged with the k8s cluster node, so the canonical id is the terraform one
    expect(edge(g, "network", "tf:terraform/aws_eks_cluster.shop", "tf:terraform/aws_db_instance.orders")?.label).toBe("tcp/5432");
    expect(edge(g, "network", "net:internet", "tf:terraform/aws_lb.public")?.label).toBe("tcp/443");
    expect(edge(g, "network", "tf:terraform/aws_lb.public", "tf:terraform/aws_lb_listener.https")?.label).toBe("https/443");
  });

  it("draws IAM permissions from the pods that assume the role", () => {
    const read = edge(g, "read", "tf:terraform/aws_secretsmanager_secret.stripe", "k8s:shop/Deployment/payments");
    expect(read?.metadata).toMatchObject({ via: "iam", actions: ["secretsmanager:GetSecretValue"] });
    expect(edge(g, "event", "k8s:shop/Deployment/orders", "tf:terraform/aws_msk_cluster.events")?.label).toBe("kafka-cluster:WriteData");
    expect(g.nodes.find((n) => n.id === "tf:terraform/aws_iam_role.payments")!.metadata?.used_by).toEqual(["payments"]);
  });

  it("maps kubernetes workloads, services, ingress, config and network policies", () => {
    const gw = g.nodes.find((n) => n.id === "k8s:shop/Deployment/gateway")!;
    expect(gw.kind).toBe("service");
    expect(gw.aliases).toContain("service:gateway");
    expect(g.nodes.find((n) => n.id === "k8s:ns/shop")!.parent).toBe("tf:terraform/aws_eks_cluster.shop");
    expect(edge(g, "network", "k8s:shop/Service/orders", "k8s:shop/Deployment/orders")).toBeTruthy();
    expect(edge(g, "network", "k8s:shop/Ingress/shop", "k8s:shop/Service/gateway")?.label).toBe("shop.example.com/");
    expect(edge(g, "network", "k8s:shop/Deployment/gateway", "k8s:shop/Service/orders")?.label).toBe("ORDERS_URL");
    expect(edge(g, "depends_on", "k8s:shop/Deployment/payments", "k8s:shop/Secret/stripe")).toBeTruthy();
    expect(edge(g, "network", "k8s:shop/Deployment/orders", "k8s:shop/Deployment/payments")?.label).toBe("tcp/9000");
  });

  it("never copies secret values", () => {
    const secret = g.nodes.find((n) => n.id === "k8s:shop/Secret/stripe")!;
    expect(JSON.stringify(secret)).not.toContain("replace-me");
    expect(secret.outputs).toEqual([{ name: "STRIPE_KEY" }]);
  });
});

describe("terraform formats", () => {
  it("reads `terraform show -json` plans, including what applying does", async () => {
    const plan = path.resolve(__dirname, "fixtures/plan/plan.json");
    const p = await infraCollector.collect(plan, {});
    expect(validateGraph(p).valid).toBe(true);
    expect(p.nodes.find((n) => n.id === "tf:aws_db_instance.orders")?.aliases).toContain("datastore:postgresql");
    expect(edge(p, "depends_on", "tf:aws_lb.public", "tf:module.network")).toBeTruthy();
    expect(edge(p, "network", "tf:aws_eks_cluster.shop", "tf:aws_db_instance.orders")?.label).toBe("tcp/5432");
    const r = parseTerraform({
      format_version: "1.2",
      planned_values: { root_module: { resources: [{ address: "aws_db_instance.a", mode: "managed", type: "aws_db_instance", name: "a", values: {} }] } },
      resource_changes: [
        { address: "aws_db_instance.a", mode: "managed", type: "aws_db_instance", name: "a", change: { actions: ["delete", "create"], replace_paths: [["engine"]] } },
        { address: "aws_s3_bucket.gone", mode: "managed", type: "aws_s3_bucket", name: "gone", change: { actions: ["delete"], before: { bucket: "gone" } } },
      ],
    })!;
    expect(r.map((x) => [x.address, x.action, x.reason])).toEqual([
      ["aws_db_instance.a", "replace", ["engine"]],
      ["aws_s3_bucket.gone", "delete", undefined],
    ]);
  });

  it("reads raw tfstate v4 with dependencies", () => {
    const r = parseTerraform({
      version: 4,
      terraform_version: "1.8.0",
      resources: [
        { mode: "managed", type: "aws_vpc", name: "main", instances: [{ attributes: { id: "vpc-1" } }] },
        { mode: "managed", type: "aws_subnet", name: "a", instances: [{ attributes: { id: "subnet-1", vpc_id: "vpc-1" }, dependencies: ["aws_vpc.main"] }] },
        { mode: "data", type: "aws_ami", name: "x", instances: [{ attributes: {} }] },
      ],
    })!;
    expect(r.map((x) => x.address)).toEqual(["aws_vpc.main", "aws_subnet.a"]);
    expect([...r[1].refs]).toEqual(["aws_vpc.main"]);
  });

  it("ignores non-terraform JSON and parses k8s List objects", () => {
    expect(parseTerraform({ name: "x" })).toBeUndefined();
    const objs = parseK8s("apiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: ConfigMap\n    metadata: { name: a }\n", "x.yaml");
    expect(objs.map((o) => o.kind)).toEqual(["ConfigMap"]);
  });
});
