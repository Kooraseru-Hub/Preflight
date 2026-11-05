"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const packageManifest = require("../package.json");
const { activateWith, deactivate, HOST_EXTENSION_ID } = require("../vscode/extension");

test("activates as a plugin through the declared generic host dependency", async () => {
	const commands = new Map();
	const provider = { dispose() {}, refresh: async () => ({ status: "passed", diagnostics: [] }) };
	const host = {
		apiVersion: 1,
		getWorkspaceFolders: () => [],
		registerDiagnosticProvider: (value) => { assert.equal(value.id, "preflight.execution-plan"); return provider; },
		onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
	};
	const vscode = {
		extensions: { getExtension: (id) => { assert.equal(id, HOST_EXTENSION_ID); return { isActive: true, exports: host }; } },
		workspace: {},
		commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() { commands.delete(name); } }; } },
	};
	const context = { subscriptions: [] };
	const api = await activateWith(vscode, context, {
		engine: {
			analyze: async () => ({ status: "passed", diagnostics: [] }),
			rehearse: async () => ({ status: "passed", diagnostics: [] }),
			getRun: () => undefined,
			getDiagnostics: () => undefined,
			subscribe: () => ({ dispose() {} }),
			registerProvider: () => ({ dispose() {} }),
			getCapabilities: () => ["analysis"],
		},
		startServer: async () => ({ stop: async () => {} }),
	});
	assert.equal(api.getCapabilities()[0], "analysis");
	assert.ok(commands.has("preflight.analyze"));
	assert.ok(packageManifest.extensionDependencies.includes(HOST_EXTENSION_ID));
	await deactivate();
});
