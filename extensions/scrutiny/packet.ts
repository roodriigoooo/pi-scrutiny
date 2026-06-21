import type { ScrutinyConfig, ScrutinyParams, ScrutinySurface } from "./types.js";
import { SURFACE_DEFAULTS } from "./config.js";
import { truncate } from "./util.js";

type ExecLike = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

export async function buildTaskPacket(input: {
	params: ScrutinyParams;
	surface: ScrutinySurface;
	cwd: string;
	config: ScrutinyConfig;
	exec: ExecLike;
	signal?: AbortSignal;
}): Promise<string> {
	const sections: string[] = [];
	sections.push(`# Scrutiny task packet`);
	sections.push(`surface: ${input.surface}`);
	sections.push(`cwd: ${input.cwd}`);
	sections.push("");
	sections.push(`## Task`);
	sections.push(input.params.prompt.trim());

	if (input.params.context?.trim()) {
		sections.push("", `## User-supplied context`, truncate(input.params.context.trim(), 12_000));
	}

	const includeGitDiff = input.params.includeGitDiff ?? SURFACE_DEFAULTS[input.surface].includeGitDiff;
	if (includeGitDiff) {
		const git = await readGitContext(input.exec, input.cwd, input.config.gitDiffCharLimit, input.signal);
		if (git) sections.push("", `## Git working tree`, git);
	}

	sections.push("", "## Instructions", ...sharedInstructions());
	return sections.join("\n").trim() + "\n";
}

function sharedInstructions(): string[] {
	return [
		"- Answer independently. Do not assume other panelists will cover gaps.",
		"- Prefer concrete, testable claims over vibes.",
		"- Surface uncertainty and missing evidence.",
		"- You are running without tools unless the packet says otherwise. Do not say you will read files, call tools, or inspect the repo later; use only the packet and name missing evidence explicitly.",
		"- Do not edit files. Do not propose a final patch to merge. This is deliberation, not the edit.",
		"- Keep answer dense. No preamble.",
	];
}

type SurfaceSpec = {
	heading: string;
	panelHeadings: string[];
	trailer: string[];
};

const SURFACE_SPECS: Record<Exclude<ScrutinySurface, "verify">, SurfaceSpec> = {
	consult: {
		heading: "You are a Scrutiny panelist on a bounded research/synthesis question.",
		panelHeadings: ["## Position", "## Evidence", "## Risks", "## Recommendation"],
		trailer: ["Output is evidence for the main Pi agent to synthesize. It is not a patch."],
	},
	hypotheses: {
		heading: "You are a Scrutiny panelist on a debugging problem. Do not propose a fix yet.",
		panelHeadings: [
			"## Likely root causes (ranked)",
			"## Confirming evidence per cause",
			"## Minimal distinguishing test",
			"## What would rule this cause out",
		],
		trailer: [
			"Do not propose a fix. The main agent will run the best diagnostic, then act against the repo and tests.",
			"If you disagree with the obvious cause, say so explicitly — disagreement is a useful signal here.",
		],
	},
	criteria: {
		heading: "You are a Scrutiny panelist deriving acceptance criteria before any code is written.",
		panelHeadings: ["## Acceptance criteria", "## Edge cases", "## Backward-compatibility risks", "## Migration concerns", "## Test cases"],
		trailer: ["The main agent will implement against the fused spec. Be concrete and testable."],
	},
	"repo-map": {
		heading: "You are a Scrutiny panelist mapping the repo for an upcoming edit. Output context, not an answer.",
		panelHeadings: ["## Relevant symbols", "## Call paths", "## Tests touched", "## Config / files", "## Invariants / prior patterns"],
		trailer: [
			"Output is a compact repo map. The main agent will edit with this context.",
			"Prefer exact symbol names, file paths, and line references over prose.",
		],
	},
	risks: {
		heading: "You are a Scrutiny risk reviewer. You review one risk class only.",
		panelHeadings: ["## Risk class", "## Findings", "## Severity", "## Suggested check or test"],
		trailer: [
			"Focus on your assigned risk class. Do not review other classes.",
			"For Java/Spring/Kafka/WebFlux: watch race conditions, reactive-chain mistakes, retry/circuit-breaker semantics, idempotency, message ordering.",
			"Propose a concrete check or test that would catch each finding, not a fix to merge.",
		],
	},
};

