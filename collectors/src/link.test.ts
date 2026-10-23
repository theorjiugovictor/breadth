import { describe, expect, it } from "vitest";
import { mergeGraphs, validateGraph, type FlowGraph } from "@breadth/schema";
import "./code/parser-node.js";
import { scanSources } from "./code/scan.js";
import { scanTerraformSources } from "./browser.js";
import { linkCodeToInfra } from "./link.js";
import { k8sGraph, parseK8s } from "./infra/k8s.js";

const edge = (g: FlowGraph, kind: string, from: string, to: string) => g.edges.find((e) => e.kind === kind && e.from.node === from && e.to.node === to);

async function build(code: Record<string, string>, tf: string, k8s?: string): Promise<FlowGraph> {
  const files = Object.entries(code).map(([path, text]) => ({ path, text }));
  const c = await scanSources(files.filter((f) => /\.(py|ts|js)$/.test(f.path)), { rootName: "repo", otherFiles: files.filter((f) => !/\.(py|ts|js)$/.test(f.path)).map((f) => f.path) });
  const graphs = [c, scanTerraformSources([{ path: "main.tf", text: tf }], "repo")];
  if (k8s) graphs.push({ version: "1.0", ...k8sGraph(parseK8s(k8s, "k8s.yaml")) });
  const g = mergeGraphs(...graphs);
  linkCodeToInfra(g);
  expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  return g;
}

describe("linking code to infrastructure", () => {
  it("matches resources named in code with Terraform resources of the same name", async () => {
    const g = await build(
      {
        "svc/requirements.txt": "boto3",
        "svc/app.py": `
import boto3
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table("orders")
BUCKET = "uploads"

def save(key, data):
    s3.put_object(Bucket=BUCKET, Key=key, Body=data)

def load(key):
    return s3.get_object(Bucket="uploads", Key=key)

def find(customer):
    return table.query(KeyConditionExpression=customer)

def elsewhere():
    s3.put_object(Bucket="not-in-terraform", Key="k", Body=b"")
`,
      },
      `
resource "aws_s3_bucket" "uploads" { bucket = "uploads" }
resource "aws_dynamodb_table" "orders" { name = "orders" }`,
    );
    expect(edge(g, "write", "code:fn:svc/app.py#save", "tf:aws_s3_bucket.uploads")?.label).toBe("s3:PutObject");
    expect(edge(g, "read", "tf:aws_s3_bucket.uploads", "code:fn:svc/app.py#load")?.label).toBe("s3:GetObject");
    expect(edge(g, "read", "tf:aws_dynamodb_table.orders", "code:fn:svc/app.py#find")?.label).toBe("dynamodb:Query");
    // not defined in Terraform: stays a node of its own
    expect(g.nodes.find((n) => n.id === "cloud:aws:s3:not-in-terraform")?.kind).toBe("datastore");
    expect(g.nodes.some((n) => n.id === "store:aws")).toBe(false);
    expect(g.nodes.find((n) => n.id === "tf:aws_s3_bucket.uploads")?.aliases).toContain("cloud:aws:s3:uploads");
  });

  it("follows names passed through the environment of a Lambda function or a Kubernetes Deployment", async () => {
    const g = await build(
      {
        "api/package.json": `{"name": "api"}`,
        "api/handler.ts": `
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
const s3 = new S3Client({});
const sqs = new SQSClient({});
export async function handler(event: { id: string }) {
  await s3.send(new PutObjectCommand({ Bucket: process.env.REPORTS_BUCKET, Key: event.id }));
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.JOBS_URL!, MessageBody: event.id }));
}`,
        "worker/requirements.txt": "boto3",
        "worker/main.py": `
import os, boto3
sqs = boto3.client("sqs")
def poll():
    return sqs.receive_message(QueueUrl=os.environ["JOBS_URL"])
`,
      },
      `
resource "aws_s3_bucket" "reports" { bucket = "reports" }
resource "aws_sqs_queue" "jobs" { name = "jobs" }
resource "aws_lambda_function" "api" {
  function_name = "api"
  environment {
    variables = {
      REPORTS_BUCKET = aws_s3_bucket.reports.bucket
      JOBS_URL       = aws_sqs_queue.jobs.url
    }
  }
}`,
      `
apiVersion: apps/v1
kind: Deployment
metadata: { name: worker, namespace: default }
spec:
  template:
    spec:
      containers:
        - name: worker
          env:
            - name: JOBS_URL
              value: https://sqs.eu-west-1.amazonaws.com/123456789012/jobs
`,
    );
    expect(edge(g, "write", "code:fn:api/handler.ts#handler", "tf:aws_s3_bucket.reports")?.metadata?.via_env).toBe("REPORTS_BUCKET");
    expect(edge(g, "event", "code:fn:api/handler.ts#handler", "tf:aws_sqs_queue.jobs")?.label).toBe("sqs:SendMessage");
    expect(edge(g, "event", "tf:aws_sqs_queue.jobs", "code:fn:worker/main.py#poll")?.label).toBe("sqs:ReceiveMessage");
    expect(g.nodes.some((n) => n.id.startsWith("cloud:aws:"))).toBe(false);
  });
});
