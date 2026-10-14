import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateGraph, type FlowGraph } from "@noodles/schema";
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

  it("maps terraform resources, modules and references", () => {
    const db = g.nodes.find((n) => n.id === "tf:aws_db_instance.orders")!;
    expect(db.kind).toBe("datastore");
    expect(db.aliases).toContain("datastore:postgresql");
    expect(g.nodes.find((n) => n.id === "tf:module.network.aws_vpc.main")!.parent).toBe("tf:module.network");
    expect(edge(g, "depends_on", "tf:module.network.aws_subnet.private_a", "tf:module.network.aws_vpc.main")).toBeTruthy();
    expect(edge(g, "depends_on", "tf:aws_lb.public", "tf:module.network")).toBeTruthy();
  });

  it("turns security group rules into network edges between the workloads behind them", () => {
    expect(g.nodes.some((n) => n.id.includes("security_group_rule"))).toBe(false);
    // EKS cluster merged with the k8s cluster node, so the canonical id is the terraform one
    expect(edge(g, "network", "tf:aws_eks_cluster.shop", "tf:aws_db_instance.orders")?.label).toBe("tcp/5432");
    expect(edge(g, "network", "net:internet", "tf:aws_lb.public")?.label).toBe("tcp/443");
    expect(edge(g, "network", "tf:aws_lb.public", "tf:aws_lb_listener.https")?.label).toBe("https/443");
  });

  it("maps kubernetes workloads, services, ingress, config and network policies", () => {
    const gw = g.nodes.find((n) => n.id === "k8s:shop/Deployment/gateway")!;
    expect(gw.kind).toBe("service");
    expect(gw.aliases).toContain("service:gateway");
    expect(g.nodes.find((n) => n.id === "k8s:ns/shop")!.parent).toBe("tf:aws_eks_cluster.shop");
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
