"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROVIDER_ID = "preflight.execution-plan";
const WORKSPACE_CHECKS_PROVIDER_ID = "preflight.workspace-checks";

function sameRoot(left, right) {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function editorDiagnostics(vscode, root) {
	const items = [];
	for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder || !sameRoot(folder.uri.fsPath, root)) continue;
		const filename = uri.scheme === "file" ? path.relative(root, uri.fsPath).split(path.sep).join("/") : uri.toString();
		for (const diagnostic of diagnostics) {
			const code = diagnostic.code && typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
			items.push({
				path: filename,
				line: diagnostic.range.start.line + 1,
				column: diagnostic.range.start.character + 1,
				severity: ["error", "warning", "information", "hint"][diagnostic.severity] || "unknown",
				code: code == null ? "" : String(code),
				source: diagnostic.source || "",
				message: diagnostic.message,
			});
		}
	}
	items.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
	return items;
}

function readPlan(vscode, folder, documents = []) {
	const root = folder.uri.fsPath;
	const name = vscode.workspace.getConfiguration("preflight", folder.uri).get("planFile", "preflight.json");
	const file = path.resolve(root, name);
	const relative = path.relative(root, file);
	if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
		throw new Error("preflight.planFile must stay inside the workspace.");
	}
	const normalized = relative.split(path.sep).join("/");
	const openDocument = documents.find((document) => document.path === normalized);
	if (openDocument) return { plan: JSON.parse(openDocument.text), manifestPath: relative };
	if (!fs.existsSync(file)) return undefined;
	return { plan: JSON.parse(fs.readFileSync(file, "utf8")), manifestPath: relative };
}

function dirtyDocumentPaths(documents = []) {
	return new Set(documents.filter((document) => document.isDirty).map((document) => document.path));
}

function parseTaskDiagnostics(output, root, documents = []) {
	const dirty = dirtyDocumentPaths(documents);
	const diagnostics = [];
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^(.*):(\d+):(\d+): (error|warning|information|hint): (.*)$/i);
		if (!match || match[1] === "WORKSPACE_DIAGNOSTICS_BEGIN" || match[1] === "WORKSPACE_DIAGNOSTICS_END") continue;
		const absolute = path.resolve(match[1]);
		const relative = path.relative(root, absolute).split(path.sep).join("/");
		if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) || dirty.has(relative)) continue;
		diagnostics.push({
			path: relative,
			line: Number(match[2]),
			column: Number(match[3]),
			severity: match[4].toLowerCase(),
			source: "Preflight",
			message: match[5],
		});
	}
	return diagnostics;
}

function runWorkspaceChecks({ root, script, bash, documents = [], signal }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return resolve([]);
		const child = spawn(process.execPath, [script, bash, "--once"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		const abort = () => child.kill();
		signal?.addEventListener("abort", abort, { once: true });
		child.once("error", (error) => reject(error));
		child.once("close", (code) => {
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) return resolve([]);
			if (code !== 0) {
				return reject(new Error(stderr.trim() || `Workspace checker exited with status ${code}.`));
			}
			resolve(parseTaskDiagnostics(stdout, root, documents));
		});
	});
}

