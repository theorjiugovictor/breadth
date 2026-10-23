import type { CallSite, FileModel } from "./model.js";

/**
 * Calls into AWS SDKs (boto3, AWS SDK for JavaScript v2 and v3) that name the resource they
 * touch: s3.put_object(Bucket=...), new PutObjectCommand({ Bucket }), table.put_item(...).
 * The resource name comes from a literal, a constant or an environment variable, so the
 * call can be matched with the Terraform resource it is (see link.ts).
 */

export type AwsService = "s3" | "dynamodb" | "sqs" | "sns" | "secretsmanager" | "lambda" | "kinesis";

export interface CloudAccess {
  service: AwsService;
  /** The resource's name (bucket, table, queue name, topic name, secret name, function name). */
  name?: string;
  /** Environment variable the name is read from. */
  env?: string;
  /** IAM-style action: s3:PutObject, dynamodb:Query. */
  action: string;
  mode: "read" | "write" | "call";
}

export const AWS_PACKAGES = /^(boto3|aioboto3|botocore|aws-sdk|@aws-sdk\/.+|github\.com\/aws\/aws-sdk-go.*|software\.amazon\.awssdk.*)$/;

/** The argument that names the resource, per service. */
const RESOURCE_KEYS: [string, AwsService, (v: string) => string][] = [
  ["Bucket", "s3", (v) => v],
  ["TableName", "dynamodb", (v) => v.replace(/^arn:aws[\w-]*:dynamodb:[^:]*:\d*:table\//, "")],
  ["QueueUrl", "sqs", (v) => v.split("/").pop() ?? v],
  ["QueueName", "sqs", (v) => v],
  ["TopicArn", "sns", (v) => v.split(":").pop() ?? v],
  ["SecretId", "secretsmanager", (v) => v.replace(/^arn:aws[\w-]*:secretsmanager:[^:]*:\d*:secret:/, "").replace(/-[A-Za-z0-9]{6}$/, "")],
  ["FunctionName", "lambda", (v) => v.split(":").pop() ?? v],
  ["StreamName", "kinesis", (v) => v],
];

const DYNAMO_ITEM = /^(put_item|get_item|update_item|delete_item|query|scan|batch_writer|batch_get_item|batch_write_item|put|get|update|delete)$/;

/** CamelCase action name for an SDK method or command: put_object -> PutObject, PutObjectCommand -> PutObject, put (DocumentClient) -> PutItem. */
function actionName(service: AwsService, call: CallSite): string {
  const last = call.parts[call.parts.length - 1];
  if (call.isNew && /Command$/.test(last)) return last.replace(/Command$/, "");
  const camel = last.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
  if (service === "dynamodb" && /^(Put|Get|Update|Delete)$/.test(camel)) return `${camel}Item`;
  if (service === "dynamodb" && camel === "BatchWriter") return "BatchWriteItem";
  return camel;
}

function modeOf(action: string): CloudAccess["mode"] | undefined {
  if (/^Invoke/.test(action)) return "call";
  if (/^(Get|List|Query|Scan|Receive|Head|Select|BatchGet|Describe|Download)/.test(action)) return "read";
  if (/^(Put|Delete|Update|Create|Send|Publish|Upload|Copy|Write|BatchWrite|Abort|Complete|Restore|Purge|Change|Modify|Transact)/.test(action)) return "write";
  return undefined;
}

/** Resolve an argument value: literal, "env:X", or "id:name" through the file's constants. */
function resolveArg(f: FileModel, v: string | undefined): { name?: string; env?: string } | undefined {
  if (!v) return undefined;
  if (v.startsWith("id:")) v = f.constants?.[v.slice(3)];
  if (!v) return {};
  if (v.startsWith("env:")) return { env: v.slice(4) };
  return { name: v };
}

/**
 * dynamodb.Table("orders") binds a table object; calls on it (table.put_item) carry no table
 * name. When a file names exactly one table that way, its item calls are taken to use it.
 */
export function dynamoTableOf(f: FileModel): { name?: string; env?: string } | undefined {
  const tables = f.calls.filter((c) => c.parts[c.parts.length - 1] === "Table" && c.parts.length >= 2 && c.kwargs?.["0"]);
  const distinct = [...new Set(tables.map((c) => c.kwargs!["0"]))];
  return distinct.length === 1 ? resolveArg(f, distinct[0]) : undefined;
}

/** A resource name as code or configuration gives it (a queue URL, a topic ARN) -> the plain name. */
export function cleanResourceName(service: string, value: string): string {
  const k = RESOURCE_KEYS.find(([key, svc]) => svc === service && key !== "QueueName");
  return k ? k[2](value) : value;
}

export function cloudAccess(f: FileModel, call: CallSite, dynamoTable?: { name?: string; env?: string }): CloudAccess | undefined {
  const last = call.parts[call.parts.length - 1];
  for (const [key, service, clean] of RESOURCE_KEYS) {
    const raw = call.kwargs?.[key];
    if (!raw) continue;
    const action = actionName(service, call);
    const mode = modeOf(action);
    if (!mode) return undefined;
    const r = resolveArg(f, raw) ?? {};
    return { service, name: r.name ? clean(r.name) : undefined, env: r.env, action: `${service}:${action}`, mode };
  }
  // table.put_item(Item=...) on a Table bound in this file
  if (dynamoTable && call.parts.length >= 2 && DYNAMO_ITEM.test(last) && !call.isNew) {
    const action = actionName("dynamodb", call);
    const mode = modeOf(action);
    if (mode) return { service: "dynamodb", ...dynamoTable, action: `dynamodb:${action}`, mode };
  }
  return undefined;
}
