# `org` collector (stub, not implemented)

Adds the people layer: teams, who owns which code and services, and which systems a team runs. This is the top of the drill-down (org > team > system > service > module > function).

## Inputs (planned)

| Source | Format |
|---|---|
| CODEOWNERS | `CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS` (gitignore-style patterns -> `@org/team` or `@user`) |
| Backstage | `catalog-info.yaml` (`Component`, `System`, `Group`, `owner`, `system`, `dependsOn`, `providesApis`) |
| OpsLevel / Cortex / Port | exported service catalog JSON |
| GitHub teams | `gh api orgs/<org>/teams` JSON (optional, offline export) |

## Mapping

| Observed | Becomes |
|---|---|
| organisation | `org` node `org:<name>`, layer `org` |
| team (`@org/team`, Backstage `Group`) | `team` node `team:<slug>`, parent = org |
| CODEOWNERS pattern -> team | `depends_on` edge team -> each matching `code:dir:<path>` / `code:file:<path>`, `label` = `owns` |
| Backstage `System` | `system` node `system:<name>`, parent = owning team; the components it contains get `aliases` matching code/k8s services |
| Backstage `Component.owner` | `depends_on` edge team -> `service:<component>`, `label` = `owns` |
| `dependsOn` / `consumesApis` | `depends_on` edges between the services |

Notes:

- Ownership is an edge, not a `parent`, because one team may own many systems and code may live in a monorepo. A `parent` link is only used for real containment (org > team, team > system).
- Patterns are evaluated the way GitHub does it: the last matching rule wins.