function createPlugin({ vscode, host, engine, startServer, context = { subscriptions: [] } }) {
	const sessions = new Map();
	let providerRegistration;
	let workspaceSubscription;
	let disposed = false;

	function addDisposable(disposable) {
		context.subscriptions.push(disposable);
		return disposable;
	}

	async function attach(folder) {
		const root = folder.uri.fsPath;
		if ([...sessions.keys()].some((candidate) => sameRoot(candidate, root))) return;
		const session = { root, folder, server: undefined };
		sessions.set(root, session);
		try {
			const server = await startServer({
				preflight: engine,
				workspace: root,
				editorDiagnostics: () => editorDiagnostics(vscode, root),
			});
			if (disposed || !sessions.has(root)) {
				await server.stop();
				return;
			}
			session.server = server;
		} catch (error) {
			sessions.delete(root);
			vscode.window.showErrorMessage("Preflight: " + (error?.message || String(error)));
		}
	}

	async function detach(folder) {
		const root = folder.uri?.fsPath || folder.fsPath || folder;
		const entry = [...sessions.entries()].find(([candidate]) => sameRoot(candidate, root));
		if (!entry) return;
		sessions.delete(entry[0]);
		if (entry[1].server) await entry[1].server.stop();
	}

	function planProvider() {
		return {
			id: PROVIDER_ID,
			async provideDiagnostics(input) {
				try {
					const loaded = readPlan(vscode, input.workspaceFolder, input.documents);
					if (!loaded) return { status: "incomplete", diagnostics: [] };
					const image = vscode.workspace.getConfiguration("preflight", input.workspaceFolder.uri).get("dockerImage", "");
					const request = { workspace: input.workspaceRoot, ...loaded, image };
					return input.options?.mode === "rehearse"
						? await engine.rehearse(request)
						: await engine.analyze(request);
				} catch (error) {
					const planFile = vscode.workspace.getConfiguration("preflight", input.workspaceFolder.uri).get("planFile", "preflight.json");
					return {
						status: "failed",
						diagnostics: [{
							path: planFile,
							line: 1,
							column: 1,
							severity: "error",
							code: "plan-read",
							source: "Preflight",
							message: error?.message || String(error),
						}],
					};
				}
			},
		};
	}

	function workspaceChecksProvider() {
		return {
			id: WORKSPACE_CHECKS_PROVIDER_ID,
			async provideDiagnostics(input) {
				const configuration = vscode.workspace.getConfiguration("preflight", input.workspaceFolder.uri);
			const scriptName = configuration.get("workspaceDiagnosticsScript", ".vscode/preflight/workspace-checks.js");
				const script = path.resolve(input.workspaceRoot, scriptName);
				const relative = path.relative(input.workspaceRoot, script);
				if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
					return { diagnostics: [{ path: ".vscode/settings.json", line: 1, column: 1, severity: "error", source: "Preflight", code: "checker-path", message: "preflight.workspaceDiagnosticsScript must stay inside the workspace." }] };
				}
				if (!fs.existsSync(script)) return { diagnostics: [] };
				try {
					const bash = configuration.get("workspaceDiagnosticsBash", "bash");
					return { diagnostics: await runWorkspaceChecks({ root: input.workspaceRoot, script, bash, documents: input.documents, signal: input.signal }) };
				} catch (error) {
					return { diagnostics: [{ path: relative.split(path.sep).join("/"), line: 1, column: 1, severity: "error", source: "Preflight", code: "workspace-check-failed", message: error?.message || String(error) }] };
				}
			},
		};
	}

	async function runCommand(mode) {
		const folder = vscode.window.activeTextEditor
			? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
			: host.getWorkspaceFolders()[0];
		if (!folder) return vscode.window.showWarningMessage("Preflight requires an open workspace.");
		const result = await providerRegistration.refresh(folder, { mode });
		if (result) vscode.window.showInformationMessage("Preflight " + result.status + " (" + result.diagnostics.length + " diagnostics)");
	}

	function activate() {
		providerRegistration = addDisposable(host.registerDiagnosticProvider(planProvider()));
		addDisposable(host.registerDiagnosticProvider(workspaceChecksProvider()));
		for (const folder of host.getWorkspaceFolders()) void attach(folder);
		workspaceSubscription = addDisposable(host.onDidChangeWorkspaceFolders((event) => {
			for (const folder of event.removed) void detach(folder);
			for (const folder of event.added) void attach(folder);
		}));
		addDisposable(vscode.commands.registerCommand("preflight.analyze", () => runCommand("analyze")));
		addDisposable(vscode.commands.registerCommand("preflight.rehearse", () => runCommand("rehearse")));
		addDisposable(vscode.commands.registerCommand("preflight.showDiagnostics", () => vscode.commands.executeCommand("workbench.actions.view.problems")));
		return Object.freeze({
			analyze: (request) => engine.analyze(request),
			rehearse: (request) => engine.rehearse(request),
			getRun: (id) => engine.getRun(id),
			getDiagnostics: (id) => engine.getDiagnostics(id),
			getEditorDiagnostics: () => host.getWorkspaceFolders().flatMap((folder) => editorDiagnostics(vscode, folder.uri.fsPath)),
			subscribe: (id, listener) => engine.subscribe(id, listener),
			registerProvider: (provider) => engine.registerProvider(provider),
			getCapabilities: () => engine.getCapabilities(),
		});
	}

	async function dispose() {
		if (disposed) return;
		disposed = true;
		workspaceSubscription?.dispose();
		providerRegistration?.dispose();
		await Promise.all([...sessions.values()].map(async (session) => session.server?.stop()));
		sessions.clear();
	}

	return { activate, dispose };
}

module.exports = { createPlugin, editorDiagnostics, readPlan, parseTaskDiagnostics, runWorkspaceChecks, PROVIDER_ID, WORKSPACE_CHECKS_PROVIDER_ID };
