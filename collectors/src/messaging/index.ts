import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { edgeId, SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from "@breadth/schema";
import type { Collector, CollectorOptions } from "../core/types.js";
import { walkFiles } from "../core/walk.js";

/**
 * Message contracts from AsyncAPI documents (2.x and 3.x): which application sends to and
 * receives from which channel, over which broker, with which message. Ids match the code
 * collector's (queue:kafka, queue:kafka:<topic>, service:<name>), so declared contracts and
 * code merge, and a contract nobody implements (or code nobody declared) shows up.
 */

type Json = Record<string, any>;

const PROTOCOL: Record<string, string> = { "kafka-secure": "kafka", amqps: "rabbitmq", amqp: "rabbitmq", "secure-mqtt": "mqtt", mqtts: "mqtt", sqs: "sqs", sns: "sns", googlepubsub: "pubsub", ws: "websocket", wss: "websocket", http: "http", https: "http" };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(service|api|app|application)\b/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A $ref inside the same document: '#/components/messages/OrderCreated' -> that object. */
function deref(doc: Json, v: any, depth = 0): any {
  if (!v || typeof v !== "object" || depth > 8) return v;
  const ref = v.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return v;
  const target = ref
    .slice(2)
    .split("/")
    .reduce<any>((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
  return deref(doc, target, depth + 1) ?? v;
}

function refName(v: any): string | undefined {
  return typeof v?.$ref === "string" ? v.$ref.split("/").pop() : undefined;
}

function messageNames(doc: Json, m: any): string[] {
  const one = (x: any) => {
    const r = deref(doc, x);
    return r?.name ?? r?.title ?? refName(x) ?? r?.payload?.title;
  };
  if (!m) return [];
  if (Array.isArray(m?.oneOf)) return m.oneOf.map(one).filter(Boolean);
  if (m && typeof m === "object" && !m.payload && !m.$ref && !m.name) return Object.values(m).map(one).filter(Boolean) as string[];
  return [one(m)].filter(Boolean) as string[];
}

export function asyncapiGraph(files: { path: string; doc: Json }[]): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const addNode = (n: FlowNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  const addEdge = (kind: FlowEdge["kind"], from: string, to: string, extra: Partial<FlowEdge>) => {
    const id = edgeId(kind, { node: from }, { node: to });
    if (!edges.has(id)) edges.set(id, { id, from: { node: from }, to: { node: to }, kind, ...extra });
  };
  for (const { path: file, doc } of files) {
    const version = String(doc.asyncapi ?? "");
    const v3 = version.startsWith("3");
    const title = String(doc.info?.title ?? path.posix.basename(file).replace(/\.(ya?ml|json)$/, ""));
    const servers = Object.values((doc.servers ?? {}) as Json);
    const protocol = String(servers[0]?.protocol ?? doc["x-protocol"] ?? "kafka").toLowerCase();
    const system = PROTOCOL[protocol] ?? protocol;
    const app = addNode({
      id: `asyncapi:${file}`,
      name: title,
      kind: "service",
      layer: "messaging",
      description: doc.info?.description ? String(doc.info.description).split("\n")[0].slice(0, 200) : `AsyncAPI ${version} contract`,
      aliases: [`service:${slug(title)}`, ...(doc["x-service"] ? [`service:${doc["x-service"]}`] : [])],
      source: { file },
      metadata: { platform: "asyncapi", version: doc.info?.version, protocol },
    });
    const broker = addNode({ id: `queue:${system}`, name: system, kind: "queue", layer: "messaging", aliases: [`queue:${system}`], metadata: { system } });
    const channelNode = (key: string, ch: Json) => {
      const name = String((v3 ? ch?.address : undefined) ?? key).replace(/^\//, "");
      return addNode({
        id: `queue:${system}:${name}`,
        name,
        kind: "queue",
        layer: "messaging",
        parent: broker,
        aliases: [`topic:${name}`],
        description: ch?.description ? String(ch.description).split("\n")[0].slice(0, 200) : undefined,
        metadata: { system, topic: name, declared_in: file },
      });
    };
    const link = (topic: string, sends: boolean, messages: string[], op?: string) => {
      const extra = { protocol: system, label: messages.length ? messages.join(", ") : op, metadata: { contract: file, ...(messages.length ? { messages } : {}) } };
      if (sends) addEdge("event", app, topic, extra);
      else addEdge("event", topic, app, extra);
      const n = nodes.get(topic)!;
      if (messages.length) n.outputs = [...new Map([...(n.outputs ?? []), ...messages.map((m) => ({ name: "message", type: m }))].map((p) => [p.type, p])).values()];
    };
    if (v3) {
      const channels = (doc.channels ?? {}) as Json;
      for (const [key, raw] of Object.entries(channels)) channelNode(key, deref(doc, raw));
      for (const [opId, rawOp] of Object.entries((doc.operations ?? {}) as Json)) {
        const op = deref(doc, rawOp);
        const chKey = refName(op?.channel);
        if (!chKey || !channels[chKey]) continue;
        const ch = deref(doc, channels[chKey]);
        const topic = channelNode(chKey, ch);
        const msgs = Array.isArray(op.messages) ? op.messages.flatMap((m: any) => messageNames(doc, m)) : messageNames(doc, ch?.messages);
        link(topic, op.action === "send", msgs, opId);
      }
    } else {
      for (const [key, raw] of Object.entries((doc.channels ?? {}) as Json)) {
        const ch = deref(doc, raw);
        const topic = channelNode(key, ch);
        // 2.x: `subscribe` is what the application sends (others subscribe to it); `publish` is what it receives.
        if (ch?.subscribe) link(topic, true, messageNames(doc, ch.subscribe.message), ch.subscribe.operationId);
        if (ch?.publish) link(topic, false, messageNames(doc, ch.publish.message), ch.publish.operationId);
      }
    }
  }
  return { version: SCHEMA_VERSION, nodes: [...nodes.values()], edges: [...edges.values()] };
}

const CANDIDATE = /\.(ya?ml|json)$/i;

async function documents(target: string, options: CollectorOptions): Promise<{ path: string; doc: Json }[]> {
  const st = await fs.stat(target);
  const root = st.isFile() ? path.dirname(target) : target;
  const list = st.isFile() ? [path.basename(target)] : await walkFiles(root, { exclude: options.exclude, include: options.include, filter: (f) => CANDIDATE.test(f) && !/(^|\/)(package(-lock)?\.json|tsconfig[\w.]*\.json|flowgraph\.json)$/.test(f) });
  const out: { path: string; doc: Json }[] = [];
  for (const rel of list) {
    let text: string;
    try {
      text = options.overlay?.get(path.join(root, rel)) ?? (await fs.readFile(path.join(root, rel), "utf8"));
    } catch {
      continue;
    }
    if (!/["']?asyncapi["']?\s*:/.test(text.slice(0, 2000))) continue;
    try {
      const doc = (/\.json$/i.test(rel) ? JSON.parse(text) : parseYaml(text)) as Json;
      if (doc?.asyncapi && (doc.channels || doc.operations)) out.push({ path: rel, doc });
    } catch {
      options.log?.warn(`messaging: could not parse ${rel}`);
    }
  }
  return out;
}

export const messagingCollector: Collector = {
  name: "messaging",
  description: "AsyncAPI contracts: which application sends to and receives from which topic or queue, with which message",
  implemented: true,
  async detect(target, options = {}) {
    try {
      return (await documents(target, options)).length > 0;
    } catch {
      return false;
    }
  },
  async collect(target, options = {}) {
    const docs = await documents(target, options);
    options.log?.info(`messaging: ${docs.length} AsyncAPI document${docs.length === 1 ? "" : "s"}`);
    const g = asyncapiGraph(docs);
    g.sources = [{ collector: "messaging", target: path.resolve(target), collectedAt: new Date().toISOString() }];
    return g;
  },
};
