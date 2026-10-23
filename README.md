# breadth

**The understanding layer for AI-written systems.**

Writing code used to be the slow part of software, so understanding kept pace. Now an agent writes 2,000 lines in minutes, and the team's mental model of the system falls further behind with every merge. That gap is **comprehension debt** and epistemic stress: code that works and ships, but that nobody can explain. It grows like tech debt, and it stays invisible until an incident.

breadth keeps people in the loop. It maps what a system actually does (calls, data reads and writes, endpoints, messages, infrastructure, real traces) and shows every change as a change in behaviour, not in lines.

![What an agent-written pull request changes, on the breadth canvas](docs/img/diff.png)

- **Graph diffs on every pull request.** Instead of reading 40 changed files, the reviewer sees what the change *does*: "`mark_refunded` now writes to postgresql (UPDATE orders)", "`create_refund` now calls api.stripe.com", "`charge` no longer calls `risk_score`: a check was removed", "new loop doing a database read per order". A [GitHub Action](#graph-diffs-on-pull-requests) posts it as a PR comment with a picture. Review becomes judging intent instead of reading code.
- **Ground truth for agents.** Through the [MCP server](#mcp-the-graph-as-tools-for-the-agent), an agent can ask "what depends on this?" before it edits, and "what did my change do?" before it says it is done, instead of guessing from a few files.
- **Watch your coding agent build.** `breadth watch` keeps the canvas live while Claude Code, Copilot, Cursor, Gemini CLI, Windsurf, Antigravity, Codex or a person edits. New and changed functions light up as they are written, even before they are saved, next to the task that caused them. See [Live mode](#live-mode-watch-a-coding-agent).
- **Every kind of flow**, not just HTTP: function calls, shared state, database reads and writes, HTTP between services, Kafka topics, Kubernetes networking, Terraform dependencies and security group rules. Drill down from system to service, module, file, class and function.
- **Replay real runs.** Import OpenTelemetry traces and step through a request with the real input and output at every node.
- **Problems you can see.** Rules flag N+1 queries, repeated work, missed parallelism, dead code, duplicate logic, unused infrastructure, contract drift, unhandled errors and personal data sent to third parties. See [Insights](#insights).
- **One graph format, fully local.** Collectors write [`flowgraph.json`](schema/flowgraph.schema.json) and the UI only reads it. Zero config, and nothing leaves your machine. LLM features are optional and work with any provider.

**Try it without installing anything:** the [landing page](https://theorjiugovictor.github.io/noodles/) has a box where you paste a public GitHub repository. It is scanned in your browser: files come straight from GitHub and are parsed in a Web Worker with tree-sitter compiled to WebAssembly. No server is involved and nothing is uploaded.

## Install

Requires Node 20 or newer.

```sh
git clone https://github.com/theorjiugovictor/noodles breadth
cd breadth
npm install
npm run build          # builds the UI and bundles the CLI into cli/dist/breadth.mjs
npm link -w cli        # puts `breadth` on your PATH (optional)
```

Without `npm link`, run `node /path/to/breadth/cli/dist/breadth.mjs` instead of `breadth`.

> breadth is not on npm yet, and the npm name `breadth` belongs to someone else, so do not use `npx breadth`.

## Quick start

```sh
cd ~/code/some-repo
breadth scan .                 # writes flowgraph.json
breadth serve                  # opens http://127.0.0.1:4321
```

Add runtime data from OpenTelemetry:

```sh
breadth import-traces traces.otlp.json --merge flowgraph.json
breadth serve
```

Then switch the top bar to **Trace**, pick an execution and press play (or use ← / →).

### The demo

```sh
npm run demo        # builds the demo graphs and serves the shop example
```

`examples/shop` is a small shop with four services: a TypeScript gateway (Express), orders (Python/FastAPI), payments (Python/Flask) and notifier (TypeScript, Kafka consumer). It also includes Postgres, Kafka, the Terraform for its AWS platform, Kubernetes manifests and two recorded checkouts (one paid, one declined) in [`examples/shop/traces/checkout.otlp.json`](examples/shop/traces/checkout.otlp.json).

After the merge, each service is a single node across all layers:

- **Code:** its source directory.
- **Infrastructure:** its Kubernetes Deployment.
- **Runtime:** its OpenTelemetry service.

Every trace step lands on the function that produced it. `npm run demo:build` also writes `examples/breadth.flowgraph.json`, which is breadth scanning itself.

## Graph diffs on pull requests

```sh
breadth diff                       # working tree vs the merge base with main
breadth diff --base v1.4 --head v1.5 -o change.json   # two refs; open the result with `breadth serve change.json`
breadth diff before.json after.json                   # two saved graphs
```

breadth scans both versions (the base is read with `git archive`, so your working tree is never touched), compares the graphs, and describes the difference as behaviour, most important first:

| Severity | Examples |
| --- | --- |
| High | a call to a check removed (`auth`, `verify`, `risk`, `limit`, …), new writes to a datastore, new external API calls, a new loop calling something that does I/O, a changed signature with callers, new or removed endpoints and services, a removed function that unchanged code still calls. Infrastructure: something newly reachable from the internet (a database port, SSH), a store made public, encryption at rest or deletion protection turned off, a role granted `*` or `s3:*` on everything, new write access through IAM, a datastore removed, renamed or (with a plan) replaced |
| Medium | new reads, new publishes and consumers, calls between services, removed call paths, shared state modified. Infrastructure: new firewall paths between workloads, new read access through IAM, changed sizes and versions (`instance_class db.t4g.medium → db.r6g.large`) |
| Low | new packages, new findings of low severity, new IAM attachments, routes and other plumbing |

New insights (an N+1 query, an unhandled external call) are listed as changes too. The output is a terminal summary, a PR-ready markdown comment with a Mermaid picture (`--markdown`), JSON (`--json`), or a diff graph (`-o`). In the canvas, a diff graph opens on a **Changes** tab: new nodes are green, removed ones red and dashed, edited ones amber, and clicking a change shows it in place. The [live demo](https://theorjiugovictor.github.io/noodles/app/?graph=graphs/shop-pr.json) has one: an agent-written "bulk refunds" PR that also quietly drops the fraud check, grants itself `s3:*` on everything and opens Postgres to the internet.

### In GitHub Actions

```yaml
# .github/workflows/breadth.yml
name: breadth
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  map:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: theorjiugovictor/noodles@main
        # with:
        #   path: services        # scan a subfolder
        #   fail-on: high         # fail the check on high-severity behaviour changes
```

The action posts one comment per pull request and updates it on every push, writes the same summary to the job page, and uploads the diff graph as an artifact. Pull requests from forks get a read-only token, so for those the summary is on the job page only.

### Compared with the request

An agent asked to "add bulk refunds" that also drops the fraud check has done two things, and only one was asked for. With `--intent` (or `check-intent: true` in the action, which uses the pull request's title and description), an LLM compares the request with the list of behaviour changes. The comment then gets a section on top:

> #### Compared with the request
> > Adds bulk refunds, but also removes the fraud check from charges and opens Postgres to the internet.
>
> **Not in the request** (2):
> - 🔴 charge no longer calls risk_score: a check was removed · fraud check removed, not asked for
> - 🔴 postgresql is now reachable from the internet (tcp/5432) · unrelated to refunds

```sh
breadth diff --intent "Add bulk refunds for support agents" --llm-provider anthropic
```

```yaml
      - uses: theorjiugovictor/noodles@main
        with:
          check-intent: true
          llm-provider: anthropic
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Only the request text and the behaviour-change sentences are sent, never source code. Any provider `breadth llm` lists works, including local ones (Ollama, LM Studio). The result is advice: the changes themselves come from the graphs, not from the model.

### Terraform

breadth reads `.tf` files directly, so a Terraform pull request gets the same comment with no extra setup:

> - 🔴 postgresql is now reachable from the internet (tcp/5432): PostgreSQL (5432)
> - 🔴 shop-payments is now allowed s3:* on *
> - 🔴 payments can now write to shop-refund-receipts (IAM: s3:*)
> - 🔴 encryption at rest is turned off for orders (aws_db_instance)
> - 🟠 orders (aws_db_instance): instance_class db.t4g.medium → db.r6g.large

The configuration alone does not say what an apply will *do* to existing resources. A rename or an engine change can mean a database is destroyed and recreated. To get that too, make a plan in the workflow and pass it in:

```yaml
      - uses: hashicorp/setup-terraform@v3
      - run: |
          terraform -chdir=infra/prod init -input=false
          terraform -chdir=infra/prod plan -input=false -out=tfplan
          terraform -chdir=infra/prod show -json tfplan > "$RUNNER_TEMP/prod.plan.json"
      - uses: theorjiugovictor/noodles@main
        with:
          terraform-plan: |
            infra/prod=${{ runner.temp }}/prod.plan.json
```

The comment then says `applying the plan replaces orders-db because engine changed: the data in it is lost unless restored from a backup`. On the command line this is `breadth diff --plan infra/prod=plan.json` (also `breadth scan --plan`). Leave out the `dir=` and breadth matches the plan to the root module it fits best. A `terraform show -json` plan saved in the repository next to the `.tf` files is picked up on its own.

## Live mode: watch a coding agent

```sh
cd ~/code/some-repo
breadth watch                  # scans, serves http://127.0.0.1:4321 and keeps watching
```

Every save triggers an incremental rescan (unchanged files come from a cache), and the browser updates over Server-Sent Events without losing your place:

- Functions, endpoints and files that just appeared get a **new** badge; changed ones get **edited**. A folder or file card lights up when something inside it changed.
- With **Follow** on (the default), the canvas opens the level where the latest change happened.
- The **Live** tab lists each change (what was added, edited or removed, and any new insights it caused, such as dead code or an N+1 query) next to the task that led to it.

This works with any agent or editor, because it watches the files. Three optional add-ons do more:

| | What it adds | Setup |
| --- | --- | --- |
| **Hooks** | The agent's task (your prompt) in the feed, and its edits credited to it | `breadth connect <agent> --write` |
| **Editor extension** | Edits appear before they are saved (agents in the editor often leave files unsaved while you review) | `breadth editor install` |
| **MCP server** | The agent can ask breadth about the code (callers, impact of a change, insights) and report what it is working on | written by `breadth connect` too |

### Connect your agent

Run this in your project. It merges into the agent's project config files and keeps your own entries; run it again at any time. Leave out `--write` to just print what to add.

```sh
breadth connect claude --write        # or: copilot cursor gemini windsurf antigravity codex, or all
```

| Agent | Hooks file | Task (prompt) | Edits | MCP config |
| --- | --- | --- | --- | --- |
| Claude Code | `.claude/settings.json` | `UserPromptSubmit` | `PostToolUse` (Edit, Write, …) | `.mcp.json` |
| GitHub Copilot (VS Code agent mode) | `.github/hooks/breadth.json` | `UserPromptSubmit` | `PostToolUse` | `.vscode/mcp.json` |
| Cursor | `.cursor/hooks.json` | `beforeSubmitPrompt` | `afterFileEdit` | `.cursor/mcp.json` |
| Gemini CLI | `.gemini/settings.json` | `BeforeAgent` | `AfterTool` (write_file, replace) | `.gemini/settings.json` |
| Windsurf (Cascade) | `.windsurf/hooks.json` | `pre_user_prompt` | `post_write_code` | `~/.codeium/windsurf/mcp_config.json` (printed, not written) |
| Antigravity | `.agents/hooks.json` | via MCP `breadth_report_task` | `PostToolUse` (write_to_file, replace_file_content, …) | Agent panel › MCP servers › raw config (printed) |
| Codex | `.codex/hooks.json` | `UserPromptSubmit` | `PostToolUse` (apply_patch) | `.codex/config.toml` |

Notes:
- Every hook runs `breadth hook`, which reads the event on stdin, recognises the agent from its format, forwards the event to `breadth watch` and exits 0 straight away. If `breadth watch` is not running it does nothing, so the agent is never blocked.
- VS Code also runs the hooks in `.claude/settings.json`. When both are configured, breadth shows each prompt once.
- Copilot hooks are a VS Code preview feature. Codex asks you to trust new hooks once (`/hooks`).
- Any other tool can report too: pipe `{"files": [...], "prompt": "..."}` to `breadth hook --agent Name`, or POST it to `http://127.0.0.1:4321/api/activity` with the header `x-breadth: 1`. Endpoints that change state or call an LLM require that header, so other web pages cannot trigger them.

### See edits before they are saved

```sh
breadth editor install                # VS Code, Cursor, Windsurf, Antigravity (whichever is on PATH)
```

The **breadth live** extension sends unsaved editor buffers to `breadth watch` (only to `127.0.0.1`, and only while it runs). The canvas then follows typing and agent edits that are still waiting for review. Changes scanned from unsaved text are tagged **unsaved** in the feed. When a buffer is saved or closed, the file on disk is used again. If your editor's command is not on PATH, use *Extensions › … › Install from VSIX* with the file from `breadth editor path`.

### MCP: the graph as tools for the agent

`breadth mcp` is a Model Context Protocol server (stdio). Its tools work for any MCP-capable agent:

| Tool | What the agent gets |
| --- | --- |
| `breadth_changes` | What the agent's own change does in behaviour, compared with a git ref (see [Graph diffs](#graph-diffs-on-pull-requests)). The server's instructions ask the agent to check it before finishing |
| `breadth_report_task` | Puts a one-line summary of the task in the live feed (the only way to get Antigravity's task in) |
| `breadth_overview` | Top-level structure, counts and the main insights of the repository |
| `breadth_find` | Functions, classes, files, endpoints and datastores by name or path |
| `breadth_node` | Where a node lives, its inputs and outputs, callers, callees, data reads and writes, and insights |
| `breadth_impact` | Everything that depends on a node, up to N hops, and the endpoints it is reachable from |
| `breadth_insights` | Findings, optionally for one file or folder |

MCP does not replace hooks. An MCP server hears from the agent only when the agent decides to call a tool, so it cannot observe edits; hooks and file watching capture those. What MCP adds is the other direction: the agent can use the graph instead of reading every file, and can say what it is doing. When `breadth watch` is running, the tools read its live graph. Otherwise they scan the project themselves.

## CLI

```
breadth scan <path> [--collector code,infra] [-o flowgraph.json] [--config file] [--exclude glob]... [--no-external] [--llm]
breadth import-traces <otlp.json>... [--merge flowgraph.json] [-o out.json]
breadth serve [flowgraph.json] [--port 4321] [--host 127.0.0.1] [--no-open]
breadth diff [path] [--base ref] [--head ref] [-o diff.json] [--markdown pr.md] [--json] [--fail-on high|medium|low]
breadth diff before.json after.json
breadth watch [path] [--port 4321] [--traces otlp.json]... [-o flowgraph.json] [--llm]
breadth connect <agent>... [--write] [--port 4321] [--no-mcp] [--no-hooks]
breadth editor install [--editor code|cursor|windsurf|antigravity]
breadth mcp [path] [--port 4321]
breadth hook [--port 4321] [--agent name]
breadth llm [providers|check]
breadth insights <flowgraph.json> [--json] [--write] [--fail-on warning|critical] [--rules a,b] [--list]
breadth validate <flowgraph.json>
breadth collectors
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

Everything works without configuration. A `breadth.config.json` in the scanned directory, or one passed with `--config`, can set:

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

Nothing is sent anywhere unless you configure a provider. With one configured you get:

- **`scan --llm`**: one-sentence descriptions for the most connected functions and modules that have no docstring.
- **Explain**: a button in the node panel of `breadth serve` / `breadth watch` that explains what a node does and how it connects.
- **`watch --llm`**: a one-line narration of each change in the live feed (sends names and file paths, not source).

Remote providers are announced on the terminal before the first request. Pick one in `breadth.config.json`, with environment variables (`BREADTH_LLM_PROVIDER`, `BREADTH_LLM_MODEL`, `BREADTH_LLM_BASE_URL`), or with `--llm-provider`, `--llm-model` and `--llm-base-url`:

```jsonc
{ "llm": { "provider": "anthropic" } }                                   // Claude, uses ANTHROPIC_API_KEY
{ "llm": { "provider": "openai", "model": "gpt-4.1-mini" } }             // OPENAI_API_KEY
{ "llm": { "provider": "gemini", "model": "gemini-2.5-flash" } }         // GEMINI_API_KEY
{ "llm": { "provider": "ollama", "model": "qwen2.5-coder" } }            // local, nothing leaves the machine
{ "llm": { "provider": "openai-compatible", "baseUrl": "http://localhost:4000/v1", "model": "my-model",
           "apiKeyEnv": "GATEWAY_KEY", "headers": { "x-team": "$TEAM_ID" } } }   // LiteLLM, Azure, any gateway
```

Built-in presets: `anthropic`, `openai`, `gemini`, `ollama`, `openrouter`, `groq`, `together`, `mistral`, `deepseek`, `xai`, `fireworks`, `lmstudio`, `vllm`, `llamacpp` and `openai-compatible`. `breadth llm` lists them with the key each one reads, and `breadth llm check` sends a test prompt to the configured provider. Endpoints on `localhost` count as local and need no key.

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

## Insights

![The N+1 finding highlighted on the canvas](docs/img/insights.png)

When a graph is a graph, many problems stop hiding in code and become shapes. breadth runs a set of rules over any flowgraph. Each finding names the nodes, edges and (for runtime findings) the exact trace steps involved. Clicking it in the **Insights** tab opens the right level of the canvas, rings the nodes involved and dims everything else; runtime findings have a **Replay where it happens** button.

| Rule | Category | What it looks for | Needs traces? |
|---|---|---|---|
| `n-plus-one` | inefficiency | A datastore read inside a loop (directly or through callees), or the same query repeated in one request | no / yes |
| `repeated-work` | inefficiency | The same function called with identical input in one request | yes |
| `missed-parallelism` | inefficiency | Back-to-back sibling calls where neither uses the other's output | yes |
| `chatty-services` | inefficiency | Many calls between the same two services in one request | yes |
| `long-hop-chain` | inefficiency | A request crossing many services in sequence | yes |
| `dead-code` | redundancy | Functions nothing calls (entry points, framework hooks, callbacks and overrides excluded; public ones are low confidence) | no, traces add evidence |
| `duplicate-logic` | redundancy | Functions with identical or nearly identical syntax structure (names and literals ignored; MinHash over the tree) | no |
| `orphan-infra` | redundancy | Provisioned datastores and queues nothing reads, writes or sends traffic to | no |
| `internet-exposed` | risk | Firewall / security group rules that let any address reach a database, a remote shell, an admin port or anything that is not a load balancer | no |
| `public-data` | risk | Public S3 buckets (ACL or bucket policy), publicly accessible databases, GCS buckets shared with `allUsers`, public Azure containers | no |
| `unencrypted-storage` | risk | Databases, volumes and file systems without encryption at rest | no |
| `broad-iam` | risk | IAM roles allowed `*`, `service:*` on every resource, or `NotAction` | no |
| `iam-usage` | risk | Code that reads or writes an S3 bucket, DynamoDB table, SQS queue, SNS topic or Kinesis stream its IAM role does not allow (AccessDenied waiting to happen), and grants the code never uses | no |
| `race-risk` | risk | Shared state with several writers (module globals; databases written by several services) | no |
| `data-exposure` | risk | Personal or secret-looking fields (by name and value shape) sent to external APIs | yes |
| `contract-drift` | risk | Observed values whose type contradicts the declared parameter or return type | yes |
| `unhandled-errors` | risk | Errors that propagate all the way to the entry point; remote calls with no try/except or `.catch()` | yes / no |
| `static-runtime-mismatch` | risk | Calls seen at runtime that the code map does not contain (getattr, registries, DI) | yes |

Findings are **signals, not verdicts**. Rules see structure and flow, not the logic inside a function, and "dead" code might be called by a cron job, reflection or another repository you have not collected. Every finding carries a `confidence`.

```sh
breadth insights flowgraph.json                 # readable list
breadth insights flowgraph.json --json          # for tooling
breadth insights flowgraph.json --fail-on warning   # exit 1 in CI if any warning or critical finding
breadth insights --list                         # the rules
```

`scan` and `import-traces` store findings in the graph (`insights` in the schema; `--no-insights` to skip). The UI always re-runs the built-in rules on load and keeps findings other tools wrote into the file, so you can add your own rule engines. A rule is a plain object with `run(ctx, thresholds) => Insight[]` in [`insights/src/rules`](insights/src/rules); thresholds can be tuned per rule.

The shop demo is seeded with one realistic instance of each problem.

## How it fits together

```
schema/       flowgraph.schema.json, TypeScript types, validateGraph(), mergeGraphs()
insights/     rules over any flowgraph (pure TypeScript, runs in the CLI and the browser)
collectors/   core/ (interface, registry, file walker), code/, otel/, infra/
              browser.ts: the Node-free entry the in-browser repo scanner uses
              netflow/, messaging/, cicd/, org/   (stubs with a spec in their README)
cli/          the `breadth` command and the local server
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
| `infra` | ✅ | Terraform/OpenTofu configuration (`.tf`, `.tofu`, `.tf.json`, var files), `show -json` plans and state, and raw `.tfstate`; Kubernetes YAML (workloads, Services, Ingress, ConfigMaps/Secrets by key only, PVCs, NetworkPolicies). [More below](#terraform-and-opentofu) |
| `netflow` | stub | VPC flow logs, service mesh: [spec](collectors/src/netflow/README.md) |
| `messaging` | stub | Kafka, SQS/SNS, RabbitMQ, AsyncAPI: [spec](collectors/src/messaging/README.md) |
| `cicd` | stub | GitHub Actions, GitLab CI, Argo CD: [spec](collectors/src/cicd/README.md) |
| `org` | stub | CODEOWNERS, Backstage: [spec](collectors/src/org/README.md) |

### Terraform and OpenTofu

The `infra` collector reads `.tf` source with its own HCL parser. It needs no `terraform init`, no providers and no credentials, and it also runs in the browser.

- **Root modules.** Every folder of `.tf` files that no other folder calls as a module is a root (`envs/prod`, `envs/staging`). Their node ids carry the folder: `tf:envs/prod/aws_db_instance.main`. Local modules (`source = "./modules/db"`) are followed, with their inputs wired through. Registry and git modules become a module node without contents.
- **Values.** Literals, variable defaults, `terraform.tfvars` / `*.auto.tfvars`, locals, string templates, conditionals, `for` expressions and the common functions are evaluated, so `"${local.name}-orders"` shows up as `shop-orders`. Whatever only an apply knows (ids, ARNs, values from `-var-file`) stays unknown. Resources with `count = 0` or an empty `for_each` are left out.
- **Edges.** References between resources, including through module outputs, become `depends_on` edges. Load balancer listeners and target groups become traffic. Security group rules, `aws_vpc_security_group_ingress_rule`, GCP firewalls (by target tag) and Azure network security groups become `network` edges between the workloads behind them, or from the `Internet` node.
- **IAM.** Role policies (inline, attached, `aws_iam_policy_document`, `jsonencode`, and AWS managed policies such as `AdministratorAccess`) become `read`, `write` or `event` edges. They run from the workload that assumes the role: a Lambda function, an ECS service (its task role, not the execution role), an EC2 instance through its instance profile, or a Kubernetes Deployment through EKS Pod Identity or IRSA when its manifests are scanned too.
- **Security posture.** Public stores (S3 ACLs and bucket policies, unless a public access block overrides them; `publicly_accessible` databases; GCS `allUsers`; public Azure containers) and storage without encryption at rest are marked on the node. The `internet-exposed`, `public-data`, `unencrypted-storage` and `broad-iam` [insights](#insights) report them.
- **Plans.** With a `terraform show -json` plan, each resource is marked with what applying does to it (`create`, `update`, `replace`, `delete`, and the attributes that force a replacement).

- **Instances.** A resource with a known `count` or `for_each` (up to 25 instances) becomes one node per instance, `aws_sqs_queue.jobs["emails"]`, with its own name. `dynamic` blocks expand the same way. When the keys are only known at apply time, one node stands for all of them.
- **JSON syntax.** `.tf.json` and `.tfvars.json` are read like native syntax.

- **Code to infrastructure.** AWS SDK calls in code (boto3, AWS SDK for JavaScript v2 and v3) that name their resource, such as `s3.put_object(Bucket=...)`, `new PutObjectCommand({ Bucket })` or `table.query(...)` on a `dynamodb.Table("orders")`, are matched with the Terraform resource. The name can be a literal, a constant or an environment variable. Environment variables are resolved through the service's Kubernetes Deployment (values and ConfigMaps), Lambda `environment` or ECS container definitions, including Terraform references such as `BUCKET = aws_s3_bucket.receipts.bucket`. The code's reads and writes then land on the Terraform node, so a PR comment says `store_receipt now writes to shop-refund-receipts (s3:PutObject)` and the `iam-usage` insight can check them against IAM.

Two settings in `breadth.config.json` cover what a CLI flag would otherwise pass:

```json
{
  "settings": {
    "infra": {
      "varFiles": { "envs/prod": ["prod.tfvars"], "envs/staging": ["staging.tfvars"] },
      "primaryRoot": "envs/prod"
    }
  }
}
```

`varFiles` are the `-var-file` files of each root module (or a list tried in every root). `primaryRoot` is the environment matched with the code and Kubernetes layers by name. With several environments, only one of them can be "the postgresql the code writes to", or every environment's database would merge into one node. By default that is a root named `prod`, `production` or `live`, or the only root.

## Write a collector

A collector is an object with a name and two functions. It reads something and returns a flowgraph.

```ts
// collectors/src/compose/index.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { edgeId, SCHEMA_VERSION, type FlowGraph, type FlowNode, type FlowEdge } from "@breadth/schema";
import type { Collector } from "../core/types.js";

export const composeCollector: Collector = {
  name: "compose",
  description: "docker-compose services and their links",
  implemented: true,

  // Cheap check so `breadth scan` can pick this collector with zero config.
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

## Scanning a repository in the browser

`app/?repo=owner/repo` (or the box on the landing page) scans a public GitHub repository without a server:

1. One GitHub API request lists the files (`git/trees/HEAD?recursive=1`). Anonymous requests are limited to 60 per hour per visitor.
2. Python, TypeScript, JavaScript and Terraform files are downloaded from `raw.githubusercontent.com` (not counted against that limit). Repositories with more than 1,200 code files are sampled, application code first, with a notice.
3. A Web Worker parses them with tree-sitter (WebAssembly) and the Terraform reader, builds the graph and runs the insights.
4. The Source tab shows the lines straight from GitHub, with a link to the file.

`owner/repo`, GitHub URLs, `.git` URLs and `/tree/<branch>/<path>` (to scan a sub-folder) all work. Private repositories, traces, plans and Kubernetes manifests need the CLI.

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
npm run breadth -- scan examples/shop -o /tmp/shop.json   # run the CLI from source (tsx)
npm run dev -w ui    # UI dev server; put a flowgraph.json in ui/public/ to load it
```

## License

MIT
