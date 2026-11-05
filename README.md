# Preflight

Standalone execution-readiness analysis, isolated Docker rehearsal, and VS Code diagnostics. Preflight does not require GitHub Actions, a particular repository structure, or a CI template.

Preflight has one canonical, unversioned public API. Consumers adapt to its current contract; it does not ship historical compatibility layers. VSIX package numbers are for artifact distribution only.

## Quick start

Requires Node.js 20 or newer. Docker is needed only for rehearsal.

1. Create a workspace execution plan named `preflight.json` (see `examples/preflight.json`).
2. Run `node bin/preflight.js analyze --workspace . --plan preflight.json`.
3. Optionally run `node bin/preflight.js rehearse --workspace . --plan preflight.json --image node:24` after the Docker image is available locally.
4. Run `node bin/preflight.js serve --workspace .` to start an authenticated local API.

The CLI exits nonzero for failures and incomplete checks. Analysis is read-only and does not execute planned commands. Rehearsal executes commands only inside an isolated, offline Docker container with a temporary workspace copy and no publication credentials.

## VS Code

Preflight is a plugin for [Kooraseru Extension Host](https://github.com/Kooraseru-Hub/vscode-extension-host), which provides shared workspace lifecycle and live diagnostic publishing. Install both VSIX packages from their GitHub Releases until the host is available through the Visual Studio Marketplace. Preflight reads its configured plan, publishes findings to Problems, and exposes the current workspace's editor diagnostics to the local API. A repository may also provide `.vscode/preflight/workspace-checks.js`; Preflight runs it silently as a cancellable child process and publishes its report-only output to Problems. It never opens a terminal or edits files, and ignores disk results for dirty open documents. Use `node bin/preflight.js diagnostics --editor --workspace .` while the plugin is active to retrieve current Problems data.

Other VS Code extensions may access the Preflight API through its `activate()` export. Command-line clients can use the authenticated loopback API without VS Code. The Preflight engine remains independent of the extension host and is shared by the plugin and CLI.

## Contracts

- `docs/api.md`: public methods, HTTP routes, events, and diagnostic schema.
- `docs/security.md`: rehearsal limitations and local API security.
- `examples/preflight.json`: portable execution-plan example.

Providers supply additional checks through `registerProvider()`. They own their own validation logic; Preflight is not a second language linter.

## Development

- `npm install`
- `npm test`
- `npm run package:vsix`

Distributed under the ISC License. Copyright (c) 2026 Kooraseru.
