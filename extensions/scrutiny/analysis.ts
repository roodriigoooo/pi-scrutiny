import type { PanelMode, ScrutinyAnalysis, PanelResponse, VerifyReport, ScrutinySurface } from "./types.js";
import { truncate } from "./util.js";

export function formatFailureBrief(input: {
	surface: import("./types.js").ScrutinySurface;
	runId: string;
	runDir: string;
	responses: PanelResponse[];
	failedModels: Array<{ model: string; error: string }>;
	reason: string;
}): string {
	const lines: string[] = [];
	lines.push(`# Scrutiny ${input.surface} failed`);
	lines.push(`reason: ${input.reason}`);
	lines.push(`run-id: ${input.runId}`);
	lines.push(`artifacts: ${input.runDir}`);
	lines.push("");
	lines.push("Do NOT synthesize an answer from this. There is no usable panel evidence.");
	lines.push("Tell the user the panel failed and show the reason + failed models below. Suggest fixing config (PI_SCRUTINY_PANEL, keys, network) and rerunning.");
	lines.push("");
	if (input.failedModels.length > 0) {
		lines.push("## Failed panelists");
		for (const failed of input.failedModels) lines.push(`- ${failed.model}: ${truncate(failed.error, 240)}`);
	}
	return lines.join("\n").trim();
}

