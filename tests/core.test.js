"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { Preflight, validatePlan } = require("../src/core");
const { executeRehearsal } = require("../src/rehearsal");
const { startServer } = require("../src/server");

const workspace = path.resolve(__dirname, "..");
const validPlan = {
	steps: [
		{ id: "build", command: ["node", "--version"], outputs: ["build/output.txt"] },
		{ id: "test", needs: ["build"], command: ["node", "--test"] },
	],
};

test("valid plan builds a dependency order", () => {
	const result = validatePlan(validPlan, workspace);
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.order.map((item) => item.id), ["build", "test"]);
});

test("missing execution plan is incomplete, never a pass", async () => {
	const result = await new Preflight().analyze({ workspace });
	assert.equal(result.status, "incomplete");
	assert.equal(result.diagnostics[0].code, "plan-missing");
});

test("an empty plan is incomplete", async () => {
	const result = await new Preflight().analyze({ workspace, plan: { steps: [] } });
	assert.equal(result.status, "incomplete");
	assert.equal(result.diagnostics[0].code, "plan-empty");
});

test("duplicate outputs, missing dependencies, and cycles are errors", async () => {
	const plan = {
		steps: [
			{ id: "a", needs: ["b"], outputs: ["dist"] },
			{ id: "b", needs: ["a", "missing"], outputs: ["dist"] },
		],
	};
	const result = await new Preflight().analyze({ workspace, plan });
	assert.equal(result.status, "failed");
	const codes = result.diagnostics.map((item) => item.code);
	assert.ok(codes.includes("output-collision"));
	assert.ok(codes.includes("unknown-dependency"));
	assert.ok(codes.includes("dependency-cycle"));
});

test("steps cannot escape the workspace", async () => {
	const plan = { steps: [{ id: "unsafe", cwd: "../elsewhere", inputs: ["../../secret"], outputs: ["/tmp/unsafe"] }] };
	const result = await new Preflight().analyze({ workspace, plan });
	assert.equal(result.status, "failed");
	assert.ok(result.diagnostics.some((item) => item.code === "invalid-cwd"));
	assert.ok(result.diagnostics.some((item) => item.code === "invalid-input"));
	assert.ok(result.diagnostics.some((item) => item.code === "invalid-output"));
});

test("providers can be registered and disposed", async () => {
	const preflight = new Preflight();
	const subscription = preflight.registerProvider({
		id: "sample",
		analyze: async () => ({ diagnostics: [{ message: "An external contract failed.", severity: "warning" }] }),
	});
	const result = await preflight.analyze({ workspace, plan: validPlan });
	assert.equal(result.status, "passed");
	assert.equal(result.diagnostics[0].source, "sample");
	subscription.dispose();
	const next = await preflight.analyze({ workspace, plan: validPlan });
	assert.equal(next.diagnostics.length, 0);
});

test("rehearsal delegates to its isolated executor and streams step results", async () => {
	const preflight = new Preflight({
		executor: async ({ steps, onStep }) => {
			for (const step of steps) onStep({ id: step.id, status: "passed", durationMs: 1 });
			return { diagnostics: [], incomplete: false };
		},
	});
	const result = await preflight.rehearse({ workspace, plan: validPlan, image: "local-image" });
	assert.equal(result.status, "passed");
	assert.equal(result.steps[0].id, "build");
});

test("rehearsal without an image is incomplete", async () => {
	const result = await executeRehearsal({ workspace, steps: [], image: "" });
	assert.equal(result.incomplete, true);
	assert.equal(result.diagnostics[0].code, "image-missing");
});

test("loopback API requires its token and exports diagnostics", async (t) => {
	const preflight = new Preflight();
	const server = await startServer({
		preflight,
		workspace,
		publishEndpoint: false,
		editorDiagnostics: () => [{
			path: "src/core.js", line: 1, column: 1,
			severity: "warning", source: "test", code: "", message: "Example diagnostic",
		}],
	});
	t.after(() => server.stop());
	const base = "http://127.0.0.1:" + server.endpoint.port;
	const unauthorized = await fetch(base + "/editor/diagnostics");
	assert.equal(unauthorized.status, 401);
	const headers = { authorization: "Bearer " + server.endpoint.token };
	const editor = await fetch(base + "/editor/diagnostics", { headers });
	assert.equal((await editor.json()).diagnostics[0].message, "Example diagnostic");
	const response = await fetch(base + "/analyze", {
		method: "POST", headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({ workspace, plan: validPlan }),
	});
	assert.equal(response.status, 202);
	const run = await response.json();
	assert.match(run.id, /^[a-f0-9-]+$/);
	const completed = await preflight.analyze({ workspace, plan: validPlan });
	assert.equal(completed.status, "passed");
});

test("dynamic plans and custom environments preserve outcome coverage", async () => {
	const preflight = new Preflight();
	const provider = { resolve: async ({ entry }) => ({ steps: [{ id: entry }, { id: "publish", needs: [entry] }] }) };
	const environment = { execute: async ({ onStep, env }) => {
		onStep({ id: "build", status: "passed", stdout: env.TOKEN, extension: "retained" });
		return {};
	} };
	const request = { workspace, provider, entry: "build", environment, env: { TOKEN: "secret-value" } };
	assert.equal((await preflight.analyze(request)).status, "passed");
	const run = await preflight.rehearse(request);
	assert.equal(run.status, "incomplete");
	assert.equal(run.steps[0].stdout, "[redacted]");
	assert.equal(run.steps[0].extension, "retained");
});

test("plan endpoint returns a completed graph for the requested entry", async (t) => {
	const server = await startServer({
		preflight: new Preflight(),
		workspace,
		publishEndpoint: false,
		provider: {
			resolve: ({ entry }) => ({ entry, steps: [
				{ id: "publish", needs: [entry] },
				{ id: entry, outputs: ["build/artifact"] },
				{ id: "unrelated" },
			] }),
		},
	});
	t.after(() => server.stop());
	const url = "http://127.0.0.1:" + server.endpoint.port + "/plan";
	const request = (body, token = server.endpoint.token) => fetch(url, {
		method: "POST",
		headers: { authorization: "Bearer " + token, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	assert.equal((await request({}, "invalid")).status, 401);
	assert.equal((await request({ workspace: workspace + "-other" })).status, 403);
	assert.equal((await request({ entry: [] })).status, 400);
	const response = await request({ entry: "build", target: "publish" });
	assert.equal(response.status, 200);
	const run = await response.json();
	assert.equal(run.status, "passed");
	assert.equal(run.entry, "build");
	assert.equal(run.target, "publish");
	assert.deepEqual(run.requirements.map(({ id, needs, outputs }) => ({ id, needs, outputs })), [
		{ id: "build", needs: [], outputs: ["build/artifact"] },
		{ id: "publish", needs: ["build"], outputs: [] },
	]);
	const invalid = await request({ plan: { steps: [{ id: "build", needs: ["missing"] }] } });
	assert.equal((await invalid.json()).status, "failed");
});
