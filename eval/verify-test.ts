import fs from "node:fs";
import path from "node:path";
import { classifyVerifyRun, runVerifyChecks, verifyProgressMessage, type VerifyProgressEvent } from "../extensions/scrutiny/verify.ts";
import type { ScrutinyConfig, VerifyCheck, VerifyReport } from "../extensions/scrutiny/types.ts";

/**
 * Unit test for the objective verify module (issue #10): runVerifyChecks owns
 * check execution, timeout behavior, output truncation, diff stat, and report
 * counts. Uses a fake exec so no real subprocesses run. Uses the _ts-resolve
 * hook to import extension sources. Run: `npm run eval:verify`.
 */

const failures: Array<{ name: string; error: string }> = [];
let checks = 0;

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
	checks += 1;
	try {
		await run();
		process.stdout.write(`  ✓ ${name}\n`);
	} catch (error) {
		failures.push({ name, error: error instanceof Error ? error.message : String(error) });
		process.stdout.write(`  ✕ ${name}\n`);
	}
}
function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}
function eq<T>(actual: T, expected: T, label: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

type Exec = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

function makeConfig(checks: Array<{ name: string; command: string; args?: string[]; timeoutMs?: number }>): ScrutinyConfig {
	return {
		panel: [],
		maxPanelModels: 4,
		maxPanelOutputChars: 1000,
		maxJudgeOutputChars: 1000,
		panelTimeoutMs: 1000,
		judgeTimeoutMs: 1000,
		verifyTimeoutMs: 5000,
		includeGitDiff: true,
		gitDiffCharLimit: 1000,
		tools: [],
		verifyChecks: checks,
		councils: [],
		configSources: [],
	};
}

function mockExec(handlers: Record<string, () => { stdout?: string; stderr?: string; code?: number } | { throw: string }>, gitDiffStat?: string): Exec {
	return async (command, args) => {
		if (command === "git" && args[0] === "diff" && args[1] === "--stat") return { stdout: gitDiffStat ?? "", code: 0 };
		const key = `${command} ${(args ?? []).join(" ")}`.trim();
		const handler = handlers[key];
		if (!handler) return { stdout: "", code: 127 };
		const result = handler();
		if (result && "throw" in result) throw new Error(result.throw);
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
	};
}

async function main(): Promise<void> {
	process.stdout.write(`scrutiny verify · 10 checks\n`);

	await check("runVerifyChecks records pass/fail/error with counts and diff stat", async () => {
		const config = makeConfig([
			{ name: "typecheck", command: "npm", args: ["run", "check"] },
			{ name: "tests", command: "npm", args: ["test"] },
			{ name: "lint", command: "npm", args: ["run", "lint"] },
		]);
		const exec = mockExec({
			"npm run check": () => ({ stdout: "ok", code: 0 }),
			"npm test": () => ({ stdout: "fail", stderr: "1 test failed", code: 1 }),
			"npm run lint": () => ({ throw: "spawn crashed" }),
		}, "src/a.ts | 2 +-\n");
		const report = await runVerifyChecks({ cwd: "/tmp", exec, config });
		eq(report.passed, 1, "passed count");
		eq(report.failed, 2, "failed count (fail + error)");
		eq(report.skipped, 0, "skipped count");
		eq(report.checks.map((c) => c.status), ["pass", "fail", "error"], "per-check status");
		eq(report.checks[0]!.command, "npm run check", "command recorded");
		assert(Boolean(report.checks[1]!.output?.includes("1 test failed")), "fail output captured");
		assert(Boolean(report.checks[2]!.output?.includes("spawn crashed")), "error output captured");
		eq(report.diffStat, "src/a.ts | 2 +-", "diff stat captured (trimmed)");
		assert(report.durationMs >= 0, "duration recorded");
	});

	await check("runVerifyChecks truncates large output", async () => {
		const big = "x".repeat(10_000);
		const config = makeConfig([{ name: "tests", command: "npm", args: ["test"] }]);
		const exec = mockExec({ "npm test": () => ({ stdout: big, code: 1 }) });
		const report = await runVerifyChecks({ cwd: "/tmp", exec, config });
		assert((report.checks[0]!.output?.length ?? 0) <= 4_200, `output truncated (got ${report.checks[0]!.output?.length})`);
		assert(Boolean(report.checks[0]!.output?.includes("[truncated")), "truncation marker present");
	})

	await check("runVerifyChecks emits running then terminal progress per check", async () => {
		const config = makeConfig([{ name: "typecheck", command: "npm", args: ["run", "check"] }]);
		const exec = mockExec({ "npm run check": () => ({ stdout: "ok", code: 0 }) });
		const events: VerifyProgressEvent[] = [];
		await runVerifyChecks({ cwd: "/tmp", exec, config, onCheckProgress: (e) => events.push(e) });
		eq(events.map((e) => e.status), ["running", "pass"], "progress sequence");
		eq(events[0]!.index, 0, "index 0");
		eq(events[0]!.total, 1, "total 1");
		assert(events[1]!.durationMs !== undefined, "terminal event has duration");
	})

	await check("runVerifyChecks handles empty check list", async () => {
		const config = makeConfig([]);
		const exec = mockExec({});
		const report = await runVerifyChecks({ cwd: "/tmp", exec, config });
		eq(report, { checks: [], diffStat: undefined, passed: 0, failed: 0, skipped: 0, durationMs: report.durationMs }, "empty report shape");
	})

	await check("runVerifyChecks treats nonzero exit as fail, zero as pass", async () => {
		const config = makeConfig([
			{ name: "ok", command: "true", args: [] },
			{ name: "bad", command: "false", args: [] },
		]);
		const exec = mockExec({ "true": () => ({ code: 0 }), "false": () => ({ code: 2 }) });
		const report = await runVerifyChecks({ cwd: "/tmp", exec, config });
		eq(report.checks.map((c) => c.status), ["pass", "fail"], "exit-code -> status");
		eq(report.checks[1]!.exitCode, 2, "exit code recorded");
	})

	await check("verifyProgressMessage formats running and terminal events", () => {
		eq(verifyProgressMessage({ name: "typecheck", index: 0, total: 3, status: "running" }), "verify 1/3: typecheck running", "running message");
		eq(verifyProgressMessage({ name: "tests", index: 1, total: 3, status: "fail", durationMs: 1200 }), "verify 2/3: tests fail in 1.2s", "terminal message");
	})

	await check("engine does not re-declare verify execution", () => {
		const engine = fs.readFileSync(path.resolve(process.cwd(), "extensions", "scrutiny", "engine.ts"), "utf8");
		for (const pattern of ["function runVerify(", "function verifyProgressMessage", "type VerifyProgressEvent"]) {
			assert(!engine.includes(pattern), `engine.ts re-declares "${pattern}" (must live in verify.ts)`);
		}
		assert(engine.includes("runVerifyChecks"), "engine.ts calls runVerifyChecks from verify.ts");
	});

	await check("classifyVerifyRun: all-pass -> ok, not failed", () => {
		const report: VerifyReport = { checks: [{ name: "typecheck", command: "npm run check", status: "pass", exitCode: 0, durationMs: 10 }], diffStat: undefined, passed: 1, failed: 0, skipped: 0, durationMs: 10 };
		const v = classifyVerifyRun(report);
		eq(v.runStatus, "ok", "runStatus ok");
		assert(!v.verifyFailed, "not failed");
		eq(v.failedChecks, [], "no failed checks");
		assert(v.summary.includes("1 pass"), "summary has pass count");
	});

	await check("classifyVerifyRun: failing checks -> ok run, verifyFailed true, names listed", () => {
		const report: VerifyReport = {
			checks: [
				{ name: "typecheck", command: "npm run check", status: "pass", exitCode: 0, durationMs: 10 },
				{ name: "tests", command: "npm test", status: "fail", exitCode: 1, durationMs: 20 },
				{ name: "lint", command: "npm run lint", status: "error", durationMs: 5 },
			],
			diffStat: undefined, passed: 1, failed: 2, skipped: 0, durationMs: 35,
		};
		const v = classifyVerifyRun(report);
		eq(v.runStatus, "ok", "run still ok — check failures are findings, not run failure");
		assert(v.verifyFailed, "verifyFailed true");
		eq(v.failedChecks, ["tests", "lint"], "failed + errored check names listed");
	});

	await check("verify_failed reason is not set or declared anywhere", () => {
		const extDir = path.resolve(process.cwd(), "extensions", "scrutiny");
		const files = fs.readdirSync(extDir).filter((f) => f.endsWith(".ts"));
		for (const file of files) {
			const src = fs.readFileSync(path.join(extDir, file), "utf8");
			assert(!src.includes("verify_failed"), `${file}: references dead "verify_failed" reason (policy: verify completed = ok)`);
		}
		const typesSrc = fs.readFileSync(path.join(extDir, "types.ts"), "utf8");
		assert(!typesSrc.includes("verify_failed"), "types.ts still declares verify_failed (remove it; policy is verify-completed = ok)");
	});

	const pass = checks - failures.length;
	process.stdout.write(`\nsuite: verify · ${pass}/${checks} pass · ${failures.length} fail\n`);
	if (failures.length > 0) {
		process.stdout.write("\nfailures:\n");
		for (const f of failures) process.stdout.write(`- ${f.name}: ${f.error}\n`);
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

main();
