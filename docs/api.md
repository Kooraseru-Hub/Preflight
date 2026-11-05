# Public API

Preflight has a single canonical API. There are no API generations, compatibility layers, or version identifiers in requests, responses, or routes. Consumers are responsible for adapting to the current contract.

## JavaScript

Import `{ Preflight }` from `src/core.js` (or the installed package). Methods:

| Method | Meaning |
| --- | --- |
| `analyze({ workspace, plan, manifestPath?, changedFiles? })` | Validate the plan and run registered providers; never execute plan commands |
| `rehearse({ workspace, plan, image, timeoutMs? })` | Analyze, then run eligible steps in an isolated, offline Docker container |
| `startAnalyze(request)` / `startRehearsal(request)` | Start work and immediately return its run snapshot |
| `getRun(id)` | Obtain a complete run snapshot or `undefined` |
| `getDiagnostics(id)` | Obtain the run's complete Preflight diagnostics |
| `subscribe(id, listener)` | Receive run-scoped events; returns `{ dispose() }` |
| `registerProvider({ id, analyze(context) })` | Register a trusted in-process validator; returns `{ dispose() }` |
| `getCapabilities()` | Discover supported capabilities without checking a version number |

`Preflight` does not generate CI plans from arbitrary project formats. A caller or provider must supply the plan. A missing plan produces `incomplete`, never `passed`.

## Plan

A plan is a JSON object containing `steps`. A step has a unique `id`, optional `needs` (step IDs), optional `command` (argv strings, not a shell-interpolated command), optional workspace-relative `cwd`, `inputs`, `outputs`, and `effects` arrays.

Preflight checks duplicate IDs, unknown dependencies, dependency cycles, invalid commands, workspace-escaping paths, and duplicate output ownership. Additional checks can be registered as providers. Language analysis is the responsibility of providers, not the Preflight core.

Rehearsal permits effects `read` and `local`. A step declaring other effects is skipped and the run becomes `incomplete`. Network access is disabled inside Docker, and a temporary workspace copy is mounted instead of the real source tree.

## Run statuses

| Status | Meaning |
| --- | --- |
| `running` | Work has started |
| `passed` | Every configured, attempted check passed |
| `failed` | A diagnostic with severity `error` was produced |
| `incomplete` | A required plan, runtime, or rehearsal capability was unavailable or skipped |

A `passed` analysis does not promise that the eventual hosted CI execution will succeed.

## Diagnostic

Each diagnostic contains `path`, `line`, `column`, `severity`, `code`, `source`, and `message`. Lines and columns are 1-based. Severity is `error`, `warning`, `information`, or `hint`. No diagnostics are silently truncated by the API.

## Local HTTP

`preflight serve --workspace DIR` opens an authenticated loopback server and prints the path to its token-bearing endpoint descriptor. The endpoint descriptor is located in the operating system's temporary directory, not in the project.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/capabilities` | Discover features |
| `POST` | `/analyze` | Start analysis; returns a run ID |
| `POST` | `/rehearse` | Start isolated rehearsal; returns a run ID |
| `GET` | `/runs/{id}` | Read the run snapshot |
| `GET` | `/runs/{id}/diagnostics` | Read all Preflight diagnostics for a run |
| `GET` | `/runs/{id}/events` | Subscribe to Server-Sent Events |
| `GET` | `/editor/diagnostics` | Read VS Code's current Problems diagnostics, only when provided by the VSIX |

Requests require `Authorization: Bearer <token>`. POST bodies contain `plan`, optional `manifestPath`, `changedFiles`, `image`, and `timeoutMs`. The server pins its authorized workspace; clients cannot select arbitrary roots.

The Preflight VS Code plugin exposes the same public methods to other extensions via its `activate()` return value. It additionally exposes `getEditorDiagnostics()`, which returns all diagnostics registered by VS Code in the current workspace, not only Preflight's findings. The plugin depends on Kooraseru Extension Host for scheduling and publishing its diagnostics; the standalone engine and CLI do not depend on that host.

## Events

`started`, `diagnostics`, `step`, and `completed` are emitted with `runId`, `type`, and `at`. An HTTP events subscription begins with a `snapshot` event containing the current run.
