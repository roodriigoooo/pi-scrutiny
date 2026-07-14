import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EvalRunRecord, EvalTask, ScrutinyResultJson } from "./types.ts";

const SCRUTINY_ENTRY = path.resolve(process.cwd(), "extensions/scrutiny.ts");

export type RunOptions = {
	timeoutMs: number;
	/** Extra env merged onto process.env for the child. */
	env?: Record<string, string>;
};

/**
 * Black-box runner: spawns the real `pi` command path a user would hit,
 * parses the JSON event stream, locates the result.json on disk, and runs
 * the task's expectations. Returns a run record without ever importing engine code.
 */
export async function runTask(task: EvalTask, opts: RunOptions): Promise<EvalRunRecord> {
	const startedAt = Date.now();
	const childEnv = { ...process.env, ...(task.councilEnv ?? {}), ...(task.panelEnv ? { PI_SCRUTINY_PANEL: task.panelEnv } : {}) };

	const stdout = await spawnScrutiny(task, childEnv, opts.timeoutMs);
	const parsed = parseLatestResult(stdout);
	const durationMs = Date.now() - startedAt;

	const runDir = parsed.status === "ok" ? parsed.runDir : parsed.status === "error" ? parsed.runDir : undefined;
	let result: ScrutinyResultJson | undefined;
	if (runDir && fs.existsSync(path.join(runDir, "result.json"))) {
		try {
			result = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8")) as ScrutinyResultJson;
		} catch {
			// result.json may be missing on hard failures; carry on
		}
	}

	const expectations = (task.expect ?? []).map((exp) => {
		try {
			return { name: exp.name, pass: Boolean(exp.check({ result, stdout, runDir })) };
		} catch (error) {
			return { name: exp.name, pass: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	if (expectations.length === 0) {
		// no expectations: classify from what we observed
		if (parsed.status === "skipped") return { taskId: task.id, surface: task.surface, status: "skipped", durationMs, error: parsed.error, stdoutSnippet: snippet(stdout) };
		if (parsed.status === "error" && !result) return { taskId: task.id, surface: task.surface, status: "error", durationMs, error: parsed.error, runDir, stdoutSnippet: snippet(stdout) };
		return { taskId: task.id, surface: task.surface, status: "pass", durationMs, runDir, result, stdoutSnippet: snippet(stdout) };
	}
	const allPass = expectations.every((e) => e.pass);
	const status: EvalRunRecord["status"] = allPass ? "pass" : "fail";
	return { taskId: task.id, surface: task.surface, status, durationMs, expectations, runDir, result, stdoutSnippet: snippet(stdout) };
}

function spawnScrutiny(task: EvalTask, env: Record<string, string>, timeoutMs: number): Promise<string> {
	return new Promise((resolve) => {
		const args = ["--no-extensions", "-e", SCRUTINY_ENTRY, "--mode", "json", "--no-session", task.prompt];
		const proc = spawn("pi", args, { cwd: process.cwd(), shell: false, stdio: ["ignore", "pipe", "pipe"], env });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
		}, timeoutMs);
		proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		proc.on("close", () => {
			clearTimeout(timer);
			if (timedOut) stdout += `\n[eval: timed out after ${timeoutMs}ms]\n`;
			if (stderr.trim()) stdout += `\n[eval stderr]\n${stderr.trim()}\n`;
			resolve(stdout);
		});
		proc.on("error", (error) => {
			clearTimeout(timer);
			resolve(`[eval: spawn error] ${error instanceof Error ? error.message : String(error)}\n`);
		});
	});
}

type Parsed =
	| { status: "ok"; runId: string; runDir: string }
	| { status: "skipped"; error: string }
	| { status: "error"; error: string; runDir?: string };

function parseLatestResult(stdout: string): Parsed {
	const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
	let runId: string | undefined;
	let runDir: string | undefined;
	let lastError: string | undefined;
	let sawResult = false;
	for (const line of lines) {
		let event: any;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type === "message_start" || event.type === "message_end") {
			const details = event.message?.details;
			if (details && typeof details === "object") {
				if (typeof details.runId === "string") runId = details.runId;
				if (typeof details.runDir === "string") runDir = details.runDir;
				if (details.status === "detached") { /* not used in inline mode */ }
				if (details.status === "error" && typeof details.error === "string") lastError = details.error;
				if (details.status === "ok" || details.status === "error") sawResult = true;
			}
		}
	}
	// Infer runDir from the message's own runId (reliable; every run path writes result.json)
	if (!runDir && runId) {
		const base = path.join(process.cwd(), ".pi", "scrutiny", runId);
		if (fs.existsSync(base)) runDir = base;
	}
	if (runId && runDir) return { status: "ok", runId, runDir };
	if (sawResult) return { status: "error", error: lastError ?? "result message had no runId/runDir", runDir };
	// message-only task (help/models/templates/runs): no run artifacts, not an error
	return { status: "skipped", error: lastError ?? "no scrutiny run in this task" };
}

function snippet(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= 600) return trimmed;
	return `${trimmed.slice(0, 300)}\n…[truncated ${trimmed.length - 600} chars]…\n${trimmed.slice(-300)}`;
}
