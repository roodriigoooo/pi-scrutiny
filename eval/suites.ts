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
		],
	},
];

export const SMOKE_SUITE_META = { name: "smoke", description: "no model keys required; command paths + verify ground truth" };
