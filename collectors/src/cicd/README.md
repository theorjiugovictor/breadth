# `cicd` collector

Implemented: GitHub Actions (`.github/workflows/*.yml`) and GitLab CI (`.gitlab-ci.yml`, without `include:`). The table below is the full mapping; CircleCI, GitLab `include:`, Argo CD / Flux manifests and Helm charts are still planned.

Shows how code becomes running software: pipelines, their jobs, and what they deploy where.

## Inputs (planned)

| Source | Format |
|---|---|
| GitHub Actions | `.github/workflows/*.yml` |
| GitLab CI | `.gitlab-ci.yml` (with `include:` resolution) |
| CircleCI | `.circleci/config.yml` |
| Argo CD / Flux | `Application` / `Kustomization` manifests (what syncs into which cluster/namespace) |
| Helm | `Chart.yaml` + `values.yaml` (images, replicas) |

## Mapping

| Observed | Becomes |
|---|---|
| workflow / pipeline | `pipeline` node `ci:<provider>:<file>`, layer `delivery` |
| job / stage | `pipeline` node `ci:<provider>:<file>#<job>`, parent = workflow, `inputs` = triggers (`push`, `pull_request`, `schedule`), `outputs` = artifacts and images |
| `needs:` / stage order | `depends_on` edge job -> job it needs |
| job builds an image | `data` edge job -> `image:<repo>` node (`infra_resource`) |
| job deploys (kubectl/helm/terraform/argocd steps) | `deploy` edge job -> the deployed target, matched by alias (`service:<name>`, `k8s:<ns>/Deployment/<name>`, `tf:<address>`) |
| Argo CD Application | `deploy` edge `argocd:<app>` -> namespace/workloads it syncs |
| triggers on paths | `metadata.paths`, so the UI can show which code dirs feed which pipeline (`depends_on` job -> `code:dir:<path>`) |

Secrets referenced by jobs are listed by name only (`metadata.secrets`), never by value.
