# shop-pr: a pull request for the demo

Files here replace the matching files in `examples/shop` to simulate an agent-written pull request
("add bulk refunds"). `npm run demo:build` scans both versions with `breadth diff` and ships the
result as the "Pull request" demo graph and `examples/shop-pr.md` (the PR comment breadth would post).
