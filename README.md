# noodles

**See how your system flows.** noodles turns any codebase, trace and infrastructure into an n8n-style canvas: nodes with input ports on the left and output ports on the right, connected left to right. Click a node to see what goes in and what comes out.

![Replaying a checkout trace inside the orders service](docs/img/hero-light.png)

- **Every kind of flow**, not just HTTP: function calls, shared state, database reads and writes, HTTP between services, Kafka topics, Kubernetes networking, Terraform dependencies and security group rules.
- **One graph format.** Collectors write [`flowgraph.json`](schema/flowgraph.schema.json); the UI only reads it. A new collector never needs UI changes.
- **Drill down any level**: system > service > module > file > class > function. Double-click to open a node, use the breadcrumbs to go back up.
- **Replay real runs.** Import OpenTelemetry traces and step through a request like an n8n execution, with the real input and output at every node.
- **Zero config, fully local.** Nothing leaves your machine. LLM features are optional and off by default.

Live demo: enable GitHub Pages for this repo (see [Publishing the site](#publishing-the-site)) and open `https://<owner>.github.io/noodles/app/`.

## Install

Requires Node 20 or newer.

```sh
git clone https://github.com/theorjiugovictor/noodles
cd noodles
npm install
npm run build          # builds the UI and bundles the CLI into cli/dist/noodles.mjs
npm link -w cli        # puts `noodles` on your PATH (optional)
```

Without `npm link`, run `node /path/to/noodles/cli/dist/noodles.mjs` instead of `noodles`.

> The npm package name `noodles` belongs to an unrelated project, so do not use `npx noodles`.

## Quick start

```sh
cd ~/code/some-repo
noodles scan .                 # writes flowgraph.json
noodles serve                  # opens http://127.0.0.1:4321
```

Add runtime data from OpenTelemetry:

```sh
noodles import-traces traces.otlp.json --merge flowgraph.json
noodles serve
```

Then switch the top bar to **Trace**, pick an execution and press play (or use ← / →).

### The demo

```sh
npm run demo        # builds the demo graphs and serves the shop example
```

`examples/shop` is a small shop with four services: a TypeScript gateway (Express), orders (Python/FastAPI), payments (Python/Flask) and notifier (TypeScript, Kafka consumer). It also includes Postgres, Kafka, a Terraform plan, Kubernetes manifests and two recorded checkouts (one paid, one declined) in [`examples/shop/traces/checkout.otlp.json`](examples/shop/traces/checkout.otlp.json).

After the merge, each service is a single node across all layers:

- **Code:** its source directory.
- **Infrastructure:** its Kubernetes Deployment.
- **Runtime:** its OpenTelemetry service.

Every trace step lands on the function that produced it. `npm run demo:build` also writes `examples/noodles.flowgraph.json`, which is noodles scanning itself.

## CLI

```
noodles scan <path> [--collector code,infra] [-o flowgraph.json] [--config file] [--exclude glob]... [--no-external] [--llm]
noodles import-traces <otlp.json>... [--merge flowgraph.json] [-o out.json]
noodles serve [flowgraph.json] [--port 4321] [--host 127.0.0.1] [--no-open]
noodles validate <flowgraph.json>
noodles collectors
```

- **`scan`** runs every collector that recognises the target, unless you pass `--collector`. Their outputs are validated, merged on stable ids, and written as one graph.
- **`import-traces`** reads OTLP JSON in any of these shapes:
  - `{"resourceSpans": …}`
  - Tempo `{"batches": …}`
  - an array of documents
  - line-delimited JSON

  With `--merge`, it links spans to static code (by `code.filepath`/`code.function`, `code.namespace` and `http.route`) before merging.
- **`serve`** only listens on `127.0.0.1` and re-reads the graph file on every request, so re-running `scan` and refreshing the page is enough. The Source tab reads snippets from the scanned directory, and only from inside it.

### Optional config

Everything works without configuration. A `noodles.config.json` in the scanned directory, or one passed with `--config`, can set:

```json
{
  "collectors": ["code", "infra"],
  "exclude": ["**/generated/", "legacy/"],
  "include": ["src/", "services/"],
  "settings": { "code": { "includeExternal": false, "skipTests": true } },
  "llm": { "provider": "none" }
}
```

### LLM features (off by default)

There is one interface, `LLMProvider` in [`cli/src/llm/provider.ts`](cli/src/llm/provider.ts).

- The default provider is `none`.
- The `ollama` provider talks to a local model at `http://127.0.0.1:11434`.

When enabled with `"llm": {"provider": "ollama", "model": "llama3.2"}` and `scan --llm`, it writes one-sentence descriptions for the most connected functions and modules that don't have a docstring. No other provider ships, so code is never sent to a remote service unless you add one yourself.

## Using the canvas

| | |
|---|---|
| Click a card | Open the side panel: **Overview** (connections, metadata), **Inputs**, **Outputs** (ports, plus real values per run), **Source** (file and line or resource ref, code preview, open in VS Code) |
| Double-click a card | Drill into it. Breadcrumbs at the top go back up; Backspace goes up one level |
| Dashed cards | Context: nodes outside the current level that connect to it |
| Edge labels | What flows (`POST /orders`, `INSERT orders`, `consume order-created`), how often (`×4`), `↻` when inside a loop. Faded edges are conditional |
| Left sidebar | Search (jumps to and selects the node), layer toggles, connection kinds |
| Trace mode | Pick a run, then step or play. The active node glows, visited nodes and edges are highlighted, `×N` badges show how often a node ran. **Follow** drills into the active node automatically |

Big graphs stay readable:

- The canvas opens at the highest useful level.
- It never renders more than 150 nodes; the least connected nodes are grouped into one "N more" node.
- Edges between hidden nodes are folded into their visible ancestors.

Recursion shows as a self-loop. Shared state (module globals, caches) and datastores are their own nodes, with read and write edges.

## How it fits together

```
schema/       flowgraph.schema.json, TypeScript types, validateGraph(), mergeGraphs()
collectors/   core/ (interface, registry, file walker), code/, otel/, infra/
              netflow/, messaging/, cicd/, org/   (stubs with a spec in their README)
cli/          the `noodles` command and the local server
ui/           React + React Flow (xyflow) + ELK
examples/     the shop demo
site/         the GitHub Pages landing page
```

### The graph format

Every collector produces the same JSON. The full contract is [`schema/flowgraph.schema.json`](schema/flowgraph.schema.json) (JSON Schema 2020-12).

```jsonc
{
  "version": "1.0",
  "nodes": [{
    "id": "code:fn:services/orders/app/main.py#create_order",   // stable across runs and collectors
    "name": "create_order",
    "kind": "function",        // function | module | service | datastore | queue | external_api |
                               // network_endpoint | infra_resource | pipeline | team | system | org
    "layer": "code",           // code | runtime | network | messaging | infra | delivery | org
    "parent": "code:file:services/orders/app/main.py",           // drives drill-down
    "aliases": ["py:services.orders.app.main.create_order"],      // other names for the same thing
    "inputs":  [{ "name": "req", "type": "OrderRequest" }],
    "outputs": [{ "name": "return", "type": "Order" }],
    "source":  { "file": "services/orders/app/main.py", "line": 14 },
    "metadata": { "language": "python" }
  }],
  "edges": [{
    "id": "call:a->b",
    "from": { "node": "a", "port": "return" }, "to": { "node": "b", "port": "req" },
    "kind": "call",            // call | data | network | event | read | write | deploy | depends_on
    "protocol": "http", "label": "POST /orders", "count": 3, "loop": false,
    "samples": [{ "value": { "input": {}, "output": {} } }]
  }],
  "executions": [{
    "id": "otel:4bf92f…", "name": "gateway: POST /checkout", "status": "ok",
    "steps": [{ "id": "s1", "node": "…", "parent": "s0", "via": "<edge id>", "input": {}, "output": {}, "start": 0, "end": 1.2, "status": "ok" }]
  }]
}
```

Conventions:

- `read` edges point from the datastore to the reader, and `write` edges from the writer to the datastore, so data always flows left to right.
- Times are epoch milliseconds.

**Merging** (`mergeGraphs`) is what lets layers meet. Nodes are unified when their ids or `aliases` collide; the first graph keeps its id, and later graphs fill in missing fields. Edges are re-pointed and deduped. The shared alias conventions are:

| Alias | Emitted by |
|---|---|
| `service:<name>` | code service directories (any dir with a manifest), Kubernetes workloads, OTel `service.name`, ECS/Lambda/Cloud Run resources, HTTP calls to bare host names |
| `datastore:<engine>` | code DB clients, OTel `db.system`, RDS/ElastiCache resources |
| `queue:<system>`, `topic:<name>` | code producers/consumers, OTel messaging spans, MSK/SQS/SNS |
| `route:<service>:<METHOD> <path>` | Express/Fastify/Flask/FastAPI/Nest routes, OTel server spans with `http.route` |
| `k8s:cluster` | Kubernetes manifests, EKS/GKE/AKS clusters |

## Collectors

| Name | Status | Reads |
|---|---|---|
| `code` | ✅ | Python, TypeScript, JavaScript (tree-sitter, WASM, no native build). Modules, classes, functions, params as inputs, return types as outputs, call edges (imports, re-exports, `self`/`this`, typed locals, attributes), loops, recursion, globals, DB/HTTP/queue clients, HTTP routes |
| `otel` | ✅ | OTLP JSON traces: services, endpoints, call edges with protocols, datastores, topics, external APIs, one replayable execution per trace |
| `infra` | ✅ | Terraform/OpenTofu `show -json` (state or plan) and raw `.tfstate`; Kubernetes YAML (workloads, Services, Ingress, ConfigMaps/Secrets by key only, PVCs, NetworkPolicies) |
| `netflow` | stub | VPC flow logs, service mesh: [spec](collectors/src/netflow/README.md) |
| `messaging` | stub | Kafka, SQS/SNS, RabbitMQ, AsyncAPI: [spec](collectors/src/messaging/README.md) |
| `cicd` | stub | GitHub Actions, GitLab CI, Argo CD: [spec](collectors/src/cicd/README.md) |
| `org` | stub | CODEOWNERS, Backstage: [spec](collectors/src/org/README.md) |

## Write a collector

A collector is an object with a name and two functions. It reads something and returns a flowgraph.

```ts
// collectors/src/compose/index.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { edgeId, SCHEMA_VERSION, type FlowGraph, type FlowNode, type FlowEdge } from "@noodles/schema";
import type { Collector } from "../core/types.js";

export const composeCollector: Collector = {
  name: "compose",
  description: "docker-compose services and their links",
  implemented: true,

  // Cheap check so `noodles scan` can pick this collector with zero config.
  async detect(target) {
    return fs.access(path.join(target, "docker-compose.yml")).then(() => true, () => false);
  },

  async collect(target) {
    const doc = parse(await fs.readFile(path.join(target, "docker-compose.yml"), "utf8"));
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    for (const [name, svc] of Object.entries<any>(doc.services ?? {})) {
      nodes.push({
        id: `compose:${name}`,               // stable and namespaced
        name,
        kind: "service",
        layer: "infra",
        aliases: [`service:${name}`],        // merges with the code dir and OTel service of the same name
        metadata: { image: svc.image },
      });
      for (const dep of svc.depends_on ?? []) {
        const from = { node: `compose:${name}` };
        const to = { node: `compose:${dep}` };
        edges.push({ id: edgeId("depends_on", from, to), from, to, kind: "depends_on" });
      }
    }
    return { version: SCHEMA_VERSION, nodes, edges, sources: [{ collector: "compose", target }] } satisfies FlowGraph;
  },
};
```

Then register it in [`collectors/src/core/registry.ts`](collectors/src/core/registry.ts). That's all: the CLI validates its output against the schema, merges it with the other collectors, and the UI renders it.

Guidelines:

- **Stable ids**: derive them from names and paths, never from counters or timestamps. Prefix them with a namespace (`compose:`, `tf:`, `k8s:`).
- **Use `aliases`** for cross-layer identity (see the table above) instead of reusing another collector's ids.
- **Use `parent`** for real containment only. It is what drill-down follows.
- **Aggregate**: one edge per (from, to, kind), with `count`, rather than one edge per occurrence.
- **Never copy secrets or large payloads.** Keep samples small and truncated.
- **Add a test** that runs `validateGraph` on your output; see [`collectors/src/infra/infra.test.ts`](collectors/src/infra/infra.test.ts).

## Screenshots

The images in `docs/img` and `site/assets` are generated, not hand-made:

```sh
npm run build && npm run demo:build
npm i -D playwright && npx playwright install chromium   # once; not a project dependency
npm run screenshots          # serves the shop demo and captures map.png, hero-light.png, hero-dark.png
```

To capture your own graph, serve it and pass the URL: `node scripts/screenshots.mjs http://127.0.0.1:4321/`. You can also take a screenshot in the browser: the toolbar's fit-view button and the theme toggle give clean framing in both themes.

## Publishing the site

`.github/workflows/pages.yml` builds the landing page (`site/`) and the canvas with the demo graphs (`/app/`), and deploys them to GitHub Pages on every push to `main`.

To turn it on:

1. Go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.

To build it locally: `npm run build && npm run demo:build && npm run pages`, then serve `site-dist/`.

## Development

```sh
npm install
npm test             # vitest: schema, collectors, view model
npm run typecheck
npm run noodles -- scan examples/shop -o /tmp/shop.json   # run the CLI from source (tsx)
npm run dev -w ui    # UI dev server; put a flowgraph.json in ui/public/ to load it
```

## License

MIT
