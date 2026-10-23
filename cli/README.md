# breadth

The understanding layer for AI-written systems. breadth maps what a system actually does (calls, data reads and writes, endpoints, messages, infrastructure, IAM, CI/CD, real traces) and shows every change as a change in behaviour, not in lines.

```sh
npx @theorjiugovictor/breadth scan .          # writes flowgraph.json
npx @theorjiugovictor/breadth serve           # the canvas at http://127.0.0.1:4321
npx @theorjiugovictor/breadth diff            # what this branch does differently, as behaviour
npx @theorjiugovictor/breadth debt            # comprehension debt: behaviour nobody has reviewed
```

Python, TypeScript, JavaScript, Go and Java; Terraform / OpenTofu, Kubernetes, GitHub Actions, GitLab CI, AsyncAPI and OpenTelemetry traces. Everything runs locally.

Documentation, the GitHub Action and the MCP server: https://github.com/theorjiugovictor/noodles
