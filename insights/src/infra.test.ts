import { describe, expect, it } from "vitest";
import type { FlowGraph } from "@breadth/schema";
import { applyPlan } from "@breadth/collectors";
import { scanTerraformSources } from "@breadth/collectors/browser";
import { describeChanges, runInsights } from "./index.js";
import { portRanges, sensitivePorts } from "./rules/infra-posture.js";

const scan = (main: string): FlowGraph => {
  const g = scanTerraformSources([{ path: "main.tf", text: main }], "infra");
  g.insights = runInsights(g);
  return g;
};

const base = `
resource "aws_security_group" "db" { name = "db" }
resource "aws_security_group" "lb" {
  name = "lb"
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_lb" "web" {
  name            = "web"
  security_groups = [aws_security_group.lb.id]
}
resource "aws_db_instance" "orders" {
  identifier             = "orders"
  engine                 = "postgres"
  instance_class         = "db.t4g.medium"
  storage_encrypted      = true
  deletion_protection    = true
  vpc_security_group_ids = [aws_security_group.db.id]
}
resource "aws_s3_bucket" "logs" { bucket = "logs" }
resource "aws_iam_role" "app" { name = "app" }
resource "aws_lambda_function" "app" {
  function_name = "app"
  role          = aws_iam_role.app.arn
}
`;

describe("infrastructure insights", () => {
  it("parses port labels", () => {
    expect(portRanges("tcp/9092-9098")).toEqual([[9092, 9098]]);
    expect(portRanges("all traffic")).toEqual([[0, 65535]]);
    expect(sensitivePorts("tcp/5432")).toEqual(["PostgreSQL (5432)"]);
    expect(sensitivePorts("tcp/443")).toEqual([]);
  });

  it("flags what the internet can reach, public and unencrypted stores, and broad IAM", () => {
    const g = scan(`${base}
resource "aws_security_group_rule" "debug" {
  type              = "ingress"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  security_group_id = aws_security_group.db.id
  cidr_blocks       = ["0.0.0.0/0"]
}
resource "aws_ebs_volume" "scratch" { size = 10 }
resource "aws_s3_bucket_acl" "logs" {
  bucket = aws_s3_bucket.logs.id
  acl    = "public-read"
}
resource "aws_iam_role_policy" "app" {
  role   = aws_iam_role.app.name
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = "*" }] })
}`);
    const by = (rule: string) => (g.insights ?? []).filter((i) => i.rule === rule).map((i) => [i.severity, i.title]);
    expect(by("internet-exposed")).toEqual([["critical", "orders is reachable from the internet on tcp/5432"]]);
    expect(by("public-data")).toEqual([["critical", "logs is public"]]);
    expect(by("unencrypted-storage")).toEqual([["warning", "aws_ebs_volume.scratch is not encrypted at rest"]]);
    expect(by("broad-iam")).toEqual([["critical", "app can do anything in the account"]]);
  });

  it("does not flag a load balancer serving HTTPS to the internet", () => {
    expect((scan(base).insights ?? []).filter((i) => i.rule === "internet-exposed")).toEqual([]);
  });
});

describe("infrastructure changes", () => {
  const before = scan(base);

  it("describes a Terraform change as what it does", () => {
    const after = scan(
      `${base}
resource "aws_security_group_rule" "debug" {
  type              = "ingress"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  security_group_id = aws_security_group.db.id
  cidr_blocks       = ["0.0.0.0/0"]
}
resource "aws_iam_role_policy" "app" {
  role   = aws_iam_role.app.name
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = ["s3:PutObject"], Resource = "\${aws_s3_bucket.logs.arn}/*" }, { Effect = "Allow", Action = "dynamodb:*", Resource = "*" }] })
}`
        .replace('storage_encrypted      = true', "storage_encrypted      = false")
        .replace('deletion_protection    = true', "deletion_protection    = false")
        .replace('"db.t4g.medium"', '"db.r6g.large"'),
    );
    const r = describeChanges(before, after);
    const lines = r.changes.map((c) => `${c.severity} ${c.text}`);
    expect(lines).toEqual(
      expect.arrayContaining([
        "high orders is now reachable from the internet (tcp/5432): PostgreSQL (5432)",
        "high encryption at rest is turned off for orders (aws_db_instance)",
        "high orders: deletion_protection true → false",
        "medium orders (aws_db_instance): instance_class db.t4g.medium → db.r6g.large",
        "high app can now write to logs (IAM: s3:PutObject)",
        "high app is now allowed dynamodb:* on *",
      ]),
    );
    // the highest-risk changes come first, and the findings behind them are not repeated
    expect(r.changes[0].kind).toBe("internet-exposed");
    expect(lines.some((l) => /new finding: .*(reachable|encrypted|permissions)/.test(l))).toBe(false);
  });

  it("warns when a data store is removed or a plan replaces it", () => {
    const removed = describeChanges(before, scan(base.replace(/resource "aws_s3_bucket" "logs".*\n/, "")));
    expect(removed.changes.map((c) => c.text)).toContain("logs (aws_s3_bucket) is removed from Terraform: applying destroys it and the data in it");

    const planned = scan(base);
    applyPlan(planned, { resource_changes: [{ address: "aws_db_instance.orders", mode: "managed", change: { actions: ["create", "delete"], replace_paths: [["engine"]] } }] });
    const r = describeChanges(before, planned);
    expect(r.changes[0]).toMatchObject({ severity: "high", text: "applying the plan replaces orders because engine changed: the data in it is lost unless restored from a backup" });
  });
});

