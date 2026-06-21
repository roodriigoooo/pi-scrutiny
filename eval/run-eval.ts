import fs from "node:fs";
import path from "node:path";
import { SMOKE_SUITE, SMOKE_SUITE_META } from "./suites.ts";
import { runTask } from "./runner.ts";
import type { EvalReport, EvalRunRecord, EvalTask } from "./types.ts";

const SUITES = new Map<string, { meta: { name: string; description: string }; tasks: EvalTask[] }>([
	[SMOKE_SUITE_META.name, { meta: SMOKE_SUITE_META, tasks: SMOKE_SUITE }],
]);

const DEFAULT_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
	const suiteName = process.argv[2] ?? "smoke";
	const suite = SUITES.get(suiteName);
	if (!suite) {
		console.error(`unknown suite: ${suiteName}. available: ${[...SUITES.keys()].join(", ")}`);
		process.exit(2);
	}
	const outDir = path.resolve(process.cwd(), "eval", "out");
	fs.mkdirSync(outDir, { recursive: true });

	const runs: EvalRunRecord[] = [];
	for (const task of suite.tasks) {
		if (task.requiresPanel && !process.env.PI_SCRUTINY_PANEL && !(task.panelEnv || task.councilEnv?.PI_SCRUTINY_PANEL)) {
			// honor explicit empty-panel intent (missing-panel-gate test), otherwise skip
		}
		process.stdout.write(`▶ ${task.id} (${task.surface}) … `);
		const run = await runTask(task, { timeoutMs: DEFAULT_TIMEOUT_MS });
		runs.push(run);
		process.stdout.write(`${run.status} ${run.durationMs}ms${run.expectations ? ` [${run.expectations.filter((e) => e.pass).length}/${run.expectations.length}]` : ""}\n`);
	}

	const startedAt = runs[0] ? Date.now() - runs.reduce((s, r) => s + r.durationMs, 0) : Date.now();
	const endedAt = Date.now();
	const report: EvalReport = {
		suite: suite.meta.name,
		startedAt,
		endedAt,
		durationMs: endedAt - startedAt,
		runs,
		summary: summarize(runs),
	};

	const jsonPath = path.join(outDir, `${suite.meta.name}.report.json`);
	const mdPath = path.join(outDir, `${suite.meta.name}.report.md`);
	fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
	fs.writeFileSync(mdPath, renderMarkdown(report, suite.meta.description));
	console.log("");
	console.log(renderSummary(report));
	console.log(`\nreport: ${mdPath}`);
	console.log(`json:   ${jsonPath}`);
	process.exit(report.summary.fail + report.summary.error > 0 ? 1 : 0);
}

function summarize(runs: EvalRunRecord[]): EvalReport["summary"] {
	const expectations = runs.flatMap((r) => r.expectations ?? []);
	return {
		total: runs.length,
		pass: runs.filter((r) => r.status === "pass").length,
		fail: runs.filter((r) => r.status === "fail").length,
		skipped: runs.filter((r) => r.status === "skipped").length,
		error: runs.filter((r) => r.status === "error").length,
		expectationsTotal: expectations.length,
		expectationsPassed: expectations.filter((e) => e.pass).length,
	};
}

function renderSummary(report: EvalReport): string {
	const s = report.summary;
	return `suite: ${report.suite} · ${s.pass}/${s.total} pass · ${s.fail} fail · ${s.skipped} skipped · ${s.error} error · expectations ${s.expectationsPassed}/${s.expectationsTotal} · ${report.durationMs}ms`;
}

function renderMarkdown(report: EvalReport, description: string): string {
	const lines: string[] = [];
	lines.push(`# scrutiny eval · ${report.suite}`);
	lines.push("");
	lines.push(`_${description}_`);
	lines.push("");
	lines.push(`duration: ${report.durationMs}ms · ${report.summary.pass}/${report.summary.total} pass · expectations ${report.summary.expectationsPassed}/${report.summary.expectationsTotal}`);
	lines.push("");
	lines.push("| task | surface | status | dur | expectations |");
	lines.push("|---|---|---|---|---|");
	for (const run of report.runs) {
		const exp = run.expectations ? `${run.expectations.filter((e) => e.pass).length}/${run.expectations.length}` : "—";
		lines.push(`| ${run.taskId} | ${run.surface} | ${run.status} | ${run.durationMs}ms | ${exp} |`);
	}
	lines.push("");
	for (const run of report.runs) {
		if (run.expectations?.some((e) => !e.pass) || run.error) {
			lines.push(`## ${run.taskId}`);
			if (run.error) lines.push(`error: ${run.error}`);
			if (run.runDir) lines.push(`run dir: \`${run.runDir}\``);
			for (const exp of run.expectations ?? []) {
				if (!exp.pass) lines.push(`- ✕ ${exp.name}${exp.error ? ` — ${exp.error}` : ""}`);
			}
			if (run.stdoutSnippet) lines.push("", "```", run.stdoutSnippet, "```");
			lines.push("");
		}
	}
	return lines.join("\n");
}

main().catch((error) => {
	console.error("eval runner crashed:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
