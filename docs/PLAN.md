# Noodles: v1 plan (proposal, waiting for approval)

Noodles turns a codebase or a distributed system into an n8n-style canvas. Everything
goes through one contract, `flowgraph.json`, defined in
[`schema/flowgraph.schema.json`](../schema/flowgraph.schema.json).

## 1. Stack

| Area | Choice | Why |
|---|---|---|
| Language | **TypeScript everywhere** (Node 20+) | One toolchain for CLI, collectors and UI, and the graph types are shared. |
| Packaging | npm workspaces: `schema`, `collectors`, `cli`, `ui` | Matches the requested layout. |
| Parsing | `web-tree-sitter` (WASM) + prebuilt Python/TS/TSX/JS grammars | No native compile step, so `npx noodles scan .` works anywhere. |
| Validation | `ajv` (JSON Schema 2020-12) | Every collector's output and every merge result gets validated. |
| UI | React 18 + `@xyflow/react` 12 + `elkjs` (layered, left to right) + Vite | As specified. |
| Serve | Built UI as static files, served by Node `http` on `127.0.0.1` | Fully local. The graph is served at `/flowgraph.json`. |

## 2. Layout

```
schema/       flowgraph.schema.json, generated TS types, validate(), merge(), ids helpers
collectors/
  core/       Collector interface, registry, file walker (respects .gitignore)
  code/       tree-sitter static collector (python, typescript/javascript)
  otel/       OTLP JSON trace importer
  infra/      terraform/opentofu state+plan JSON, kubernetes manifests
  netflow/    STUB + README (VPC flow logs, service mesh)
  messaging/  STUB + README (Kafka, SQS, producers/consumers)
  cicd/       STUB + README (GitHub Actions, GitLab CI, ...)
  org/        STUB + README (CODEOWNERS -> team nodes)
cli/          `noodles` binary: scan, import-traces, serve, validate; optional LLM provider
ui/           React app
examples/     sample microservice project + fake OTLP trace + terraform/k8s files
docs/
```

## 3. Collector contract

```ts
interface Collector {
  name: string;                                  // "code", "otel", "infra", ...
  detect?(target: string): Promise<boolean>;     // used for zero-config auto-selection
  collect(target: string, options: CollectorOptions): Promise<FlowGraph>;
}
```

- The registry auto-detects collectors when `--collector` is not given.
- `merge(a, b)` is pure and deterministic:
  - Nodes are unified by `id`, or by colliding `aliases`. For example, an OTel service
    `checkout` merges with a k8s Deployment that carries the alias `service:checkout`.
  - Ports are unioned by name. Metadata is shallow-merged. A non-empty value wins over
    an empty one.
  - Edges are deduped by `id`. Counts are summed and samples are concatenated (capped).
  - Edge endpoints that point at an alias are rewritten to the canonical id.
  - Executions are deduped by `id`.
- Collectors never know about the UI. The UI only knows about `kind`, `layer`,
  `parent`, ports and edges. A new collector never needs UI changes.

## 4. Collectors in v1

### Code collector (Python, TS/JS)

- Walks files and skips `node_modules`, `.git`, venvs, `dist`/`build` and anything in
  `.gitignore`.
- Hierarchy is built from directories: `system` (the repo root) > `module` (each
  directory, then each file) > `function`. Classes are `module` nodes too, with
  `metadata.subkind = "class"`. Methods are `function` nodes inside them.
- Inputs come from parameters (name, annotation, default). Outputs come from the
  return annotation, or `return` if none.
- Call edges are resolved in three steps: local definitions, then imports (relative
  and package-local), then `self.`/`this.` methods. Calls that can't be resolved into a
  third-party import aggregate into one external `module` node per package
  (`metadata.external = true`). The edge carries `count` (number of call sites),
  `loop` (the call sits inside `for`/`while`/`.map`) and `conditional`.
- Recursion becomes a self-edge.
- Shared state: module-level mutable variables that functions read or assign become a
  `datastore` node (`metadata.subkind = "global"`) with `read` and `write` edges.
- Light heuristics:
  - `requests`/`httpx`/`fetch`/`axios` calls with a literal URL become an
    `external_api` node and an `http` edge.
  - Obvious DB clients (`sqlalchemy`, `psycopg`, `prisma`, `pg`, `redis`) become a
    `datastore` node.
- Target: under 30 seconds for about 2,000 files.

### OTel trace importer

- Reads OTLP JSON (`resourceSpans`, and also the `{"batches": ...}` and line-delimited
  forms).
- Nodes:
  - `service.name` becomes a `service` node (layer `runtime`).
  - Spans with `code.function`/`code.filepath` alias onto code function ids, so the
    trace lights up real code.
  - `db.system` becomes a `datastore`, `messaging.system` becomes a `queue`, and
    spans with a client kind and no matching service become an `external_api`.
- Edges: parent to child span becomes a `call` edge, with `protocol` taken from
  `rpc.system`, `http.*`, `db.system` or `messaging.system`. Messaging spans become
  `event` edges.
