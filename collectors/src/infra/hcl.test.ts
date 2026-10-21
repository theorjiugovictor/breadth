import { describe, expect, it } from "vitest";
import { validateGraph, type FlowGraph } from "@breadth/schema";
import { scanTerraformSources } from "../browser.js";
import { parseHcl, type Expr } from "./hcl.js";
import { loadTerraform } from "./terraform-hcl.js";
import { applyPlan } from "./terraform.js";

const tf = (files: Record<string, string>, rootName = "repo"): FlowGraph => {
  const g = scanTerraformSources(Object.entries(files).map(([path, text]) => ({ path, text })), rootName);
  expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  return g;
};
const node = (g: FlowGraph, id: string) => g.nodes.find((n) => n.id === id);
const edge = (g: FlowGraph, kind: string, from: string, to: string) => g.edges.find((e) => e.kind === kind && e.from.node === from && e.to.node === to);

describe("HCL parser", () => {
  it("parses blocks, attributes, comments and one-line blocks", () => {
    const body = parseHcl(`
# comment
// another
/* block
   comment */
resource "aws_s3_bucket" "a" {
  bucket = "x" # trailing
  tags   = { Name = "x", "kubernetes.io/role" = 1 }
  lifecycle { prevent_destroy = true }
}
terraform { required_providers { aws = { source = "hashicorp/aws" } } }
`);
    expect(body.blocks.map((b) => [b.type, b.labels, b.line])).toEqual([
      ["resource", ["aws_s3_bucket", "a"], 6],
      ["terraform", [], 11],
    ]);
    const [res] = body.blocks;
    expect(res.body.attrs.map((a) => a.name)).toEqual(["bucket", "tags"]);
    expect(res.body.blocks[0].body.attrs[0].expr).toEqual({ t: "lit", v: true });
  });

  it("parses the expression language", () => {
    const e = (src: string): Expr => parseHcl(`x = ${src}\n`).attrs[0].expr;
    expect(e(`a.b[0].c`)).toEqual({ t: "get", obj: { t: "index", obj: { t: "get", obj: { t: "var", name: "a" }, name: "b" }, index: { t: "lit", v: 0 } }, name: "c" });
    expect(e(`aws_subnet.x[*].id`)).toMatchObject({ t: "get", name: "id", obj: { t: "splat" } });
    expect(e(`var.on ? 1 : 0`)).toMatchObject({ t: "cond" });
    expect(e(`1 + 2 * 3 == 7 && !false`)).toMatchObject({ t: "binary", op: "&&" });
    expect(e(`[for s in var.l : upper(s) if s != ""]`)).toMatchObject({ t: "for", valVar: "s", object: false });
    expect(e(`{ for k, v in var.m : k => v... }`)).toMatchObject({ t: "for", keyVar: "k", object: true });
    expect(e(`"a-\${var.b}-%{if var.c}c%{endif}"`)).toMatchObject({ t: "tmpl" });
    expect(e(`"$\${literal}"`)).toEqual({ t: "lit", v: "${literal}" });
    expect(e(`provider::aws::arn_parse("x")`)).toMatchObject({ t: "call", name: "provider::aws::arn_parse" });
    expect(e(`concat(a, b...)`)).toMatchObject({ t: "call", args: [{}, {}] });
    expect(e(`[
      1,
      2,
    ]`)).toEqual({ t: "tuple", items: [{ t: "lit", v: 1 }, { t: "lit", v: 2 }] });
  });

  it("parses heredocs, indented heredocs and escapes", () => {
    const body = parseHcl(`a = <<EOT
hello \${name}
EOT
b = <<-EOT
    {"x": 1}
  EOT
c = "tab\\tquote\\"\\u00e9"
`);
    expect(body.attrs[0].expr).toMatchObject({ t: "tmpl", parts: ["hello ", { t: "var", name: "name" }, "\n"] });
    expect(body.attrs[1].expr).toEqual({ t: "lit", v: '{"x": 1}\n' });
    expect(body.attrs[2].expr).toEqual({ t: "lit", v: 'tab\tquote"é' });
  });

  it("reports syntax errors with a line", () => {
    expect(() => parseHcl(`a = 1\nresource "x" {\n`)).toThrow(/line \d+/);
    expect(() => parseHcl(`a = = 1`)).toThrow();
  });
});

