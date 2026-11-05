"use strict";

const { Preflight } = require("../src/core");
const { startServer } = require("../src/server");
const { createPlugin } = require("./plugin");

const HOST_EXTENSION_ID = "kooraseru-hub.vscode-extension-host";
const engine = new Preflight();
let activePlugin;

async function activateWith(vscode, context, dependencies = {}) {
	const hostExtension = vscode.extensions.getExtension(HOST_EXTENSION_ID);
	if (!hostExtension) throw new Error("Kooraseru Extension Host is required by Preflight.");
	const host = hostExtension.isActive ? hostExtension.exports : await hostExtension.activate();
	if (!host || host.apiVersion !== 1 || typeof host.registerDiagnosticProvider !== "function") {
		throw new Error("The installed Kooraseru Extension Host does not provide the required API.");
	}
	activePlugin = createPlugin({
		vscode,
		host,
		engine: dependencies.engine || engine,
		startServer: dependencies.startServer || startServer,
		context,
	});
	const api = activePlugin.activate();
	context.subscriptions.push({ dispose: () => { void activePlugin?.dispose(); } });
	return api;
}

async function activate(context) {
	return activateWith(require("vscode"), context);
}

async function deactivate() {
	await activePlugin?.dispose();
	activePlugin = undefined;
}

module.exports = { activate, activateWith, deactivate, HOST_EXTENSION_ID };
