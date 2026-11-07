"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const OUTPUT_LIMIT = 64 * 1024;
const EXCLUDED = new Set([".git", "node_modules", ".env", ".aws", ".ssh", ".preflight"]);

function finding(code, message, severity = "warning") {
	return { path: "preflight.json", line: 1, column: 1, severity, code, source: "Preflight/Rehearsal", message };
}

function runProcess(executable, args, timeoutMs, abortSignal) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let finished = false;
		let timedOut = false;
		let timer;
		const finish = (result) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			abortSignal?.removeEventListener("abort", cancel);
			resolve({ stdout, stderr, timedOut, ...result });
		};
		let child;
		const cancel = () => child?.kill("SIGKILL");
		try {
			child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			finish({ code: null, error: error.message });
			return;
		}
		child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT); });
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT); });
		child.on("error", (error) => finish({ code: null, error: error.message }));
		child.on("close", (code, signal) => finish({ code, signal }));
		abortSignal?.addEventListener("abort", cancel, { once: true });
		if (abortSignal?.aborted) cancel();
		timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
	});
}

async function executeRehearsal(options) {
	const { workspace, steps, image, signal, profile, onStep = () => {} } = options;
	const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
		? Math.min(options.timeoutMs, 600000) : 120000;
	if (typeof image !== "string" || !image.trim()) {
		return { incomplete: true, diagnostics: [finding("image-missing", "Rehearsal requires an explicit locally available Docker image.")] };
	}
	const daemon = await runProcess("docker", ["info", "--format", "{{.ServerVersion}}"], 10000);
	if (daemon.error || daemon.code !== 0) {
		return { incomplete: true, diagnostics: [finding("docker-unavailable", "Docker is unavailable: " + (daemon.error || daemon.stderr.trim() || "daemon not running"))] };
	}

	const imageCheck = await runProcess("docker", ["image", "inspect", image], 10000);
	if (imageCheck.code !== 0 || imageCheck.error) {
		return { incomplete: true, diagnostics: [finding("image-unavailable", "Docker image is not available locally: " + image)] };
	}

	const diagnostics = [];
	const outcomes = new Map();
	let incomplete = false;
	let temporary;
	try {
		temporary = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-rehearsal-"));
		const staging = path.join(temporary, "workspace");
		await fs.cp(workspace, staging, {
			recursive: true,
			dereference: false,
			filter: (source) => {
				const relative = path.relative(workspace, source);
				if (!relative || relative === ".") return true;
				return source !== options.envFile && !relative.split(path.sep).some((part) => EXCLUDED.has(part) || part.startsWith(".env."));
			},
		});
		for (const step of steps) {
			if (signal?.aborted) {
				incomplete = true;
				break;
			}
			const start = Date.now();
			const substitute = Object.hasOwn(profile?.substitutes ?? {}, step.id) ? profile.substitutes[step.id] : undefined;
			const substituted = typeof substitute?.service === "string" && Array.isArray(substitute.command) && substitute.command.length > 0 && substitute.command.every(part => typeof part === "string");
			const command = substituted ? substitute.command : step.command;
			const dependencies = Array.isArray(step.needs) ? step.needs : [];
			const effects = Array.isArray(step.effects) ? step.effects : [];
			let result;
			if (dependencies.some((id) => outcomes.get(id) !== "passed")) {
				result = { id: step.id, status: "skipped", reason: "A dependency did not pass.", durationMs: 0 };
				incomplete = true;
			} else if (!substituted && effects.some((effect) => effect !== "read" && effect !== "local")) {
				result = { id: step.id, status: "skipped", reason: "External or publication effects are not rehearsed.", durationMs: 0 };
				incomplete = true;
			} else if (!Array.isArray(command) || command.length === 0) {
				result = { id: step.id, status: "skipped", reason: "No executable command was supplied.", durationMs: 0 };
				incomplete = true;
			} else {
				const workingDirectory = path.posix.join("/workspace", (step.cwd || ".").replace(/\\/g, "/"));
				const container = "preflight-" + randomUUID();
				const args = [
					"run", "--rm", "--name", container, "--pull", "never", "--network", "none",
					"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
					"--pids-limit", "256", "--memory", "2g", "--cpus", "2",
					"--read-only", "--tmpfs", "/tmp:rw,nosuid,size=64m",
					"--mount", "type=bind,source=" + staging + ",target=/workspace",
					"--workdir", workingDirectory, image, ...command,
				];
				const execution = await runProcess("docker", args, timeoutMs, signal);
				if (execution.timedOut || signal?.aborted) {
					await runProcess("docker", ["rm", "-f", container], 10000);
				}
				if (signal?.aborted) {
					incomplete = true;
					break;
				}
				const passed = execution.code === 0 && !execution.timedOut && !execution.error;
				result = {
					id: step.id, status: passed ? "passed" : "failed",
					exitCode: execution.code, durationMs: Date.now() - start,
					stdout: execution.stdout, stderr: execution.stderr,
					...(substituted ? { coverage: "substitute", service: substitute.service } : {}),
				};
				if (!passed) {
					const reason = execution.timedOut ? "timed out" : execution.error || "exited with " + execution.code;
					diagnostics.push(finding("step-failed", "Rehearsal step " + step.id + " " + reason + ".", "error"));
				}
			}
			outcomes.set(step.id, result.status);
			onStep(result);
		}
	} catch (error) {
		incomplete = true;
		diagnostics.push(finding("rehearsal-unavailable", "Could not complete isolated rehearsal: " + error.message));
	} finally {
		if (temporary) await fs.rm(temporary, { recursive: true, force: true });
	}
	return { incomplete, diagnostics };
}

module.exports = { executeRehearsal, runProcess };