describe("terraform source", () => {
  const files = {
    "variables.tf": `
variable "env" { default = "prod" }
variable "size" {}
variable "on" { default = true }
locals {
  prefix = "shop-\${var.env}"
  names  = [for n in ["a", "b"] : upper(n)]
}`,
    "terraform.tfvars": `size = "db.r6g.large"`,
    "prod.tfvars": `size = "ignored"`,
    "main.tf": `
module "net" {
  source = "./modules/net"
  name   = local.prefix
}
module "registry" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}
resource "aws_db_instance" "main" {
  identifier             = "\${local.prefix}-db"
  engine                 = "postgres"
  instance_class         = var.size
  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = module.net.subnet_group
  tags                   = { Names = join(",", local.names) }
}
resource "aws_security_group" "db" {
  name   = "db"
  vpc_id = module.registry.vpc_id
}
resource "aws_s3_bucket" "flagged" {
  count  = var.on ? 0 : 1
  bucket = "never"
}
resource "aws_sqs_queue" "each" {
  for_each = toset(["a", "b"])
  name     = "q-\${each.key}"
}`,
    "modules/net/main.tf": `
variable "name" {}
resource "aws_db_subnet_group" "this" { name = var.name }
output "subnet_group" { value = aws_db_subnet_group.this.name }`,
  };
  const [root] = loadTerraform(Object.entries(files).map(([path, text]) => ({ path, text })));

  it("finds root modules, follows local modules and evaluates what the configuration decides", () => {
    expect(root.dir).toBe(".");
    expect(root.modules.map((m) => [m.address, m.local])).toEqual([["module.net", true], ["module.registry", false]]);
    const db = root.resources.find((r) => r.address === "aws_db_instance.main")!;
    expect(db.values).toMatchObject({ identifier: "shop-prod-db", instance_class: "db.r6g.large", tags: { Names: "A,B" }, vpc_security_group_ids: ["${aws_security_group.db.id}"] });
    expect(db.file).toBe("main.tf");
    expect(db.line).toBe(10);
    // through the module output to the resource inside the module
    expect([...db.refs].sort()).toEqual(["aws_security_group.db.id", "module.net.aws_db_subnet_group.this.name"]);
    expect(root.resources.find((r) => r.address === "module.net.aws_db_subnet_group.this")!.values.name).toBe("shop-prod");
  });

  it("skips resources switched off with count = 0, keeps for_each ones with unknown names", () => {
    expect(root.resources.some((r) => r.address === "aws_s3_bucket.flagged")).toBe(false);
    expect(root.resources.find((r) => r.address === "aws_sqs_queue.each")!.values.name).toBe("q-${?}");
  });

  it("builds a graph with module nodes, registry modules and readable names", () => {
    const g = tf(files);
    expect(node(g, "tf:aws_db_instance.main")).toMatchObject({ name: "shop-prod-db", parent: "tf:root:repo", source: { file: "main.tf", line: 10 } });
    expect(node(g, "tf:module.registry")).toMatchObject({ kind: "module", metadata: { module_source: "terraform-aws-modules/vpc/aws" } });
    expect(edge(g, "depends_on", "tf:aws_security_group.db", "tf:module.registry")).toBeTruthy();
    expect(edge(g, "depends_on", "tf:aws_db_instance.main", "tf:module.net.aws_db_subnet_group.this")).toBeTruthy();
    // an unresolved name falls back to the address, never to a template
    expect(node(g, "tf:aws_sqs_queue.each")?.name).toBe("aws_sqs_queue.each");
    expect(node(g, "tf:aws_sqs_queue.each")?.aliases).toBeUndefined();
  });

  it("keeps several root modules apart", () => {
    const g = tf({
      "envs/prod/main.tf": `module "app" {\n  source = "../../modules/app"\n  env = "prod"\n}`,
      "envs/staging/main.tf": `module "app" {\n  source = "../../modules/app"\n  env = "staging"\n}`,
      "modules/app/main.tf": `variable "env" {}\nresource "aws_sqs_queue" "jobs" { name = "jobs-\${var.env}" }`,
    });
    expect(node(g, "tf:envs/prod/module.app.aws_sqs_queue.jobs")?.name).toBe("jobs-prod");
    expect(node(g, "tf:envs/staging/module.app.aws_sqs_queue.jobs")?.name).toBe("jobs-staging");
    expect(node(g, "tf:root:envs/prod")).toBeTruthy();
    expect(g.nodes.some((n) => n.id.startsWith("tf:modules/"))).toBe(false);
  });

  it("skips files it cannot parse and says so", () => {
    const warnings: string[] = [];
    const roots = loadTerraform([{ path: "a.tf", text: `resource "x" "y" {` }, { path: "b.tf", text: `resource "aws_sqs_queue" "q" {}` }], { warn: (m) => warnings.push(m) });
    expect(roots[0].resources.map((r) => r.address)).toEqual(["aws_sqs_queue.q"]);
    expect(warnings[0]).toMatch(/a\.tf.*line/);
  });
});

