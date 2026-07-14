import type { ScrutinySurface } from "./types.js";

/**
 * Surface catalog: the source of truth for surface identity, prompt shape,
 * palette hints, result next-step text, documentation, and prompt routing.
 * Templates own strategy, lenses, panel selection, and run policies.
 */

export type SurfacePromptSpec = {
	heading: string;
	panelHeadings: string[];
	trailer: string[];
};

export type SurfaceHint = {
	produces: string;
	flow: string;
};

export type SurfaceDoc = {
	mode: string;
	description: string;
};

export const SCRUTINY_SURFACES: ScrutinySurface[] = ["consult", "hypotheses", "criteria", "repo-map", "risks", "verify"];
export const SCRUTINY_SURFACE_SET: ReadonlySet<ScrutinySurface> = new Set(SCRUTINY_SURFACES);
export const DELIBERATION_SURFACES: Exclude<ScrutinySurface, "verify">[] = ["consult", "hypotheses", "criteria", "repo-map", "risks"];

export const SURFACE_PROMPT_SPECS: Record<Exclude<ScrutinySurface, "verify">, SurfacePromptSpec> = {
	consult: {
		heading: "You are a Scrutiny panelist on a bounded research/synthesis question.",
		panelHeadings: ["## Position", "## Evidence", "## Risks", "## Blind spots / missing evidence", "## Recommendation"],
		trailer: [
			"Output is evidence for human review or later explicitly requested agent work. It is not a patch.",
			"Do not assume implementation follows. Do not edit.",
		],
	},
	hypotheses: {
		heading: "You are a Scrutiny panelist on a debugging problem. Do not propose a fix yet.",
		panelHeadings: [
			"## Likely root causes (ranked)",
			"## Confirming evidence per cause",
			"## Minimal distinguishing test",
			"## What would rule this cause out",
			"## Missing context / needed inspection",
		],
		trailer: [
			"Do not propose a fix. The user decides which diagnostic to run, then whether to request a fix after confirmation.",
			"Do not assume implementation follows. Do not edit.",
			"If you disagree with the obvious cause, say so explicitly — disagreement is a useful signal here.",
		],
	},
	criteria: {
		heading: "You are a Scrutiny panelist deriving acceptance criteria before any code is written.",
		panelHeadings: ["## Acceptance criteria", "## Edge cases", "## Backward-compatibility risks", "## Migration concerns", "## Test cases", "## Missing context / needed inspection"],
		trailer: [
			"Output concrete, testable criteria for human review or later explicitly requested agent work.",
			"Do not assume implementation follows. Do not edit.",
		],
	},
	"repo-map": {
		heading: "You are a Scrutiny panelist mapping the repo for human review. Output context, not an answer.",
		panelHeadings: ["## Relevant symbols", "## Call paths", "## Tests touched", "## Config / files", "## Invariants / prior patterns", "## Missing context / needed inspection"],
		trailer: [
			"Output a compact repo map for human review or later explicitly requested agent work.",
			"Do not assume implementation follows. Do not edit.",
			"Prefer exact symbol names, file paths, and line references over prose.",
		],
	},
	risks: {
		heading: "You are a Scrutiny risk reviewer. You review one risk class only.",
		panelHeadings: ["## Risk class", "## Findings", "## Severity", "## Suggested check or test", "## Missing context / needed inspection"],
		trailer: [
			"Focus on your assigned risk class. Do not review other classes.",
			"For Java/Spring/Kafka/WebFlux: watch race conditions, reactive-chain mistakes, retry/circuit-breaker semantics, idempotency, message ordering.",
			"Propose a concrete check or test that would catch each finding, not a fix to merge.",
			"Findings are for human review or later explicitly requested agent work; do not assume implementation follows. Do not edit.",
		],
	},
};

export const SURFACE_HINTS: Record<ScrutinySurface, SurfaceHint> = {
	consult: { produces: "produces an evidence map for human review (research/synthesis)", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	hypotheses: { produces: "produces ranked root causes + distinguishing tests; no automatic fix", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	criteria: { produces: "produces acceptance criteria for human review; no automatic implementation", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	"repo-map": { produces: "produces a compact repo map for human review; no automatic edit", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	risks: { produces: "produces per-class risk findings + suggested checks; no automatic edits", flow: "↳ runs inline; panel then verify when selected; esc cancels" },
	verify: { produces: "produces objective pass/fail for human review; no automatic fixes", flow: "↳ runs inline; blocks until checks finish; esc cancels" },
};

export const SURFACE_NEXT_STEP_LINES: Record<ScrutinySurface, string> = {
	consult: "POSSIBLE NEXT STEP: review evidence; choose synthesis, more evidence, or stop.",
	hypotheses: "POSSIBLE NEXT STEP: choose a distinguishing test; request a fix only after confirmation.",
	criteria: "POSSIBLE NEXT STEP: review or amend criteria; explicitly request implementation when ready.",
	"repo-map": "POSSIBLE NEXT STEP: inspect gaps; explicitly hand map to one coding agent if desired.",
	risks: "POSSIBLE NEXT STEP: choose findings to investigate; explicitly request checks or edits.",
	verify: "POSSIBLE NEXT STEP: review failures; decide whether to investigate or request fixes.",
};

export const SCRUTINY_STOP_STATEMENT = "│ Scrutiny stops here. No Pi agent turn or code edit follows automatically.";

export const SURFACE_DOCS: Record<ScrutinySurface, SurfaceDoc> = {
	consult: { mode: "built-in replicate template", description: "bounded research/synthesis for human review. trade-off explainer runs by default." },
	hypotheses: { mode: "built-in replicate template", description: "ranked root causes + confirming evidence + minimal distinguishing tests. disagreement is signal." },
	criteria: { mode: "built-in replicate template", description: "acceptance criteria for human review: edge cases, backward-compat, migration, test cases." },
	"repo-map": { mode: "built-in roles template", description: "compact repo context for human review: symbols, call paths, tests, config, invariants." },
	risks: { mode: "built-in roles template", description: "per-class risk review of a patch. runs verify by default." },
	verify: { mode: "objective arbiter", description: "runs tests/typecheck/lint for human review. no panel, no judge." },
};

/**
 * Prompt→surface routing. The entrypoint maps this result to a built-in
 * template of the same name.
 */
export function inferSurface(prompt: string): ScrutinySurface {
	const text = prompt.toLowerCase();
	if (/\b(verify|type[ -]?check|lint(?:ing)?|run tests|test suite|does it pass|check the build|ci)\b/.test(text)) return "verify";
	if (/\b(risks?|review (?:the|this) (?:patch|change)|concurrency|races?|reactive|idempoten(?:t|cy|ce)?|circuit.?breaker|security review)\b/.test(text)) return "risks";
	if (/\b(root cause|why does|debug(?:ging|ged)?|intermittent|flaky|bug in|what is causing)\b/.test(text)) return "hypotheses";
	if (/\b(acceptance criteria|edge cases?|backward[ -]?compat(?:ibility)?|migrat(?:e|es|ed|ing|ion|ions)?|spec for|definition of done)\b/.test(text)) return "criteria";
	if (/\b(repo map|where is|call paths?|callers of|symbols?|traces?|how does .* work|navigate the code)\b/.test(text)) return "repo-map";
	return "consult";
}