- Executions: one per trace. Steps are ordered by start time. Inputs and outputs are
  read from the `noodles.input` and `noodles.output` span attributes (or the
  `input.value`/`output.value` attributes from OpenInference), and fall back to
  request/response attributes (`http.request.*`, `db.statement`, ...). Samples are
  attached to the edges.

### Infra collector

- Terraform/OpenTofu: reads `terraform show -json` state or plan output. Each
  resource becomes an `infra_resource` node, and Terraform modules become parent
  `module` nodes.
- References (`depends_on`, attribute references in the plan's `configuration`
  section, and ids matched in state) become `depends_on` edges.
- Security group rules, NACLs, LB listeners to target groups, and similar become
  `network` edges with `protocol`/port labels.
- Kubernetes: reads YAML manifests (multi-doc, and a directory walk).
  - Namespace becomes the parent. Deployment, StatefulSet and DaemonSet become
    `service` nodes (layer `infra`), each with the alias `service:<name>`.
  - Service to workload uses selectors (`network` edge). Ingress to Service is a
    `network` edge. ConfigMap and Secret references are `depends_on` edges.
    NetworkPolicy becomes `network` edges.

### Stub collectors

Each stub has an interface skeleton that throws "not implemented", plus a README with
the target node/edge mapping, input formats and ids. This gives contributors a clear
spec.

## 5. UI

- **View model**: the UI renders the children of the current *focus* node (the
  breadcrumb).
  - Edges between hidden descendants are lifted to their visible ancestors and
    aggregated, so an edge can say "12 calls".
  - On load, the UI picks the highest level that has more than one node. For example,
    with one system it starts inside it.
  - Hard cap of 150 rendered nodes. Above that, the least-connected siblings are
    grouped into a "+N more" node, and a hint tells you to drill in or search.
- **Node card**:
  - A rounded card with a kind icon, a name, and a layer tint stripe.
  - Input port handles on the left, output port handles on the right. Ports are named
    when there are 6 or fewer, otherwise one grouped handle.
  - Badges: child count (double-click to drill in), and `×N` run count in Trace mode.
    A loop edge gets a repeat marker.
- **Edges**: style and color by kind. `call` is solid gray, `data` blue, `network`
  dashed teal, `event` dotted purple, `read` and `write` green and orange, `deploy`
  pink, `depends_on` thin dashed. A legend sits in the corner.
- **Right panel**: tabs for Overview, Inputs, Outputs and Source. When executions
  touch the node, each tab also shows a per-run data selector.
- **Left sidebar**: search (jumps and drills to the match), layer toggles, edge-kind
  filters.
- **Top bar**: breadcrumbs, a Map/Trace switch, a theme toggle.
- **Trace mode**:
  - Pick an execution, then step through it with prev/next/play and a scrubber.
  - The active node is highlighted, and the path traversed so far is emphasized.
  - The view auto-drills to the deepest ancestor of the active node that is visible
    in the current view.
  - The panel shows the step's input, output, duration and status.
- Light and dark theme through CSS variables, with the system preference as the
  default.

## 6. CLI

```
noodles scan <path> [--collector code,infra] [-o flowgraph.json] [--config noodles.config.json]
noodles import-traces <otlp.json> --merge flowgraph.json [-o out.json]
noodles serve [flowgraph.json] [--port 4321] [--no-open]
noodles validate <flowgraph.json>
```

- `noodles.config.json` is optional. It can hold include/exclude globs, collector
  options and the LLM settings.
- LLM support: there is one `LLMProvider` interface with `summarize`, `name` and
  `group` methods.
  - It is **off by default**, and v1 ships only a `none` provider and an `ollama`
    provider (localhost).
  - Nothing is sent anywhere unless you explicitly configure it.

## 7. Phases

Each phase is one commit or a few, and each ends green with tests.

1. **Schema**: JSON Schema, TS types, `validate`, `merge`, plus unit tests.
2. **Code collector**: tree-sitter Python and TS/JS, with fixtures and tests.
   `noodles scan`.
3. **UI**: built against a hand-written sample graph, then wired to `noodles serve`.
   Playwright smoke test and screenshots.
4. **OTel importer**: `import-traces`, plus Trace mode end to end.
5. **Infra collector**: Terraform and k8s. Then the stubs and their READMEs.
6. **Demo and docs**:
   - `examples/shop`: a small Python and TS microservice set (gateway, orders,
     payments, Postgres, Kafka) with a fake OTLP trace, Terraform plan JSON and k8s
     YAML.
   - A self-scan of this repo.
   - The README: quickstart, screenshot instructions, and "write a collector".

## 8. Open questions (defaults in bold)

1. Name: **`noodles`** for the package and CLI. The file stays `flowgraph.json`.
2. All TypeScript (**yes**). The alternative is a Python CLI plus a TS UI.
3. Timestamps in executions: **epoch ms numbers**. The alternative is ISO strings.
4. Small schema additions beyond your spec:
   - `aliases` (cross-collector identity)
   - edge `id`, `label`, `loop`, `conditional`, `count`
   - node `tags`
   - step `parent` and `via`
   - top-level `sources`

   **Keep them.**