describe("terraform IAM", () => {
  const g = tf({
    "main.tf": `
resource "aws_s3_bucket" "uploads" { bucket = "uploads" }
resource "aws_dynamodb_table" "orders" { name = "orders" }
resource "aws_sqs_queue" "jobs" { name = "jobs" }
resource "aws_iam_role" "api" { name = "api" }
resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = aws_iam_role.api.arn
}
resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}
data "aws_iam_policy_document" "api" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["\${aws_s3_bucket.uploads.arn}/*"]
  }
  statement {
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.orders.arn, "\${aws_dynamodb_table.orders.arn}/index/*"]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}
resource "aws_iam_role" "worker" {
  name = "worker"
  inline_policy {
    name   = "all"
    policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = "*" }] })
  }
}
resource "aws_ecs_task_definition" "worker" {
  family             = "worker"
  task_role_arn      = aws_iam_role.worker.arn
  execution_role_arn = aws_iam_role.api.arn
}
resource "aws_ecs_service" "worker" {
  name            = "worker"
  task_definition = aws_ecs_task_definition.worker.arn
}
resource "aws_iam_role_policy_attachment" "s3" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3FullAccess"
}`,
  });

  it("turns policies into read and write access from the workload that runs as the role", () => {
    expect(edge(g, "write", "tf:aws_lambda_function.api", "tf:aws_s3_bucket.uploads")?.metadata).toMatchObject({ via: "iam", actions: ["s3:PutObject"] });
    expect(edge(g, "read", "tf:aws_s3_bucket.uploads", "tf:aws_lambda_function.api")?.label).toBe("s3:GetObject");
    expect(edge(g, "read", "tf:aws_dynamodb_table.orders", "tf:aws_lambda_function.api")?.label).toBe("dynamodb:Query");
    expect(edge(g, "write", "tf:aws_lambda_function.api", "tf:aws_dynamodb_table.orders")).toBeUndefined();
    expect(edge(g, "event", "tf:aws_lambda_function.api", "tf:aws_sqs_queue.jobs")).toBeTruthy();
  });

  it("flags broad grants and credits an ECS service, not its execution role", () => {
    expect(node(g, "tf:aws_iam_role.worker")?.metadata).toMatchObject({ iam_broad: ["* on *"], used_by: ["worker"] });
    expect(node(g, "tf:aws_iam_role.api")?.metadata).toMatchObject({ iam_broad: ["s3:* on *"], used_by: ["api"] });
  });
});

