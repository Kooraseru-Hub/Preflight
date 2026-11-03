"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { executeRehearsal } = require("./rehearsal");

const SEVERITIES = new Set(["error", "warning", "information", "hint"]);

function diagnostic(code, message, file = "preflight.json", severity = "error") {
	return { path: file, line: 1, column: 1, severity, code, source: "Preflight", message };
}

function normalizeDiagnostic(value, source = "Preflight") {
	if (!value || typeof value.message !== "string") {
		throw new TypeError("Providers must return diagnostics with a message.");
	}
	return {
		path: String(value.path || "preflight.json"),
		line: Number.isInteger(value.line) && value.line > 0 ? value.line : 1,
		column: Number.isInteger(value.column) && value.column > 0 ? value.column : 1,
		severity: SEVERITIES.has(value.severity) ? value.severity : "error",
		code: value.code == null ? "" : String(value.code),
		source: String(value.source || source),
		message: value.message,
	};
}

function containedPath(root, relative) {
	if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) return false;
	const resolved = path.resolve(root, relative);
	const distance = path.relative(root, resolved);
	return distance !== ".." && !distance.startsWith(".." + path.sep) && !path.isAbsolute(distance);
}

function validatePlan(plan, workspace, manifestPath = "preflight.json") {
	const diagnostics = [];
	if (!plan) {
		return { diagnostics: [diagnostic("plan-missing", "No execution plan was supplied.", manifestPath, "warning")], order: [], incomplete: true };
	}
	if (typeof plan !== "object" || !Array.isArray(plan.steps)) {
		return { diagnostics: [diagnostic("plan-invalid", "The plan must contain a steps array.", manifestPath)], order: [], incomplete: false };
	}

	if (plan.steps.length === 0) {
		return { diagnostics: [diagnostic("plan-empty", "The execution plan has no steps.", manifestPath, "warning")], order: [], incomplete: true };
	}
	const nodes = new Map();
	const outputs = new Map();
	for (const [index, step] of plan.steps.entries()) {
		const label = "Step " + (index + 1);
		if (!step || typeof step !== "object" || typeof step.id !== "string" || !step.id.trim()) {
			diagnostics.push(diagnostic("step-id", label + " requires a nonempty id.", manifestPath));
			continue;
		}
		if (nodes.has(step.id)) {
			diagnostics.push(diagnostic("duplicate-step", "Duplicate step id: " + step.id, manifestPath));
			continue;
		}
		nodes.set(step.id, step);
		if (!Array.isArray(step.needs || []) || !(step.needs || []).every((item) => typeof item === "string")) {
			diagnostics.push(diagnostic("invalid-needs", step.id + " needs must be an array of step ids.", manifestPath));
		}
		if (step.command !== undefined && (!Array.isArray(step.command) || step.command.length === 0 || !step.command.every((part) => typeof part === "string"))) {
			diagnostics.push(diagnostic("invalid-command", step.id + " command must be a nonempty array of strings.", manifestPath));
		}
		if (step.cwd !== undefined && !containedPath(workspace, step.cwd)) {
			diagnostics.push(diagnostic("invalid-cwd", step.id + " has a workspace-escaping cwd.", manifestPath));
		}
		for (const property of ["inputs", "outputs", "effects"]) {
			if (step[property] !== undefined && (!Array.isArray(step[property]) || !step[property].every((item) => typeof item === "string"))) {
				diagnostics.push(diagnostic("invalid-" + property, step.id + " " + property + " must be an array of strings.", manifestPath));
			}
		}
		if (Array.isArray(step.outputs)) {
			for (const output of step.outputs) {
				if (!containedPath(workspace, output)) {
					diagnostics.push(diagnostic("invalid-output", step.id + " declares an output outside the workspace.", manifestPath));
				} else if (outputs.has(output) && outputs.get(output) !== step.id) {
					diagnostics.push(diagnostic("output-collision", step.id + " and " + outputs.get(output) + " both own " + output, manifestPath));
				} else {
					outputs.set(output, step.id);
				}
			}
		}
		if (Array.isArray(step.inputs)) {
			for (const input of step.inputs) {
				if (!containedPath(workspace, input)) {
					diagnostics.push(diagnostic("invalid-input", step.id + " references an input outside the workspace.", manifestPath));
				}
			}
		}
	}
	const order = [];
	const visiting = new Set();
	const visited = new Set();
	const visit = (id) => {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			diagnostics.push(diagnostic("dependency-cycle", "Dependency cycle includes " + id, manifestPath));
			return;
		}
		visiting.add(id);
		const node = nodes.get(id);
		for (const need of Array.isArray(node.needs) ? node.needs : []) {
			if (!nodes.has(need)) {
				diagnostics.push(diagnostic("unknown-dependency", id + " depends on missing step " + need, manifestPath));
			} else {
				visit(need);
			}
		}
		visiting.delete(id);
		visited.add(id);
		order.push(node);
	};
	for (const id of nodes.keys()) visit(id);
	return { diagnostics, order, incomplete: false };
}

