# Preflight

Preflight analyzes workflow plans and rehearses their execution. It is an ISC-licensed Node.js workspace package. Workbench Bridge supplies VS Code integration.

Install the package as a workspace dependency. Use Node.js 22 or newer.

- `preflight plan --plan preflight.json --json` validates a declarative plan.
- `preflight plan --provider ./provider.cjs --entry pull_request` resolves a project-owned graph.
- `preflight rehearse --plan preflight.json --image local-image` runs eligible tasks in offline Docker.
- `preflight rehearse --provider ./provider.cjs --environment ./runner.cjs --profile ./test.json --env-file ./test.env` delegates execution to a project runner.

For VS Code, add a Workbench Bridge workspace command with argv `["node", "node_modules/preflight/bin/preflight.js", "workspace", "--bridge-client", "./path/to/workbenchBridgeClient"]`. Add the same plan or provider arguments as for CLI analysis. The package and Bridge client must resolve inside the workspace for the workspace module to load.

A passing plan means the selected graph passed analysis. A passing rehearsal requires a passing outcome for every task in that graph. A skipped or unreported required task makes the run incomplete.

See [the API contract](docs/api.md) and [the security notes](docs/security.md).
