"use strict";

const path = require("node:path");

function activate({ vscode, subscriptions, workspaceFolder }) {
	const root = workspaceFolder.uri?.fsPath || workspaceFolder.fsPath;
	const collection = vscode.languages.createDiagnosticCollection("preflight");
	const status = vscode.window.createStatusBarItem();
	subscriptions.push(collection, status);
	return {
		publish(result) {
			const grouped = new Map();
			for (const finding of result.diagnostics) {
				const uri = vscode.Uri.file(path.resolve(root, finding.path));
				const key = uri.toString();
				if (!grouped.has(key)) grouped.set(key, [uri, []]);
				const line = finding.line - 1;
				const column = finding.column - 1;
				const severity = { error: 0, warning: 1, information: 2, hint: 3 }[finding.severity];
				const entry = new vscode.Diagnostic(new vscode.Range(line, column, line, column + 1), finding.message, severity);
				entry.source = finding.source;
				entry.code = finding.code;
				grouped.get(key)[1].push(entry);
			}
			collection.clear();
			collection.set([...grouped.values()]);
			status.text = "Preflight " + result.status;
			status.show();
		},
	};
}
module.exports = { activate };
