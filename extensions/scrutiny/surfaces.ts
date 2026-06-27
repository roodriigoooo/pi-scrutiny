import type { PanelMode, ScrutinySurface } from "./types.js";

/**
 * Surface catalog: the single source of truth for surface identity and the
 * facts every caller needs (defaults, prompt shape, lenses, palette hints,
 * result action text, docs, mode lines, and prompt→surface routing).
 *
 * Adding or changing a surface should mostly touch this module. Callers
 * (config, packet, analysis, palette, ui, engine, entrypoint) import from here
 * instead of keeping their own per-surface tables. The coverage test
 * (eval/coverage.ts) treats `SCRUTINY_SURFACES` as the source of truth and
 * fails if a surface is missing any of these facts.
 */

export type SurfaceDefaults = {
	panelCount: number;
	panelMode?: PanelMode;
	judgeMode: "auto" | "off" | "on";
	includeGitDiff: boolean;
	verify: boolean;
};

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

export const SURFACE_DEFAULTS: Record<ScrutinySurface, SurfaceDefaults> = {
	consult: { panelCount: 2, panelMode: "replicate", judgeMode: "auto", includeGitDiff: false, verify: false },
	hypotheses: { panelCount: 2, panelMode: "replicate", judgeMode: "off", includeGitDiff: true, verify: false },
	criteria: { panelCount: 2, panelMode: "replicate", judgeMode: "off", includeGitDiff: true, verify: false },
	"repo-map": { panelCount: 2, panelMode: "roles", judgeMode: "off", includeGitDiff: true, verify: false },
	risks: { panelCount: 2, panelMode: "roles", judgeMode: "off", includeGitDiff: true, verify: true },
	verify: { panelCount: 0, judgeMode: "off", includeGitDiff: true, verify: true },
};

export const SURFACE_PROMPT_SPECS: Record<Exclude<ScrutinySurface, "verify">, SurfacePromptSpec> = {
	consult: {
		heading: "You are a Scrutiny panelist on a bounded research/synthesis question.",
		panelHeadings: ["## Position", "## Evidence", "## Risks", "## Blind spots / missing evidence", "## Recommendation"],
		trailer: ["Output is evidence for the main Pi agent to synthesize. It is not a patch."],
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
			"Do not propose a fix. The main agent will run the best diagnostic, then act against the repo and tests.",
			"If you disagree with the obvious cause, say so explicitly — disagreement is a useful signal here.",
		],
	},
	criteria: {
		heading: "You are a Scrutiny panelist deriving acceptance criteria before any code is written.",
		panelHeadings: ["## Acceptance criteria", "## Edge cases", "## Backward-compatibility risks", "## Migration concerns", "## Test cases", "## Missing context / needed inspection"],
		trailer: ["The main agent will implement against the fused spec. Be concrete and testable."],
	},
	"repo-map": {
		heading: "You are a Scrutiny panelist mapping the repo for an upcoming edit. Output context, not an answer.",
		panelHeadings: ["## Relevant symbols", "## Call paths", "## Tests touched", "## Config / files", "## Invariants / prior patterns", "## Missing context / needed inspection"],
		trailer: [
			"Output is a compact repo map. The main agent will edit with this context.",
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
		],
	},
};

export const SURFACE_LENSES: Record<Exclude<ScrutinySurface, "verify">, string[]> = {
	consult: ["first-pass analyst", "skeptical reviewer", "synthesizer", "edge-case hunter"],
	hypotheses: ["most-likely-cause investigator", "alternative-cause skeptic", "distinguishing-test designer", "environment/config examiner"],
	criteria: ["acceptance-criteria author", "edge-case author", "backward-compatibility reviewer", "migration/test-case author"],
	"repo-map": ["call-path mapper", "api/symbol mapper", "test/invariant mapper", "config/build mapper"],
	risks: ["concurrency reviewer", "reactive-chain reviewer", "api-compatibility reviewer", "security reviewer", "performance reviewer", "data-migration reviewer", "null/error-handling reviewer", "flaky-test reviewer"],
};

export const SURFACE_HINTS: Record<ScrutinySurface, SurfaceHint> = {
	consult: { produces: "produces a synthesized analysis (research/synthesis)", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	hypotheses: { produces: "produces ranked root causes + distinguishing tests, not a fix", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	criteria: { produces: "produces an acceptance spec to implement against, not a patch", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	"repo-map": { produces: "produces a compact repo map for an upcoming edit, not an answer", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	risks: { produces: "produces per-class risk findings + suggested checks, not a merged patch", flow: "↳ runs inline; panel then verify; esc cancels" },
	verify: { produces: "produces objective pass/fail (tests, typecheck, lint). the arbiter", flow: "↳ runs inline; blocks until checks finish; esc cancels" },
};

export const SURFACE_ACTION_LINES: Record<ScrutinySurface, string> = {
	consult: "RECOMMENDED NEXT ACTION: synthesize from evidence above. Treat panel as consultation, not authority.",
	hypotheses: "RECOMMENDED NEXT ACTION: run best distinguishing test(s), then act against repo. Do not merge a fix until hypothesis is confirmed by evidence.",
	criteria: "RECOMMENDED NEXT ACTION: implement against fused spec above. Run verify after edit.",
	"repo-map": "RECOMMENDED NEXT ACTION: use map above as context for one coding agent to edit. Do not fuse edits from multiple panelists.",
	risks: "RECOMMENDED NEXT ACTION: address findings by running suggested checks/tests, then editing. Do not merge risk-review prose into patch.",
	verify: "RECOMMENDED NEXT ACTION: act on pass/fail above. Arbiter is checks, not any model.",
};

export const SURFACE_DOCS: Record<ScrutinySurface, SurfaceDoc> = {
	consult: { mode: "replicate mode", description: "bounded research/synthesis (validated use). trade-off explainer runs by default." },
	hypotheses: { mode: "replicate mode", description: "ranked root causes + confirming evidence + minimal distinguishing tests. disagreement is signal." },
	criteria: { mode: "replicate mode", description: "acceptance spec: edge cases, backward-compat, migration, test cases." },
	"repo-map": { mode: "roles mode", description: "compact context (symbols, call paths, tests, config, invariants) for an upcoming edit." },
	risks: { mode: "roles mode", description: "per-class risk review of a patch (concurrency, reactive-chain, api-compat, security, perf, migration, null, flaky). runs verify." },
	verify: { mode: "objective arbiter", description: "runs tests/typecheck/lint as the objective arbiter. no panel, no judge." },
};

export function surfaceModeLine(surface: ScrutinySurface): string {
	const mode = SURFACE_DEFAULTS[surface].panelMode;
	if (mode === "replicate") return "replicate · same prompt · disagreement is signal";
	if (mode === "roles") return "roles · separate lenses · coverage/gaps are signal";
	return "objective arbiter · no panel";
}

export function panelModeBriefLine(surface: ScrutinySurface, panelMode: PanelMode): string {
	return panelMode === "replicate"
		? `[${surface}] replicate · agreement/disagreement is signal.`
		: `[${surface}] roles · coverage/gaps are signal; disagreement stop-signal disabled.`;
}

/**
 * Prompt→surface routing. One copy shared by engine (command path) and palette.
 * Coding words route to deliberation surfaces, never to answer-scrutiny.
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
