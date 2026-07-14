import type { DeliberationStrategy, ResolvedDeliberationRunPlan, ResolvedRunPlan, ScrutinyConfig, ScrutinyParams, ScoutReport } from "./types.js";
import { SURFACE_PROMPT_SPECS } from "./surfaces.js";
import { runContextScout, renderScoutMarkdown } from "./scout.js";
import { truncate } from "./util.js";

type ExecLike = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

export async function buildTaskPacket(input: {
	params: ScrutinyParams;
	plan: ResolvedRunPlan;
	cwd: string;
	config: ScrutinyConfig;
	exec: ExecLike;
	signal?: AbortSignal;
}): Promise<{ packet: string; scout?: ScoutReport }> {
	const { plan } = input;
	const sections: string[] = [];
	sections.push("# Scrutiny task packet");
	sections.push(`template: ${plan.template.name}`);
	sections.push(`surface: ${plan.template.surface}`);
	if (plan.strategy) sections.push(`strategy: ${plan.strategy}`);
	if (plan.panel) sections.push(`panel: ${plan.panel.name}`);
	sections.push(`cwd: ${input.cwd}`);
	sections.push("");
	sections.push("## Task");
	sections.push(input.params.prompt.trim());

	if (input.params.context?.trim()) sections.push("", "## User-supplied context", truncate(input.params.context.trim(), 12_000));

	let scout: ScoutReport | undefined;
	if (plan.template.surface !== "verify") {
		scout = await runContextScout({ params: input.params, surface: plan.template.surface, cwd: input.cwd, exec: input.exec, signal: input.signal });
		sections.push("", renderScoutMarkdown(scout));
	}

	if (plan.policies.includeGitDiff) {
		const git = await readGitContext(input.exec, input.cwd, input.config.gitDiffCharLimit, input.signal);
		if (git) sections.push("", "## Git working tree", git);
	}

	sections.push("", "## Instructions", ...sharedInstructions());
	return { packet: `${sections.join("\n").trim()}\n`, scout };
}

export function panelPrompt(input: {
	packet: string;
	surface: Exclude<ResolvedDeliberationRunPlan["template"]["surface"], "verify">;
	strategy: DeliberationStrategy;
	lens?: string;
}): string {
	const spec = SURFACE_PROMPT_SPECS[input.surface];
	if (input.strategy === "roles" && !input.lens?.trim()) throw new Error("roles panel prompts require an assigned lens");
	const frame = input.strategy === "replicate"
		? `${spec.heading} Deliberation strategy: replicate. Every panelist receives this exact same prompt; model priors provide diversity.`
		: `${spec.heading} Deliberation strategy: roles. Assigned lens: ${input.lens}.`;
	return [
		frame,
		"Produce one independent analysis from the packet only. Do not claim you will call tools or inspect files.",
		"Return Markdown with these headings exactly:",
		...spec.panelHeadings,
		"",
		...spec.trailer,
		"",
		input.packet,
	].join("\n");
}

export function judgePrompt(input: {
	packet: string;
	strategy: DeliberationStrategy;
	responses: Array<{ model: string; role: string; content: string }>;
}): string {
	const disagreementInstruction = input.strategy === "replicate"
		? "The strategy is replicate: panelists saw the same prompt. Set disagreement_signal=true when panelists disagree sharply on root cause, architecture, or a load-bearing claim. Disagreement remains a stop signal; the user chooses more evidence, a narrower test, or stop. Do not smooth it over."
		: "The strategy is roles: each panelist used a different assigned lens. Set disagreement_signal=false. Treat non-overlap as coverage/gaps, not contradiction; report gaps in blind_spots or risks.";
	const responses = input.responses
		.map((response, index) => [`### Panel ${index + 1}: ${response.model} (${response.role})`, response.content].join("\n"))
		.join("\n\n");
	return [
		"You are a Scrutiny trade-off explainer. Compare panel outputs. Do not majority-vote. Do not pick a winner. Do not propose a final answer or patch.",
		"Return ONLY valid JSON. No Markdown fence. Schema:",
		"{",
		'  "consensus": ["..."],',
		'  "contradictions": [{"topic":"...","stances":[{"model":"...","stance":"..."}]}],',
		'  "unique_insights": [{"model":"...","insight":"..."}],',
		'  "risks": ["..."],',
		'  "blind_spots": ["..."],',
		'  "disagreement_signal": true|false,',
		'  "confidence": "low|medium|high"',
		"}",
		"",
		disagreementInstruction,
		"Explain trade-offs only. The user chooses follow-up. Objective repo checks remain the correctness arbiter; do not imply automatic synthesis or implementation by Pi.",
		"",
		"Original task packet:",
		input.packet,
		"",
		"Panel responses:",
		responses,
	].join("\n");
}

export function resolvedPanelists(plan: ResolvedDeliberationRunPlan): Array<{ model: string; role: string; thinking?: import("./types.js").ThinkingLevel }> {
	return plan.assignments.map((assignment) => ({
		model: assignment.model,
		role: plan.strategy === "replicate" ? "replicate analyst" : assignment.lens!,
		...(assignment.thinking === undefined ? {} : { thinking: assignment.thinking }),
	}));
}

function sharedInstructions(): string[] {
	return [
		"- Answer independently. Do not assume other panelists will cover gaps.",
		"- Prefer concrete, testable claims over vibes.",
		"- Surface uncertainty and missing evidence.",
		"- If the packet looks too narrow, name the missing surrounding files/systems/tests that must be inspected before trusting the result. Do not guess around missing context.",
		"- You are running without tools unless the packet says otherwise. Do not say you will read files, call tools, or inspect the repo later; use only the packet and name missing evidence explicitly.",
		"- Do not edit files. This is evidence for human review or later explicitly requested agent work; do not assume implementation follows.",
		"- Keep answer dense. No preamble.",
	];
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