export function detectMush(responses: PanelResponse[]): string | undefined {
	if (responses.length === 0) return undefined;
	const ok = responses.filter((response) => response.status === "ok" && response.content.trim());
	if (ok.length === 0) return undefined; // all-failed handled separately
	const allTiny = ok.every((response) => response.content.trim().length < 80);
	if (allTiny) return "all ok responses are near-empty (< 80 chars)";
	const allHeadersOnly = ok.every((response) => {
		const body = response.content.replace(/^#+\s.*$/gm, "").replace(/[\s`*-]/g, "").trim();
		return body.length < 40;
	});
	if (allHeadersOnly) return "all ok responses contain only template headings, no substance";
	const allToolPreambles = ok.every((response) => isToolIntentPreamble(response.content));
	if (allToolPreambles) return "all ok responses are tool-use preambles; panel likely ignored no-tools packet";
	return undefined;
}

function isToolIntentPreamble(text: string): boolean {
	const compact = text.trim().replace(/\s+/g, " ");
	if (compact.length > 600) return false;
	return /\b(i'?ll|i will|let me|need to|first,? i|i should)\b.{0,120}\b(inspect|read|open|check|look at|call|use|run|grep)\b.{0,120}\b(repo|files?|tools?|commands?|bash|grep|read|tests?)\b/i.test(compact)
		|| /\bcalling\b.{0,80}\b(repo reads|tools?|read|grep|bash)\b/i.test(compact)
		|| /\b(can'?t|cannot|don'?t)\b.{0,80}\b(access|inspect|read)\b.{0,80}\b(repo|files?)\b/i.test(compact);
}

export function buildDeterministicAnalysis(responses: PanelResponse[], panelMode: PanelMode | undefined = "replicate"): ScrutinyAnalysis {
	const mode = panelMode ?? "replicate";
	const ok = responses.filter((response) => response.status === "ok" && response.content.trim());
	const risks = unique(ok.flatMap((response) => extractRiskLines(response.content)).slice(0, 8));
	const uniqueInsights = ok.flatMap((response) =>
		extractBullets(response.content)
			.filter((line) => isDistinct(line, ok.filter((other) => other !== response).map((other) => other.content)))
			.slice(0, 3)
			.map((insight) => ({ model: response.model, insight: truncate(insight, 280) })),
	);
	const sharedTerms = mode === "replicate" ? sharedKeywords(ok.map((response) => response.content)) : [];
	const contradictions = mode === "replicate" ? detectContradictions(ok) ?? [] : [];
	const coverage = mode === "roles" ? roleCoverage(responses) : undefined;
	const consensus = mode === "replicate"
		? [
			`${ok.length}/${responses.length} panelists returned usable output.`,
			sharedTerms.length ? `Shared technical vocabulary: ${sharedTerms.join(", ")}.` : "No strong lexical consensus detected; compare panel stances before synthesizing.",
		]
		: [
			`${ok.length}/${responses.length} role lenses returned usable output.`,
			"Roles mode: coverage/gaps are signal; disagreement stop-signal disabled.",
		];
	const blindSpots = mode === "roles"
		? roleGaps(responses)
		: ["Deterministic analysis does not infer all semantic contradictions; main Pi model should compare panel stances before final answer."];
	return {
		consensus,
		contradictions,
		unique_insights: uniqueInsights.slice(0, 8),
		risks,
		coverage,
		blind_spots: blindSpots,
		confidence: ok.length >= 2 ? (contradictions.length ? "low" : "medium") : "low",
		disagreement_signal: mode === "replicate" && contradictions.length > 0,
	};
}

export function formatScrutinyBrief(input: {
	surface: ScrutinySurface;
	panelMode?: PanelMode;
	analysis?: ScrutinyAnalysis;
	responses: PanelResponse[];
	failedModels: Array<{ model: string; error: string }>;
	judgeRan: boolean;
	verify?: VerifyReport;
	llmPanelExcerptChars: number;
	budgetLine: string;
}): string {
	const ok = input.responses.filter((response) => response.status === "ok");
	const lines: string[] = [];
	lines.push(`# Scrutiny ${input.surface} result`);
	lines.push(input.budgetLine);
	if (input.panelMode) lines.push(panelModeBriefLine(input.surface, input.panelMode));
	lines.push(input.judgeRan ? "evidence map: trade-off explainer ran" : "evidence map: deterministic only; main Pi model synthesizes");
	if (input.verify) lines.push(verifyLine(input.verify));
	lines.push("");

	if (input.analysis) {
		if (input.analysis.disagreement_signal) {
			lines.push("## ⚠ disagreement signal");
			lines.push("Panel disagrees on a load-bearing point. Treat this as a stop signal: gather more evidence, run a narrower test, or ask the human. Do not smooth this into a synthesized answer.");
			lines.push("");
		}
		lines.push(`## Evidence map`);
		pushList(lines, "Shared signals", input.analysis.consensus);
		if (input.panelMode !== "roles") pushContradictions(lines, input.analysis.contradictions);
		pushUnique(lines, input.analysis.unique_insights);
		pushList(lines, "Risks", input.analysis.risks);
		pushList(lines, "Coverage", input.analysis.coverage);
		pushList(lines, "Blind spots", input.analysis.blind_spots);
		if (input.analysis.confidence) lines.push(`confidence: ${input.analysis.confidence}`);
		lines.push("");
	}

	if (ok.length > 0) {
		lines.push(`## Panel excerpts`);
		for (const response of ok) {
			lines.push(`### ${response.model} (${response.role})`);
			lines.push(truncate(response.content, input.llmPanelExcerptChars));
			lines.push("");
		}
	}

	if (input.failedModels.length > 0) {
		lines.push(`## Failed panelists`);
		for (const failed of input.failedModels) lines.push(`- ${failed.model}: ${truncate(failed.error, 240)}`);
	}

	if (input.verify) {
		lines.push("");
		lines.push("## Verify (objective arbiter)");
		lines.push(formatVerifyReport(input.verify));
	}

	lines.push("", surfaceActionLine(input.surface));
	return lines.join("\n").trim();
}

export function formatVerifyBrief(input: { verify: VerifyReport; budgetLine: string }): string {
	const lines: string[] = [];
	lines.push(`# Scrutiny verify result`);
	lines.push(input.budgetLine);
	lines.push("");
	lines.push("Verify is the objective arbiter. No LLM judge involved.");
	lines.push("");
	lines.push(formatVerifyReport(input.verify));
	lines.push("", "RECOMMENDED NEXT ACTION: act on pass/fail above. Fix failing checks before any panel deliberation weighs in.");
	return lines.join("\n").trim();
}

export function formatVerifyReport(verify: VerifyReport): string {
	const lines: string[] = [];
	lines.push(`${verify.passed} passed · ${verify.failed} failed · ${verify.skipped} skipped · ${formatMs(verify.durationMs)}`);
	if (verify.diffStat) {
		lines.push("");
		lines.push("### diff stat");
		lines.push("```");
		lines.push(verify.diffStat.trim());
		lines.push("```");
	}
	for (const check of verify.checks) {
		const icon = check.status === "pass" ? "✓" : check.status === "fail" ? "✕" : check.status === "error" ? "!" : "–";
		lines.push(`- ${icon} ${check.name} (${check.status}, ${formatMs(check.durationMs)})`);
		if (check.status !== "pass" && check.output?.trim()) lines.push(`  \`\`\`\n  ${truncate(check.output.trim(), 800).replace(/\n/g, "\n  ")}\n  \`\`\``);
	}
	return lines.join("\n");
}

function verifyLine(verify: VerifyReport): string {
	return `verify: ${verify.passed} pass · ${verify.failed} fail · ${verify.skipped} skipped`;
}

function panelModeBriefLine(surface: ScrutinySurface, panelMode: PanelMode): string {
	return panelMode === "replicate"
		? `[${surface}] replicate · agreement/disagreement is signal.`
		: `[${surface}] roles · coverage/gaps are signal; disagreement stop-signal disabled.`;
}

function surfaceActionLine(surface: ScrutinySurface): string {
	switch (surface) {
		case "consult":
			return "RECOMMENDED NEXT ACTION: synthesize from evidence above. Treat panel as consultation, not authority.";
		case "hypotheses":
			return "RECOMMENDED NEXT ACTION: run best distinguishing test(s), then act against repo. Do not merge a fix until hypothesis is confirmed by evidence.";
		case "criteria":
			return "RECOMMENDED NEXT ACTION: implement against fused spec above. Run verify after edit.";
		case "repo-map":
			return "RECOMMENDED NEXT ACTION: use map above as context for one coding agent to edit. Do not fuse edits from multiple panelists.";
		case "risks":
			return "RECOMMENDED NEXT ACTION: address findings by running suggested checks/tests, then editing. Do not merge risk-review prose into patch.";
		case "verify":
			return "RECOMMENDED NEXT ACTION: act on pass/fail above. Arbiter is checks, not any model.";
	}
}

function pushList(lines: string[], title: string, items: string[] | undefined): void {
	if (!items || items.length === 0) return;
	lines.push(`### ${title}`);
	for (const item of items.slice(0, 8)) lines.push(`- ${item}`);
}

function pushContradictions(lines: string[], items: ScrutinyAnalysis["contradictions"]): void {
	if (!items || items.length === 0) return;
	lines.push(`### Contradictions`);
	for (const item of items.slice(0, 6)) {
		lines.push(`- ${item.topic}`);
		for (const stance of item.stances.slice(0, 4)) lines.push(`  - ${stance.model}: ${stance.stance}`);
	}
}

function pushUnique(lines: string[], items: ScrutinyAnalysis["unique_insights"]): void {
	if (!items || items.length === 0) return;
	lines.push(`### Unique insights`);
	for (const item of items.slice(0, 8)) lines.push(`- ${item.model}: ${item.insight}`);
}

function roleCoverage(responses: PanelResponse[]): string[] {
	const ok = responses.filter((response) => response.status === "ok" && response.content.trim());
	const failed = responses.filter((response) => response.status !== "ok" || !response.content.trim());
	return unique([
		ok.length ? `Covered lenses: ${ok.map((response) => response.role).join(", ")}.` : undefined,
		failed.length ? `Missing/failed lenses: ${failed.map((response) => response.role).join(", ")}.` : undefined,
	].filter((item): item is string => Boolean(item)));
}

function roleGaps(responses: PanelResponse[]): string[] {
	const failed = responses.filter((response) => response.status !== "ok" || !response.content.trim());
	const missing = responses.flatMap((response) => extractMissingContextLines(response.content));
	return unique([
		"Roles mode does not compare panelists for contradiction; inspect missing lenses and uncovered risk classes.",
		...failed.map((response) => `No usable coverage from ${response.role} (${response.model}).`),
		...missing,
	]).slice(0, 8);
}

function extractMissingContextLines(text: string): string[] {
	return extractBullets(text)
		.filter((line) => /\b(missing|not shown|not in (the )?packet|insufficient|unknown|cannot determine|can't determine|need(?:s)? to inspect|must inspect|would need|need more evidence|not enough evidence|gap|uncovered)\b/i.test(line))
		.map((line) => truncate(line, 280));
}

function extractBullets(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^[-*•]\s+/, ""))
		.filter((line) => line.length >= 24 && line.length <= 400)
		.slice(0, 30);
}

function extractRiskLines(text: string): string[] {
	return extractBullets(text).filter((line) => /\b(risk|trade-?off|caution|fail|failure|bug|security|regression|uncertain|unknown|race|deadlock|idempoten|ordering)\b/i.test(line));
}

function isDistinct(line: string, otherTexts: string[]): boolean {
	const tokens = keywords(line);
	if (tokens.length < 3) return false;
	return !otherTexts.some((text) => tokens.filter((token) => text.toLowerCase().includes(token)).length >= Math.min(3, tokens.length));
}

function sharedKeywords(texts: string[]): string[] {
	if (texts.length < 2) return [];
	const counts = new Map<string, number>();
	for (const text of texts) {
		for (const token of new Set(keywords(text))) counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	return [...counts.entries()]
		.filter(([, count]) => count >= Math.min(2, texts.length))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 10)
		.map(([token]) => token);
}

function detectContradictions(responses: PanelResponse[]): ScrutinyAnalysis["contradictions"] {
	const ok = responses.filter((response) => response.status === "ok" && response.content.trim());
	if (ok.length < 2) return [];
	const contradictions: NonNullable<ScrutinyAnalysis["contradictions"]> = [];
	const negation = /\b(not|no|never|should not|don'?t|won'?t|cannot|can'?t|avoid|wrong|incorrect|disagree)\b/i;
	for (let i = 0; i < ok.length; i++) {
		for (let j = i + 1; j < ok.length; j++) {
			const a = ok[i].content.toLowerCase();
			const b = ok[j].content.toLowerCase();
			const shared = sharedKeywords([ok[i].content, ok[j].content]).filter((term) => term.length >= 6);
			const aNeg = negation.test(ok[i].content);
			const bNeg = negation.test(ok[j].content);
			if (shared.length >= 2 && aNeg !== bNeg) {
				const topic = shared.slice(0, 3).join(" / ");
				contradictions.push({
					topic,
					stances: [
						{ model: ok[i].model, stance: truncate(firstSentenceAround(ok[i].content, shared[0]), 160) },
						{ model: ok[j].model, stance: truncate(firstSentenceAround(ok[j].content, shared[0]), 160) },
					],
				});
			}
		}
	}
	return contradictions.slice(0, 4);
}

function firstSentenceAround(text: string, term: string): string {
	const idx = text.toLowerCase().indexOf(term);
	if (idx < 0) return text.split(/\r?\n/).find((line) => line.trim().length > 24) ?? text.slice(0, 160);
	const start = Math.max(0, text.lastIndexOf("\n", idx) + 1);
	const end = text.indexOf("\n", idx);
	return text.slice(start, end < 0 ? start + 160 : end).trim();
}

function keywords(text: string): string[] {
	return text
		.toLowerCase()
		.match(/[a-z][a-z0-9_-]{4,}/g)?.filter((token) => !STOP.has(token)) ?? [];
}

function unique(items: string[]): string[] {
	return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function formatMs(ms: number): string {
	return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

const STOP = new Set([
	"about", "after", "again", "answer", "because", "before", "could", "first", "model", "panel", "there", "these", "thing", "which", "would", "should", "their", "while", "where", "under", "using", "without", "recommendation", "evidence", "position", "panelist", "scrutiny",
]);
