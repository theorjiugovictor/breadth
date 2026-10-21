# shop-pr: a pull request for the demo

Files here replace the matching files in `examples/shop` to simulate an agent-written pull request
("add bulk refunds"). Besides the code, it adds a bucket for refund receipts with an IAM policy that
grants far more than it needs, and "temporarily" opens Postgres to the internet. `npm run demo:build`
scans both versions with `breadth diff` and ships the result as the "Pull request" demo graph and `examples/shop-pr.md` (the PR comment breadth would post).
