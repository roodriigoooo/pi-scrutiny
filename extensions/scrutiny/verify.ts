import type { ScrutinyConfig, VerifyCheck, VerifyReport } from "./types.js";
import { formatDuration, truncate } from "./util.js";

/**
 * Objective verify module: owns check execution, timeout behavior, output
 * truncation, diff stat, and report counts. Engine calls runVerifyChecks and
 * routes progress; it does not know check-execution details (issue #10).
 *
 * Verify is the real arbiter. No LLM judge lives here.
 */

type ExecLike = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

export type VerifyProgressEvent = {
	name: string;
	index: number;
	total: number;
	status: "running" | "pass" | "fail" | "error";
	durationMs?: number;
};

const OUTPUT_CHAR_LIMIT = 4_000;
const DIFF_STAT_CHAR_LIMIT = 2_000;
const DIFF_STAT_TIMEOUT_MS = 5_000;

export async function runVerifyChecks(input: {
	cwd: string;
	exec: ExecLike;
	config: ScrutinyConfig;
	signal?: AbortSignal;
	onCheckProgress?: (event: VerifyProgressEvent) => void;
}): Promise<VerifyReport> {
	const startedAt = Date.now();
	const checks: VerifyCheck[] = [];
	const total = input.config.verifyChecks.length;
	for (let index = 0; index < total; index++) {
		const spec = input.config.verifyChecks[index]!;
		const checkStart = Date.now();
		input.onCheckProgress?.({ name: spec.name, index, total, status: "running" });
		try {
			const result = await input.exec(spec.command, spec.args ?? [], { timeout: spec.timeoutMs ?? input.config.verifyTimeoutMs, signal: input.signal });
			const durationMs = Date.now() - checkStart;
			const code = result.code ?? 0;
			const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
			const status: VerifyCheck["status"] = code === 0 ? "pass" : "fail";
			checks.push({ name: spec.name, command: `${spec.command} ${(spec.args ?? []).join(" ")}`.trim(), status, exitCode: code, output: truncate(output, OUTPUT_CHAR_LIMIT), durationMs });
			input.onCheckProgress?.({ name: spec.name, index, total, status, durationMs });
		} catch (error) {
			const durationMs = Date.now() - checkStart;
			checks.push({ name: spec.name, command: `${spec.command} ${(spec.args ?? []).join(" ")}`.trim(), status: "error", output: error instanceof Error ? error.message : String(error), durationMs });
			input.onCheckProgress?.({ name: spec.name, index, total, status: "error", durationMs });
		}
	}
	const diffStat = await readDiffStat(input.exec, input.signal);
	const passed = checks.filter((c) => c.status === "pass").length;
	const failed = checks.filter((c) => c.status === "fail" || c.status === "error").length;
	const skipped = checks.filter((c) => c.status === "skipped").length;
	return { checks, diffStat, passed, failed, skipped, durationMs: Date.now() - startedAt };
}

export function verifyProgressMessage(event: VerifyProgressEvent): string {
	const pos = `${event.index + 1}/${event.total}`;
	if (event.status === "running") return `verify ${pos}: ${event.name} running`;
	return `verify ${pos}: ${event.name} ${event.status}${event.durationMs !== undefined ? ` in ${formatDuration(event.durationMs)}` : ""}`;
}

export type VerifyRunClassification = {
	/** Always "ok" when a verify report exists: verify completed. Check failures are findings, not run failures. */
	runStatus: "ok";
	/** True when any check failed or errored. */
	verifyFailed: boolean;
	failedChecks: string[];
	summary: string;
};

/**
 * Verify status policy (issue #11):
 * - A scrutiny run with a completed verify report is status "ok". Verify is the
 *   objective arbiter; failing checks are findings reported in the verify
 *   report, not a scrutiny run failure. A run failure means the run itself
 *   broke (missing_panel, all_panels_failed, judge_failed, recursion_capped,
 *   unexpected_error) — never "checks found problems."
 * - No verify-specific failure reason exists. If verify cannot produce a
 *   report in the future, that would surface as unexpected_error, not a check fail.
 */
export function classifyVerifyRun(report: VerifyReport): VerifyRunClassification {
	const failedChecks = report.checks.filter((c) => c.status === "fail" || c.status === "error").map((c) => c.name);
	return {
		runStatus: "ok",
		verifyFailed: report.failed > 0,
		failedChecks,
		summary: `${report.passed} pass · ${report.failed} fail · ${report.skipped} skipped`,
	};
}

async function readDiffStat(exec: ExecLike, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const stat = await exec("git", ["diff", "--stat"], { timeout: DIFF_STAT_TIMEOUT_MS, signal });
		if (stat.code === 0 && stat.stdout?.trim()) return truncate(stat.stdout.trim(), DIFF_STAT_CHAR_LIMIT);
	} catch {
		// diff stat is optional; never fail verify on it
	}
	return undefined;
}