describe("terraform security posture", () => {
  it("marks public and unencrypted data stores", () => {
    const g = tf({
      "main.tf": `
resource "aws_db_instance" "open" {
  identifier          = "open"
  engine              = "mysql"
  publicly_accessible = true
}
resource "aws_db_instance" "safe" {
  identifier        = "safe"
  engine            = "postgres"
  storage_encrypted = true
}
variable "encrypt" {}
resource "aws_db_instance" "unknown" {
  identifier        = "unknown"
  storage_encrypted = var.encrypt
}
resource "aws_s3_bucket" "site" { bucket = "site" }
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "\${aws_s3_bucket.site.arn}/*" }] })
}
resource "aws_s3_bucket" "blocked" {
  bucket = "blocked"
  acl    = "public-read"
}
resource "aws_s3_bucket_public_access_block" "blocked" {
  bucket                  = aws_s3_bucket.blocked.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}`,
    });
    expect(node(g, "tf:aws_db_instance.open")?.metadata).toMatchObject({ public: true, public_reason: "publicly_accessible = true", encrypted: false });
    expect(node(g, "tf:aws_db_instance.safe")?.metadata?.encrypted).toBe(true);
    expect(node(g, "tf:aws_db_instance.unknown")?.metadata?.encrypted).toBeUndefined();
    expect(node(g, "tf:aws_s3_bucket.site")?.metadata).toMatchObject({ public: true, public_reason: "bucket policy allows anyone" });
    expect(node(g, "tf:aws_s3_bucket.blocked")?.metadata?.public).toBeUndefined();
  });

  it("reads security groups, GCP firewalls and Azure network security groups", () => {
    const g = tf({
      "main.tf": `
resource "aws_security_group" "bastion" {
  name = "bastion"
  dynamic "ingress" {
    for_each = [22]
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}
resource "aws_instance" "bastion" {
  vpc_security_group_ids = [aws_security_group.bastion.id]
}
resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.bastion.id
  cidr_ipv4         = "10.0.0.0/8"
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}
resource "google_compute_instance" "vm" {
  name = "vm"
  tags = ["ssh"]
}
resource "google_compute_firewall" "ssh" {
  name          = "allow-ssh"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["ssh"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
resource "azurerm_network_security_group" "web" {
  name = "web"
  security_rule {
    name                       = "rdp"
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_address_prefix      = "*"
    destination_port_range     = "3389"
  }
}`,
    });
    // the port comes from a dynamic block's iterator: unknown, so the rule covers all of its range
    expect(edge(g, "network", "net:internet", "tf:aws_instance.bastion")).toBeTruthy();
    expect(edge(g, "network", "net:10.0.0.0/8", "tf:aws_instance.bastion")?.label).toBe("tcp/22");
    expect(edge(g, "network", "net:internet", "tf:google_compute_instance.vm")?.label).toBe("tcp/22");
    expect(edge(g, "network", "net:internet", "tf:azurerm_network_security_group.web")?.label).toBe("tcp/3389");
  });

  it("marks what a plan replaces or destroys, matching the root module automatically", () => {
    const g = tf({ "infra/main.tf": `resource "aws_db_instance" "main" { identifier = "db" }\nresource "aws_sqs_queue" "q" { name = "q" }` });
    const n = applyPlan(g, {
      resource_changes: [
        { address: "aws_db_instance.main", mode: "managed", change: { actions: ["delete", "create"], replace_paths: [["engine"], ["engine", "version"]] } },
        { address: "aws_sqs_queue.q", mode: "managed", change: { actions: ["no-op"] } },
      ],
    });
    expect(n).toBe(1);
    expect(node(g, "tf:infra/aws_db_instance.main")?.metadata).toMatchObject({ plan_action: "replace", plan_reason: ["engine"] });
    expect(node(g, "tf:infra/aws_sqs_queue.q")?.metadata?.plan_action).toBeUndefined();
  });
});
