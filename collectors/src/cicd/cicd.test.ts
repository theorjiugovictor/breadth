import { describe, expect, it } from "vitest";
import { validateGraph } from "@breadth/schema";
import { builtImages, cicdGraph, deployTargets } from "./index.js";
import { asyncapiGraph } from "../messaging/index.js";
import { parse } from "yaml";

describe("cicd collector", () => {
  it("finds what run scripts deploy and build", () => {
    expect(deployTargets("kubectl -n shop set image deployment/orders orders=x\nhelm upgrade --install payments ./chart\ncd infra/prod\nterraform apply -auto-approve\naws lambda update-function-code --function-name api --zip-file x\ngcloud run deploy web --image x").map((t) => t.alias)).toEqual([
      "service:orders",
      "service:payments",
      "tfroot:infra/prod",
      "service:api",
      "service:web",
    ]);
    expect(builtImages("docker build -t ghcr.io/acme/api:1.2 .", [{ tags: "ghcr.io/acme/web:latest", push: true }])).toEqual(["ghcr.io/acme/api", "ghcr.io/acme/web"]);
  });

  it("maps workflows, jobs, needs, triggers and secrets (names only)", () => {
    const g = cicdGraph(
      [
        {
          path: ".github/workflows/ci.yml",
          text: `
name: ci
on:
  pull_request_target:
  push:
    paths: ["api/**"]
permissions: write-all
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - uses: some/action@v1
      - run: make test
        env:
          TOKEN: \${{ secrets.NPM_TOKEN }}
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: terraform apply -auto-approve
`,
        },
        { path: ".gitlab-ci.yml", text: "stages: [build, deploy]\nbuild:\n  stage: build\n  script: [docker build -t registry/app:1 .]\nship:\n  stage: deploy\n  script: [helm upgrade --install app ./chart]\n" },
      ],
      "repo",
    );
    expect(validateGraph(g).valid).toBe(true);
    const wf = g.nodes.find((n) => n.id === "ci:github:.github/workflows/ci.yml")!;
    expect(wf.inputs?.map((p) => p.name)).toEqual(["pull_request_target", "push"]);
    expect(g.nodes.find((n) => n.id.endsWith("#test"))?.metadata).toMatchObject({ secrets: ["NPM_TOKEN"], uses: ["actions/checkout@v4", "some/action@v1"] });
    expect(g.edges.some((e) => e.kind === "depends_on" && e.from.node.endsWith("#deploy") && e.to.node.endsWith("#test"))).toBe(true);
    expect(g.nodes.find((n) => n.id === "deploy:tfroot:.")?.aliases).toEqual(["tf:root:repo"]);
    expect(g.edges.some((e) => e.kind === "depends_on" && e.from.node.endsWith(".gitlab-ci.yml#ship") && e.to.node.endsWith("#build"))).toBe(true);
    expect(g.edges.some((e) => e.kind === "deploy" && e.to.node === "deploy:service:app")).toBe(true);
  });
});

describe("messaging collector (AsyncAPI)", () => {
  it("reads 2.x publish/subscribe and 3.x operations", () => {
    const v2 = parse(`
asyncapi: 2.6.0
info: { title: Orders Service }
servers: { prod: { url: broker:9092, protocol: kafka } }
channels:
  order-created:
    subscribe:
      message: { $ref: "#/components/messages/OrderCreated" }
  payment-done:
    publish:
      message: { name: PaymentDone }
components:
  messages:
    OrderCreated: { name: OrderCreated }
`);
    const v3 = parse(`
asyncapi: 3.0.0
info: { title: mailer }
servers: { prod: { host: x, protocol: amqp } }
channels:
  emails: { address: send-email }
operations:
  sendIt: { action: receive, channel: { $ref: "#/channels/emails" } }
`);
    const g = asyncapiGraph([
      { path: "orders.yaml", doc: v2 },
      { path: "mailer.yaml", doc: v3 },
    ]);
    expect(validateGraph(g).valid).toBe(true);
    const e = (from: string, to: string) => g.edges.find((x) => x.from.node === from && x.to.node === to);
    expect(e("asyncapi:orders.yaml", "queue:kafka:order-created")?.label).toBe("OrderCreated");
    expect(e("queue:kafka:payment-done", "asyncapi:orders.yaml")?.label).toBe("PaymentDone");
    expect(e("queue:rabbitmq:send-email", "asyncapi:mailer.yaml")).toBeTruthy();
    expect(g.nodes.find((n) => n.id === "asyncapi:orders.yaml")?.aliases).toContain("service:orders");
  });
});
