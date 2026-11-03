"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { Preflight } = require("../src/core");
const { startServer } = require("../src/server");

const engine = new Preflight();
const sessions = new Map();

function sameRoot(left, right) {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function editorDiagnostics(root) {
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

function publish(session, records) {
	const grouped = new Map();
	for (const finding of records) {
		const target = path.resolve(session.root, finding.path || "preflight.json");
		const relative = path.relative(session.root, target);
		if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
		const uri = vscode.Uri.file(target);
		const position = new vscode.Position(Math.max(0, (finding.line || 1) - 1), Math.max(0, (finding.column || 1) - 1));
		const severity = {
			error: vscode.DiagnosticSeverity.Error,
			warning: vscode.DiagnosticSeverity.Warning,
			information: vscode.DiagnosticSeverity.Information,
			hint: vscode.DiagnosticSeverity.Hint,
		}[finding.severity] ?? vscode.DiagnosticSeverity.Error;
		const diagnostic = new vscode.Diagnostic(new vscode.Range(position, position.translate(0, 1)), finding.message, severity);
		diagnostic.code = finding.code || undefined;
		diagnostic.source = finding.source || "Preflight";
		const key = uri.toString();
		const current = grouped.get(key) || { uri, entries: [] };
		current.entries.push(diagnostic);
		grouped.set(key, current);
	}
	session.collection.clear();
	for (const group of grouped.values()) session.collection.set(group.uri, group.entries);
}

function readPlan(folder) {
	const root = folder.uri.fsPath;
	const name = vscode.workspace.getConfiguration("preflight", folder.uri).get("planFile", "preflight.json");
	const file = path.resolve(root, name);
	const relative = path.relative(root, file);
	if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
		throw new Error("preflight.planFile must stay inside the workspace.");
	}
	if (!fs.existsSync(file)) return undefined;
	return { plan: JSON.parse(fs.readFileSync(file, "utf8")), manifestPath: relative };
}

async function refresh(session, mode = "analyze") {
	try {
		const loaded = readPlan(session.folder);
		if (!loaded) {
			session.collection.clear();
			return undefined;
		}
		const image = vscode.workspace.getConfiguration("preflight", session.folder.uri).get("dockerImage", "");
		const request = { workspace: session.root, ...loaded, image };
		const result = mode === "rehearse" ? await engine.rehearse(request) : await engine.analyze(request);
		publish(session, result.diagnostics);
		return result;
	} catch (error) {
		const result = {
			status: "failed",
			diagnostics: [{
				path: vscode.workspace.getConfiguration("preflight", session.folder.uri).get("planFile", "preflight.json"),
				line: 1, column: 1, severity: "error", code: "plan-read",
				source: "Preflight", message: error.message || String(error),
			}],
		};
		publish(session, result.diagnostics);
		return result;
	}
}

function schedule(session) {
	clearTimeout(session.timer);
	session.timer = setTimeout(() => { void refresh(session); }, 400);
}

async function attach(folder) {
	const root = folder.uri.fsPath;
	if ([...sessions.keys()].some((candidate) => sameRoot(candidate, root))) return;
	const session = {
		root, folder,
		collection: vscode.languages.createDiagnosticCollection("Preflight"),
		timer: undefined,
		server: undefined,
	};
	sessions.set(root, session);
	try {
		session.server = await startServer({ preflight: engine, workspace: root, editorDiagnostics });
		await refresh(session);
	} catch (error) {
		vscode.window.showErrorMessage("Preflight: " + (error.message || String(error)));
	}
}

async function detach(root) {
	const session = sessions.get(root);
	if (!session) return;
	sessions.delete(root);
	clearTimeout(session.timer);
	session.collection.dispose();
	if (session.server) await session.server.stop();
}

async function runCommand(mode) {
	const folder = vscode.window.activeTextEditor
		? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
		: vscode.workspace.workspaceFolders?.[0];
	if (!folder) return vscode.window.showWarningMessage("Preflight requires an open workspace.");
	const session = sessions.get(folder.uri.fsPath);
	if (!session) return vscode.window.showWarningMessage("Preflight is still starting.");
	const result = await refresh(session, mode);
	if (result) vscode.window.showInformationMessage("Preflight " + result.status + " (" + result.diagnostics.length + " diagnostics)");
}

async function activate(context) {
	for (const folder of vscode.workspace.workspaceFolders || []) void attach(folder);
	context.subscriptions.push(
		vscode.commands.registerCommand("preflight.analyze", () => runCommand("analyze")),
		vscode.commands.registerCommand("preflight.rehearse", () => runCommand("rehearse")),
		vscode.commands.registerCommand("preflight.showDiagnostics", () => vscode.commands.executeCommand("workbench.actions.view.problems")),
		vscode.workspace.onDidSaveTextDocument((document) => {
			const folder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (folder) {
				const session = sessions.get(folder.uri.fsPath);
				if (session) schedule(session);
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders((event) => {
			for (const folder of event.removed) void detach(folder.uri.fsPath);
			for (const folder of event.added) void attach(folder);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("preflight")) {
				for (const session of sessions.values()) schedule(session);
			}
		}),
	);
	return Object.freeze({
		analyze: (request) => engine.analyze(request),
		rehearse: (request) => engine.rehearse(request),
		getRun: (id) => engine.getRun(id),
		getDiagnostics: (id) => engine.getDiagnostics(id),
		getEditorDiagnostics: () => (vscode.workspace.workspaceFolders || []).flatMap((folder) => editorDiagnostics(folder.uri.fsPath)),
		subscribe: (id, listener) => engine.subscribe(id, listener),
		registerProvider: (provider) => engine.registerProvider(provider),
		getCapabilities: () => engine.getCapabilities(),
	});
}

async function deactivate() {
	await Promise.all([...sessions.keys()].map(detach));
}

module.exports = { activate, deactivate };
