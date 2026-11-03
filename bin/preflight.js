#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Preflight } = require("../src/core");
const { startServer, endpointPath } = require("../src/server");

function parseArgs(argv) {
	const options = {};
	const positional = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		if (arg === "--editor" || arg === "--json" || arg === "--help") {
			options[arg.slice(2)] = true;
			continue;
		}
		const separator = arg.indexOf("=");
		const key = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
		const value = separator === -1 ? argv[++index] : arg.slice(separator + 1);
		if (!value || value.startsWith("--")) throw new Error("Missing value for --" + key);
		options[key] = value;
	}
	return { command: positional[0] || "help", options };
}

function loadPlan(workspace, name) {
	const file = path.resolve(workspace, name || "preflight.json");
	if (!fs.existsSync(file)) return { plan: undefined, manifestPath: name || "preflight.json" };
	return { plan: JSON.parse(fs.readFileSync(file, "utf8")), manifestPath: path.relative(workspace, file) };
}

function escapeCell(value) {
	if (value === undefined || value === null || value === "") return "–";
	return String(value).replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

function formatDiagnostics(diagnostics) {
	if (!diagnostics.length) return "No diagnostics.";
	const header = ["| Severity | Code | File | Line | Message | Source |", "| --- | --- | --- | --- | --- | --- |"];
	const tick = String.fromCharCode(96);
	for (const problem of diagnostics) {
		const file = escapeCell(problem.path || problem.uri || "unknown");
		const code = problem.code && typeof problem.code === "object" ? problem.code.value : problem.code;
		header.push("| " + [
			escapeCell(problem.severity),
			escapeCell(code),
			tick + file.replaceAll(tick, "\\" + tick) + tick,
			escapeCell(problem.line),
			escapeCell(problem.message),
			escapeCell(problem.source),
		].join(" | ") + " |");
	}
	return header.join("\n");
}

function output(data, json) {
	process.stdout.write((json ? JSON.stringify(data, null, 2) : data) + "\n");
}

async function remoteDiagnostics(workspace, options) {
	const file = path.resolve(options.endpoint || endpointPath(workspace));
	const endpoint = JSON.parse(fs.readFileSync(file, "utf8"));
	const route = options.editor ? "/editor/diagnostics" : options.run ? "/runs/" + encodeURIComponent(options.run) + "/diagnostics" : null;
	if (!route) throw new Error("Specify --editor for VS Code Problems or --run ID for Preflight findings.");
	const response = await fetch("http://127.0.0.1:" + endpoint.port + route, {
		headers: { authorization: "Bearer " + endpoint.token },
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) throw new Error("Local Preflight API returned HTTP " + response.status);
	const result = await response.json();
	if (!Array.isArray(result.diagnostics)) throw new Error("Invalid diagnostics response.");
	return result.diagnostics;
}

function usage() {
	return [
		"Preflight: standalone execution-readiness analysis",
		"",
		"  preflight analyze   [--workspace DIR] [--plan FILE] [--json]",
		"  preflight rehearse  [--workspace DIR] [--plan FILE] --image IMAGE [--timeout MS] [--json]",
		"  preflight serve     [--workspace DIR]",
		"  preflight diagnostics --editor [--workspace DIR] [--json]",
		"  preflight diagnostics --run ID [--workspace DIR] [--json]",
		"",
		"All API methods and HTTP routes are unversioned. Missing or unavailable checks never count as success.",
	].join("\n");
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2));
	const workspace = path.resolve(options.workspace || process.cwd());
	if (command === "help" || options.help) return output(usage(), false);
	if (command === "serve") {
		const api = await startServer({ preflight: new Preflight(), workspace });
		output("Preflight listening on loopback. Endpoint: " + api.endpointFile, false);
		const stop = async () => { await api.stop(); process.exit(0); };
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		return;
	}
	if (command === "diagnostics") {
		const diagnostics = await remoteDiagnostics(workspace, options);
		return output(options.json ? diagnostics : formatDiagnostics(diagnostics), !!options.json);
	}
	if (command !== "analyze" && command !== "rehearse") throw new Error("Unknown command: " + command);
	const request = { workspace, ...loadPlan(workspace, options.plan) };
	const preflight = new Preflight();
	const result = command === "analyze"
		? await preflight.analyze(request)
		: await preflight.rehearse({ ...request, image: options.image, timeoutMs: Number(options.timeout) || undefined });
	if (options.json) output(result, true);
	else {
		output("Preflight " + result.status + " (" + result.diagnostics.length + " diagnostics)", false);
		output(formatDiagnostics(result.diagnostics), false);
		for (const step of result.steps) output(step.id + ": " + step.status + (step.exitCode == null ? "" : " (exit " + step.exitCode + ")"), false);
	}
	process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
}

main().catch((error) => {
	process.stderr.write("Preflight: " + (error.message || String(error)) + "\n");
	process.exitCode = 1;
});