export function panelPrompt(input: { packet: string; role: string; surface: ScrutinySurface }): string {
	if (input.surface === "verify") throw new Error("verify surface has no panel prompt");
	const spec = SURFACE_SPECS[input.surface];
	return [
		`${spec.heading} Role: ${input.role}.`,
		"Produce one independent analysis from the packet only. Do not claim you will call tools or inspect files.",
		"Return Markdown with these headings exactly:",
		...spec.panelHeadings,
		"",
		...spec.trailer,
		"",
		input.packet,
	].join("\n");
}

export function judgePrompt(input: { packet: string; responses: Array<{ model: string; role: string; content: string }> }): string {
	const responses = input.responses
		.map((response, index) => [`### Panel ${index + 1}: ${response.model} (${response.role})`, response.content].join("\n"))
		.join("\n\n");
	return [
		"You are a Scrutiny trade-off explainer. Compare panel outputs. Do not majority-vote. Do not pick a winner. Do not propose a final answer or patch.",
		"Return ONLY valid JSON. No Markdown fence. Schema:",
		`{`,
		`  "consensus": ["..."],`,
		`  "contradictions": [{"topic":"...","stances":[{"model":"...","stance":"..."}]}],`,
		`  "unique_insights": [{"model":"...","insight":"..."}],`,
		`  "risks": ["..."],`,
		`  "blind_spots": ["..."],`,
		`  "disagreement_signal": true|false,`,
		`  "confidence": "low|medium|high"`,
		`}`,
		"",
		"Set disagreement_signal=true when panelists disagree sharply on root cause, architecture, or a load-bearing claim. The main agent treats that as a stop signal to gather more evidence or ask the human, not as noise to smooth over.",
		"You explain trade-offs only. The main Pi agent and objective repo checks are the arbiters.",
		"",
		"Original task packet:",
		input.packet,
		"",
		"Panel responses:",
		responses,
	].join("\n");
}

type LensSet = string[];

const SURFACE_LENSES: Record<Exclude<ScrutinySurface, "verify">, LensSet> = {
	consult: ["first-pass analyst", "skeptical reviewer", "synthesizer", "edge-case hunter"],
	hypotheses: ["most-likely-cause investigator", "alternative-cause skeptic", "distinguishing-test designer", "environment/config examiner"],
	criteria: ["acceptance-criteria author", "edge-case author", "backward-compatibility reviewer", "migration/test-case author"],
	"repo-map": ["call-path mapper", "api/symbol mapper", "test/invariant mapper", "config/build mapper"],
	risks: ["concurrency reviewer", "reactive-chain reviewer", "api-compatibility reviewer", "security reviewer", "performance reviewer", "data-migration reviewer", "null/error-handling reviewer", "flaky-test reviewer"],
};

export function panelRoles(models: string[], surface: ScrutinySurface): Array<{ model: string; role: string }> {
	if (surface === "verify") return [];
	const lenses = SURFACE_LENSES[surface];
	return models.map((model, index) => ({ model, role: lenses[index] ?? `panelist-${index + 1}` }));
}

async function readGitContext(exec: ExecLike, cwd: string, diffCharLimit: number, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 3_000, signal });
		if (inside.code !== 0 || inside.stdout?.trim() !== "true") return undefined;
		const status = await exec("git", ["status", "--short"], { timeout: 5_000, signal });
		const stat = await exec("git", ["diff", "--stat"], { timeout: 5_000, signal });
		const diff = diffCharLimit > 0 ? await exec("git", ["diff", "--no-ext-diff"], { timeout: 8_000, signal }) : undefined;
		const chunks = [
			status.stdout?.trim() ? `### status\n\n\`\`\`\n${status.stdout.trim()}\n\`\`\`` : undefined,
			stat.stdout?.trim() ? `### diff stat\n\n\`\`\`\n${stat.stdout.trim()}\n\`\`\`` : undefined,
			diff?.stdout?.trim() ? `### diff\n\n\`\`\`diff\n${truncate(diff.stdout.trim(), diffCharLimit)}\n\`\`\`` : undefined,
		].filter(Boolean);
		return chunks.length ? chunks.join("\n\n") : undefined;
	} catch {
		return undefined;
	}
}