describe("IAM compared with what the code does", () => {
  it("finds code the role does not allow, and grants the code never uses", async () => {
    const { scanSources, linkCodeToInfra } = await import("@breadth/collectors/browser");
    const code = await scanSources(
      [
        {
          path: "api/handler.py",
          text: `
import os, boto3
s3 = boto3.client("s3")
def handler(event, context):
    s3.put_object(Bucket=os.environ["BUCKET"], Key="k", Body=b"")
`,
        },
      ],
      { rootName: "repo", otherFiles: ["api/requirements.txt"] },
    );
    const infra = scanTerraformSources(
      [
        {
          path: "main.tf",
          text: `
resource "aws_s3_bucket" "files" { bucket = "files" }
resource "aws_sqs_queue" "jobs" { name = "jobs" }
resource "aws_iam_role" "api" { name = "api" }
resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = aws_iam_role.api.arn
  environment {
    variables = { BUCKET = aws_s3_bucket.files.id }
  }
}
resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.name
  policy = jsonencode({ Statement = [
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "\${aws_s3_bucket.files.arn}/*" },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.jobs.arn },
  ] })
}`,
        },
      ],
      "repo",
    );
    const { mergeGraphs } = await import("@breadth/schema");
    const g = mergeGraphs(code, infra);
    linkCodeToInfra(g);
    const titles = runInsights(g, { rules: ["iam-usage"] }).map((i) => `${i.severity} ${i.title}`);
    expect(titles).toEqual(
      expect.arrayContaining([
        "warning api writes to files, but its IAM role does not allow it",
        "info api may read from files, but its code never does",
        "info api may write to jobs, but its code never does",
      ]),
    );
    expect(titles).toHaveLength(3);
  });
});

describe("CI and contract rules", () => {
  it("flags pull_request_target with the PR's code, write-all and unpinned actions", async () => {
    const { cicdGraph } = await import("@breadth/collectors");
    const g = cicdGraph([{ path: ".github/workflows/x.yml", text: "name: x\non: pull_request_target\npermissions: write-all\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n      - uses: evil/thing@v1\n" }]);
    expect(runInsights(g, { rules: ["ci-risk"] }).map((i) => i.severity)).toEqual(["critical", "warning", "info"]);
  });
});

describe("requirement evidence", () => {
  it("reports contradicted, unverified and unresolved requirements, and stale evidence", async () => {
    const { runCollectors } = await import("@breadth/collectors");
    const { behaviourUnits, serviceFingerprint } = await import("./index.js");
    const shop = (await import("node:path")).resolve(__dirname, "../../examples/shop");
    const g = await runCollectors(shop, ["code", "resilience"], { exclude: ["**/generate.mjs", "traces/"] });
    const titles = runInsights(g, { rules: ["evidence-status"] }).map((i) => `${i.severity} ${i.title}`);
    expect(titles).toEqual(
      expect.arrayContaining([
        'critical "Checkout survives a slow database" is contradicted by run 2026-10-20-postgres-down',
        'info "Support agents can refund many orders at once" refers to refund_orders, POST /orders/refunds, which do not exist',
      ]),
    );
    // evidence recorded on the current behaviour is fresh; on different behaviour, stale
    const ev = g.nodes.find((n) => n.id === "evidence:2026-10-20-postgres-latency")!;
    const service = behaviourUnits(g).get("code:fn:services/orders/app/main.py#create_order")!.service;
    ev.metadata = { ...ev.metadata, service, fingerprint: serviceFingerprint(behaviourUnits(g), service) };
    expect(runInsights(g, { rules: ["evidence-status"] }).some((i) => i.id.includes(":stale:"))).toBe(false);
    ev.metadata = { ...ev.metadata, fingerprint: "older" };
    expect(runInsights(g, { rules: ["evidence-status"] }).find((i) => i.id.includes(":stale:"))?.title).toBe(`Evidence for "Checkout survives a slow database" is about older behaviour of ${service}`);
  });
});
