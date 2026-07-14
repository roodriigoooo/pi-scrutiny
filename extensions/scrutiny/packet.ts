import type { PanelMember, PanelMode, ScrutinyConfig, ScrutinyParams, ScrutinySurface, ScoutReport } from "./types.js";
import { SURFACE_DEFAULTS, SURFACE_LENSES, SURFACE_PROMPT_SPECS } from "./surfaces.js";
import { renderScoutMarkdown, runContextScout } from "./scout.js";
import { truncate } from "./util.js";

type ExecLike = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

export async function buildTaskPacket(input: {
	params: ScrutinyParams;
	surface: ScrutinySurface;
	cwd: string;
	config: ScrutinyConfig;
	exec: ExecLike;
	signal?: AbortSignal;
}): Promise<{ packet: string; scout?: ScoutReport }> {
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

	let scout: ScoutReport | undefined;
	if (input.surface !== "verify") {
		scout = await runContextScout({ params: input.params, surface: input.surface, cwd: input.cwd, exec: input.exec, signal: input.signal });
		sections.push("", renderScoutMarkdown(scout));
	}

	const includeGitDiff = input.params.includeGitDiff ?? SURFACE_DEFAULTS[input.surface].includeGitDiff;
	if (includeGitDiff) {
		const git = await readGitContext(input.exec, input.cwd, input.config.gitDiffCharLimit, input.signal);
		if (git) sections.push("", `## Git working tree`, git);
	}

	sections.push("", "## Instructions", ...sharedInstructions());
	return { packet: sections.join("\n").trim() + "\n", scout };
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

export function panelPrompt(input: { packet: string; role: string; surface: ScrutinySurface; panelMode?: PanelMode }): string {
	if (input.surface === "verify") throw new Error("verify surface has no panel prompt");
	const spec = SURFACE_PROMPT_SPECS[input.surface];
	const panelMode = input.panelMode ?? SURFACE_DEFAULTS[input.surface].panelMode ?? "roles";
	const frame = panelMode === "replicate"
		? `${spec.heading} Panel mode: replicate. Every panelist receives this same prompt; model priors provide diversity.`
		: `${spec.heading} Panel mode: roles. Role: ${input.role}.`;
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

export function judgePrompt(input: { packet: string; panelMode?: PanelMode; responses: Array<{ model: string; role: string; content: string }> }): string {
	const panelMode = input.panelMode ?? "replicate";
	const disagreementInstruction = panelMode === "replicate"
		? "Set disagreement_signal=true when panelists disagree sharply on root cause, architecture, or a load-bearing claim. Disagreement remains a stop signal; the user chooses more evidence, a narrower test, or stop. Do not smooth it over."
		: "Panel mode is roles: each panelist used a different lens. Set disagreement_signal=false. Treat non-overlap as coverage/gaps, not contradiction; report gaps in blind_spots or risks.";
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

export function panelRoles(members: PanelMember[], surface: ScrutinySurface): Array<{ model: string; role: string; thinking?: PanelMember["thinking"] }> {
	if (surface === "verify") return [];
	const panelMode = SURFACE_DEFAULTS[surface].panelMode ?? "roles";
	if (panelMode === "replicate") return members.map((member) => ({ model: member.model, role: "replicate analyst", thinking: member.thinking }));
	const lenses = SURFACE_LENSES[surface];
	return members.map((member, index) => ({ model: member.model, role: member.lens ?? lenses[index] ?? `panelist-${index + 1}`, thinking: member.thinking }));
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
