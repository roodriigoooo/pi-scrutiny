import fs from "node:fs";
import path from "node:path";
import type { EvalTask } from "./types.ts";

/**
 * Suite: smoke. No model keys needed. Exercises command parsing, surface
 * dispatch, missing-panel gating, and the verify arbiter against this repo.
 * Ground truth for verify is known: typecheck passes, tests+lint fail
 * (missing scripts in package.json).
 */
export const SMOKE_SUITE: EvalTask[] = [
	{
		id: "help",
		description: "/scrutiny help emits one clean message",
		surface: "consult",
		prompt: "/scrutiny help",
		expect: [{ name: "help text present", check: (ctx) => ctx.stdout.includes("pi-scrutiny") && ctx.stdout.includes("surfaces:") }],
	},
	{
		id: "models",
		description: "/scrutiny models emits configured-state message",
		surface: "consult",
		prompt: "/scrutiny models",
		expect: [{ name: "models text present", check: (ctx) => ctx.stdout.includes("verify checks") }],
	},
	{
		id: "verify-ground-truth",
		description: "verify surface runs objective checks; typecheck passes, tests+lint fail (missing scripts)",
		surface: "verify",
		prompt: "/scrutiny verify:",
		expect: [
			{ name: "surface is verify", check: (ctx) => ctx.result?.surface === "verify" },
			{ name: "status ok", check: (ctx) => ctx.result?.status === "ok" },
			{ name: "typecheck passes", check: (ctx) => Boolean(ctx.result?.verify?.checks?.find((c) => c.name === "typecheck" && c.status === "pass")) },
			{ name: "tests fail (missing script)", check: (ctx) => Boolean(ctx.result?.verify?.checks?.find((c) => c.name === "tests" && c.status === "fail")) },
			{ name: "lint fail (missing script)", check: (ctx) => Boolean(ctx.result?.verify?.checks?.find((c) => c.name === "lint" && c.status === "fail")) },
			{ name: "verify summary counts match", check: (ctx) => ctx.result?.verify?.passed === 1 && ctx.result?.verify?.failed === 2 && ctx.result?.verify?.skipped === 0 },
			{ name: "summary written", check: (ctx) => readSummary(ctx)?.surface === "verify" && readSummary(ctx)?.status === "ok" },
			{ name: "index row appended", check: (ctx) => indexHasRun(ctx) },
		],
	},
	{
		id: "missing-panel-gate",
		description: "deliberation surface with no panel configured returns a non-synthesizing failure",
		surface: "consult",
		prompt: "/scrutiny ask compare X vs Y",
		// force empty panel by overriding env
		councilEnv: { PI_SCRUTINY_PANEL: "" },
		requiresPanel: true,
		expect: [
			{ name: "status error", check: (ctx) => ctx.result?.status === "error" },
			{ name: "failure_reason missing_panel", check: (ctx) => ctx.result?.failure_reason === "missing_panel" },
			{ name: "error summary written", check: (ctx) => readSummary(ctx)?.failure_reason === "missing_panel" },
			{ name: "error index row appended", check: (ctx) => indexHasRun(ctx) },
		],
	},
	{
		id: "history-finds-runs",
		description: "history reads index rows and filters by surface",
		surface: "consult",
		prompt: "/scrutiny history surface:verify limit:1",
		expect: [
			{ name: "history header", check: (ctx) => ctx.stdout.includes("# scrutiny history") },
			{ name: "filter returned verify row", check: (ctx) => ctx.stdout.includes("· verify ·") },
			{ name: "open hint present", check: (ctx) => ctx.stdout.includes("history open <runId|latest>") },
		],
	},
	{
		id: "history-open-latest",
		description: "history opens bounded artifact content",
		surface: "consult",
		prompt: "/scrutiny history open latest summary",
		expect: [
			{ name: "artifact header", check: (ctx) => ctx.stdout.includes("# scrutiny artifact") },
			{ name: "summary json shown", check: (ctx) => ctx.stdout.includes("runId") && ctx.stdout.includes("status") },
		],
	},
	{
		id: "history-delete-preview",
		description: "history delete without --yes shows a non-mutating preview",
		surface: "consult",
		prompt: "/scrutiny history delete latest",
		expect: [
			{ name: "preview header", check: (ctx) => ctx.stdout.includes("# scrutiny history delete (preview)") },
			{ name: "confirm hint", check: (ctx) => ctx.stdout.includes("--yes") },
			{ name: "config-untouched note", check: (ctx) => ctx.stdout.includes(".pi/scrutiny.json") },
		],
	},
];

function readSummary(ctx: Parameters<NonNullable<EvalTask["expect"]>[number]["check"]>[0]): any | undefined {
	if (!ctx.runDir) return undefined;
	const file = path.join(ctx.runDir, "summary.json");
	if (!fs.existsSync(file)) return undefined;
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function indexHasRun(ctx: Parameters<NonNullable<EvalTask["expect"]>[number]["check"]>[0]): boolean {
	const runId = ctx.result?.runId;
	if (!runId) return false;
	const file = path.join(process.cwd(), ".pi", "scrutiny", "index.jsonl");
	if (!fs.existsSync(file)) return false;
	return fs.readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.some((line) => {
			try {
				return JSON.parse(line).runId === runId;
			} catch {
				return false;
			}
		});
}

export const SMOKE_SUITE_META = { name: "smoke", description: "no model keys required; command paths + verify ground truth" };
