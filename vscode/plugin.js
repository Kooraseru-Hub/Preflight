"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROVIDER_ID = "preflight.execution-plan";

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

module.exports = { createPlugin, editorDiagnostics, readPlan, PROVIDER_ID };
