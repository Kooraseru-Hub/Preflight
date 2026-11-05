"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createPlugin, PROVIDER_ID } = require("../vscode/plugin");

function makePlugin(t, planFileContents) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-plugin-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const planPath = path.join(root, "preflight.json");
	fs.writeFileSync(planPath, planFileContents);
	const folder = { name: "fixture", index: 0, uri: { scheme: "file", fsPath: root, path: root, toString: () => "file:///" + root.replaceAll("\\", "/") } };
	const configuration = {
		planFile: "preflight.json",
		dockerImage: "",
		get(key, fallback) { return this[key] ?? fallback; },
	};
	const commands = new Map();
	const messages = [];
	let provider;
	let refreshOptions;
	const vscode = {
		workspace: {
			getConfiguration: () => configuration,
			getWorkspaceFolder: () => folder,
		},
		languages: { getDiagnostics: () => [] },
		commands: {
			registerCommand(name, callback) { commands.set(name, callback); return { dispose() { commands.delete(name); } }; },
			executeCommand: async () => undefined,
		},
		window: {
			activeTextEditor: undefined,
			showErrorMessage: (message) => messages.push(message),
			showWarningMessage: (message) => messages.push(message),
			showInformationMessage: (message) => messages.push(message),
		},
	};
	const host = {
		getWorkspaceFolders: () => [folder],
		onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
		registerDiagnosticProvider(value) {
			provider = value;
			return {
				refresh: async (_folder, options) => {
					refreshOptions = options;
					return provider.provideDiagnostics({ workspaceFolder: folder, workspaceRoot: root, documents: [], options });
				},
				dispose() {},
			};
		},
	};
	const engine = {
		analyze: async (request) => ({ status: "passed", diagnostics: [], request }),
		rehearse: async (request) => ({ status: "passed", diagnostics: [], request }),
		getRun: () => undefined,
		getDiagnostics: () => undefined,
		subscribe: () => ({ dispose() {} }),
		registerProvider: () => ({ dispose() {} }),
		getCapabilities: () => ["analysis"],
	};
	const context = { subscriptions: [] };
	const plugin = createPlugin({ vscode, host, engine, startServer: async () => ({ stop: async () => {} }), context });
	return { root, planPath, folder, vscode, commands, messages, context, plugin, getProvider: () => provider, getRefreshOptions: () => refreshOptions };
}

test("uses an open dirty plan snapshot instead of stale on-disk JSON", async (t) => {
	const fixture = makePlugin(t, "{ invalid disk content");
	fixture.plugin.activate();
	const outcome = await fixture.getProvider().provideDiagnostics({
		workspaceFolder: fixture.folder,
		workspaceRoot: fixture.root,
		documents: [{ path: "preflight.json", text: JSON.stringify({ steps: [{ id: "buffer-plan" }] }), isDirty: true }],
		options: {},
	});
	assert.equal(outcome.status, "passed");
	assert.equal(outcome.request.plan.steps[0].id, "buffer-plan");
	assert.equal(fs.readFileSync(fixture.planPath, "utf8"), "{ invalid disk content");
	await fixture.plugin.dispose();
});

test("reports invalid unsaved plan text and supports explicit rehearsal refresh", async (t) => {
	const fixture = makePlugin(t, JSON.stringify({ steps: [{ id: "saved-plan" }] }));
	fixture.plugin.activate();
	const outcome = await fixture.getProvider().provideDiagnostics({
		workspaceFolder: fixture.folder,
		workspaceRoot: fixture.root,
		documents: [{ path: "preflight.json", text: "{ invalid buffer", isDirty: true }],
		options: {},
	});
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.diagnostics[0].code, "plan-read");
	await fixture.commands.get("preflight.rehearse")();
	assert.equal(fixture.getRefreshOptions().mode, "rehearse");
	assert.equal(fs.readFileSync(fixture.planPath, "utf8"), JSON.stringify({ steps: [{ id: "saved-plan" }] }));
	await fixture.plugin.dispose();
});

test("registers a namespaced host provider and preserves the engine API", async (t) => {
	const fixture = makePlugin(t, JSON.stringify({ steps: [{ id: "saved-plan" }] }));
	const api = fixture.plugin.activate();
	assert.equal(fixture.getProvider().id, PROVIDER_ID);
	assert.equal(api.getCapabilities()[0], "analysis");
	assert.deepEqual(api.getEditorDiagnostics(), []);
	await fixture.plugin.dispose();
});