class Preflight {
	constructor(options = {}) {
		this.providers = new Map();
		this.runs = new Map();
		this.pending = new Map();
		this.events = new EventEmitter();
		this.executor = options.executor || executeRehearsal;
	}

	getCapabilities() {
		return ["analysis", "diagnostics", "providers", "events", "docker-rehearsal"];
	}

	registerProvider(provider) {
		if (!provider || typeof provider.id !== "string" || typeof provider.analyze !== "function") {
			throw new TypeError("A provider requires an id and analyze(context) method.");
		}
		if (this.providers.has(provider.id)) throw new Error("Provider already registered: " + provider.id);
		this.providers.set(provider.id, provider);
		return { dispose: () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id); } };
	}

	startAnalyze(request) {
		return this._start("analyze", request);
	}

	startRehearsal(request) {
		return this._start("rehearse", request);
	}

	async analyze(request) {
		const run = this.startAnalyze(request);
		await this.pending.get(run.id);
		return this.getRun(run.id);
	}

	async rehearse(request) {
		const run = this.startRehearsal(request);
		await this.pending.get(run.id);
		return this.getRun(run.id);
	}

	getRun(id) {
		const value = this.runs.get(id);
		return value ? structuredClone(value) : undefined;
	}

	getDiagnostics(id) {
		return this.getRun(id)?.diagnostics;
	}

	subscribe(runId, listener) {
		if (typeof listener !== "function") throw new TypeError("Listener must be a function.");
		const callback = (event) => { if (event.runId === runId) listener(event); };
		this.events.on("event", callback);
		return { dispose: () => this.events.off("event", callback) };
	}

	_emit(run, type, data = {}) {
		this.events.emit("event", { runId: run.id, type, at: new Date().toISOString(), ...data });
	}

	_add(run, entries) {
		const diagnostics = entries.map((item) => normalizeDiagnostic(item));
		run.diagnostics.push(...diagnostics);
		if (diagnostics.length) this._emit(run, "diagnostics", { diagnostics: structuredClone(diagnostics) });
	}

	_start(mode, request) {
		const run = {
			id: crypto.randomUUID(),
			mode,
			status: "running",
			startedAt: new Date().toISOString(),
			completedAt: null,
			diagnostics: [],
			steps: [],
		};
		this.runs.set(run.id, run);
		this._emit(run, "started");
		const pending = Promise.resolve().then(() => this._execute(run, request || {})).catch((error) => {
			this._add(run, [diagnostic("internal-error", error.message || String(error))]);
			run.status = "failed";
			run.completedAt = new Date().toISOString();
			this._emit(run, "completed", { status: run.status });
		});
		this.pending.set(run.id, pending);
		pending.finally(() => this.pending.delete(run.id));
		return this.getRun(run.id);
	}

	async _execute(run, request) {
		const workspace = path.resolve(request.workspace || process.cwd());
		if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
			this._add(run, [diagnostic("workspace-missing", "Workspace directory does not exist: " + workspace)]);
			return this._finish(run, false);
		}
		const checked = validatePlan(request.plan, workspace, request.manifestPath);
		this._add(run, checked.diagnostics);
		let incomplete = checked.incomplete;
		const invalid = checked.diagnostics.some((item) => item.severity === "error");

		if (!invalid && request.plan) {
			for (const provider of this.providers.values()) {
				try {
					const result = await provider.analyze({ workspace, plan: request.plan, changedFiles: request.changedFiles || [] });
					if (Array.isArray(result?.diagnostics)) {
						this._add(run, result.diagnostics.map((item) => ({ ...item, source: item.source || provider.id })));
					}
					if (result?.incomplete) incomplete = true;
				} catch (error) {
					this._add(run, [diagnostic("provider-failed", provider.id + ": " + (error.message || String(error)))]);
				}
			}
			if (run.mode === "rehearse" && !run.diagnostics.some((item) => item.severity === "error")) {
				const result = await this.executor({
					workspace,
					steps: checked.order,
					image: request.image,
					timeoutMs: request.timeoutMs,
					onStep: (step) => {
						run.steps.push(step);
						this._emit(run, "step", { step: structuredClone(step) });
					},
				});
				if (Array.isArray(result.diagnostics)) this._add(run, result.diagnostics);
				if (result.incomplete) incomplete = true;
			}
		}
		this._finish(run, incomplete);
	}

	_finish(run, incomplete) {
		run.status = run.diagnostics.some((entry) => entry.severity === "error")
			? "failed"
			: incomplete ? "incomplete" : "passed";
		run.completedAt = new Date().toISOString();
		this._emit(run, "completed", { status: run.status });
	}
}

module.exports = { Preflight, diagnostic, normalizeDiagnostic, validatePlan };
