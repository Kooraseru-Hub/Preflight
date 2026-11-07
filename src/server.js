"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

function endpointPath(workspace) {
	const root = path.resolve(workspace);
	const hash = crypto.createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 20);
	return path.join(os.tmpdir(), "preflight-" + hash, "endpoint.json");
}

async function readJson(request) {
	let bytes = 0;
	const chunks = [];
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > 1024 * 1024) throw new Error("Request body exceeds 1 MiB.");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function respond(response, status, data) {
	if (response.headersSent) return;
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(data));
}

async function startServer({ preflight, workspace, editorDiagnostics, provider, loadPlan, publishEndpoint = true }) {
	const root = path.resolve(workspace);
	const token = crypto.randomBytes(32).toString("hex");
	const file = endpointPath(root);
	const server = http.createServer(async (request, response) => {
		const remote = request.socket.remoteAddress;
		if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") return respond(response, 403, { error: "Loopback only." });
		if (request.headers.authorization !== "Bearer " + token) return respond(response, 401, { error: "Unauthorized." });
		try {
			const pathname = new URL(request.url, "http://localhost").pathname;
			if (request.method === "GET" && pathname === "/capabilities") {
				const capabilities = [...preflight.getCapabilities(), "plan-endpoint"];
				if (editorDiagnostics) capabilities.push("editor-diagnostics");
				return respond(response, 200, { capabilities });
			}
			if (request.method === "GET" && pathname === "/editor/diagnostics") {
				if (!editorDiagnostics) return respond(response, 404, { error: "Editor diagnostics unavailable without VS Code." });
				return respond(response, 200, { diagnostics: await editorDiagnostics(root) });
			}
			if (request.method === "POST" && (["/plan", "/analyze", "/rehearse"].includes(pathname))) {
				const input = await readJson(request);
				if (!input || typeof input !== "object" || Array.isArray(input)) return respond(response, 400, { error: "Expected a JSON object." });
				if (input.entry !== undefined && typeof input.entry !== "string") return respond(response, 400, { error: "Entry must be a string." });
				if (input.workspace !== undefined && (typeof input.workspace !== "string" || path.resolve(input.workspace) !== root)) return respond(response, 403, { error: "Workspace is not authorized." });
				if (input.target !== undefined && typeof input.target !== "string") return respond(response, 400, { error: "Target must be a string." });
				const defaults = pathname === "/plan" && input.plan === undefined && !provider ? await loadPlan?.() : undefined;
				const payload = {
					workspace: root,
					plan: input.plan ?? defaults?.plan,
					provider: input.plan === undefined ? provider : undefined,
					entry: input.entry,
					target: input.target,
					manifestPath: input.manifestPath || defaults?.manifestPath || "preflight.json",
					changedFiles: input.changedFiles,
					image: input.image,
					timeoutMs: input.timeoutMs,
				};
				if (pathname === "/plan") return respond(response, 200, await preflight.analyze(payload));
				const run = pathname === "/analyze" ? preflight.startAnalyze(payload) : preflight.startRehearsal(payload);
				return respond(response, 202, run);
			}
			const match = /^\/runs\/([a-f0-9-]+)(?:\/(diagnostics|events))?$/.exec(pathname);
			if (request.method === "GET" && match) {
				const run = preflight.getRun(match[1]);
				if (!run) return respond(response, 404, { error: "Unknown run." });
				if (match[2] === "diagnostics") return respond(response, 200, { diagnostics: run.diagnostics });
				if (match[2] === "events") {
					response.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-store",
						connection: "keep-alive",
					});
					const send = (event) => response.write("data: " + JSON.stringify(event) + "\n\n");
					send({ runId: run.id, type: "snapshot", run });
					if (run.status !== "running") return response.end();
					const subscription = preflight.subscribe(run.id, (event) => {
						send(event);
						if (event.type === "completed") response.end();
					});
					request.on("close", () => subscription.dispose());
					return;
				}
				return respond(response, 200, run);
			}
			return respond(response, 404, { error: "Unknown route." });
		} catch (error) {
			return respond(response, 400, { error: error.message || String(error) });
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const endpoint = { port: address.port, token, workspace: root, pid: process.pid };
	if (publishEndpoint) {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			const temporary = file + "." + process.pid + ".tmp";
			fs.writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 });
			fs.renameSync(temporary, file);
		} catch (error) {
			server.close();
			throw error;
		}
	}
	return {
		endpoint,
		endpointFile: file,
		async stop() {
			await new Promise((resolve) => server.close(resolve));
			if (publishEndpoint) try {
				const current = JSON.parse(fs.readFileSync(file, "utf8"));
				if (current.token === token) fs.unlinkSync(file);
			} catch {}
		},
	};
}

module.exports = { startServer, endpointPath };
