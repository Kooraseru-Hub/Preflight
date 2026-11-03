# Execution and API security

Preflight's analysis mode reads the supplied execution plan and calls trusted providers. It does not run plan commands. Providers are arbitrary in-process code and must be treated as trusted dependencies.

Rehearsal executes actual commands, but only after validation and only inside Docker. It:

- Copies the workspace to a temporary directory, excluding `.git`, `node_modules`, `.env`, `.aws`, `.ssh`, and `.preflight` entries.
- Disables container network access and prevents image pulls.
- Drops Linux capabilities, enables no-new-privileges, and constrains processes, memory, and CPU.
- Mounts only the temporary workspace as writable; the container's remaining filesystem is read-only.
- Does not inject GitHub tokens or local process environment secrets.
- Skips steps declaring nonlocal or publication effects, reporting an incomplete rehearsal.
- Cleans up the temporary workspace on completion.

Do not treat this as a security boundary against hostile code with access to a privileged Docker daemon. The workspace must be trusted, Docker should be configured without unnecessary host privileges, and provider modules should be reviewed before registration.

Network isolation and declared effects cannot prove all possible side effects or perfectly reproduce hosted GitHub Actions. Preflight reports observed failures and unverified cases, not guaranteed future CI outcomes.

The local HTTP server listens only on `127.0.0.1`, requires a randomly generated bearer token, limits request bodies to 1 MiB, and pins requests to its configured workspace. Its token-bearing endpoint descriptor is created with restrictive file permissions where supported. Treat that file as a secret and do not commit it.

The VSIX reports diagnostics from VS Code's own API. That snapshot reflects the editor's currently registered diagnostics; analyzers that have not run cannot be inferred from it.
