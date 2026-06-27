import type { PanelResponse, ScrutinySurface } from "./types.js";

/**
 * Surface normalization (issue #12): parse panel Markdown by the surface's
 * canonical headings into structured per-surface artifacts. Tolerates messy
 * panel text — the goal is better handles for history/UI, not perfect parsing.
 * Raw panel output stays available in the on-disk surface artifact and result.
 */

export type ConsultArtifact = {
	positions: string[];
	evidence: string[];
	risks: string[];
	blindSpots: string[];
	recommendation?: string;
};

export type HypothesesArtifact = {
	rootCauses: string[];
	confirmingEvidence: string[];
	distinguishingTests: string[];
	ruleOuts: string[];
	missingContext: string[];
};

export type CriteriaArtifact = {
	criteria: string[];
	edgeCases: string[];
	backwardCompatRisks: string[];
	migrationConcerns: string[];
	testCases: string[];
	missingContext: string[];
};

export type RepoMapArtifact = {
	symbols: string[];
	callPaths: string[];
	tests: string[];
	configs: string[];
	invariants: string[];
	files: string[];
	missingContext: string[];
};

export type RiskFinding = {
	riskClass?: string;
	finding: string;
	severity?: string;
	suggestedCheck?: string;
};

export type RisksArtifact = {
	findings: RiskFinding[];
	missingContext: string[];
};

export type SurfaceArtifact =
	| { surface: "consult"; consult: ConsultArtifact }
	| { surface: "hypotheses"; hypotheses: HypothesesArtifact }
	| { surface: "criteria"; criteria: CriteriaArtifact }
	| { surface: "repo-map"; repoMap: RepoMapArtifact }
	| { surface: "risks"; risks: RisksArtifact }
	| { surface: "verify" };

export function normalizeSurface(surface: "consult", responses: PanelResponse[]): { surface: "consult"; consult: ConsultArtifact } | undefined;
export function normalizeSurface(surface: "hypotheses", responses: PanelResponse[]): { surface: "hypotheses"; hypotheses: HypothesesArtifact } | undefined;
export function normalizeSurface(surface: "criteria", responses: PanelResponse[]): { surface: "criteria"; criteria: CriteriaArtifact } | undefined;
export function normalizeSurface(surface: "repo-map", responses: PanelResponse[]): { surface: "repo-map"; repoMap: RepoMapArtifact } | undefined;
export function normalizeSurface(surface: "risks", responses: PanelResponse[]): { surface: "risks"; risks: RisksArtifact } | undefined;
export function normalizeSurface(surface: "verify", responses: PanelResponse[]): { surface: "verify" } | undefined;
export function normalizeSurface(surface: ScrutinySurface, responses: PanelResponse[]): SurfaceArtifact | undefined;
export function normalizeSurface(surface: ScrutinySurface, responses: PanelResponse[]): SurfaceArtifact | undefined {
	if (surface === "verify") return { surface: "verify" };
	const ok = responses.filter((r) => r.status === "ok" && r.content.trim());
	if (ok.length === 0) return undefined;
	switch (surface) {
		case "consult": return { surface: "consult", consult: normalizeConsult(ok) };
		case "hypotheses": return { surface: "hypotheses", hypotheses: normalizeHypotheses(ok) };
		case "criteria": return { surface: "criteria", criteria: normalizeCriteria(ok) };
		case "repo-map": return { surface: "repo-map", repoMap: normalizeRepoMap(ok) };
		case "risks": return { surface: "risks", risks: normalizeRisks(ok) };
	}
}

type Section = { heading: string; body: string };

function splitSections(markdown: string): Section[] {
	const lines = markdown.split(/\r?\n/);
	const out: Section[] = [];
	let cur: Section | null = null;
	for (const line of lines) {
		const match = line.match(/^##\s+(.+?)\s*$/);
		if (match) {
			if (cur) out.push(cur);
			cur = { heading: match[1], body: "" };
		} else if (cur) {
			cur.body += (cur.body ? "\n" : "") + line;
		}
	}
	if (cur) out.push(cur);
	return out;
}

function normKey(heading: string): string {
	return heading.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function bullets(body: string): string[] {
	return body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
		.map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
		.filter(Boolean);
}

/** Bullets if present, otherwise non-empty plain lines (tolerates prose without bullet markers). */
function items(body: string): string[] {
	const b = bullets(body);
	if (b.length) return b;
	return body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !/^#{1,6}\s/.test(line));
}

function firstLine(body: string): string | undefined {
	return body
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
		.find((line) => line && !/^#{1,6}\s/.test(line));
}

function sectionsBy(responses: PanelResponse[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const response of responses) {
		for (const section of splitSections(response.content)) {
			const key = normKey(section.heading);
			if (!key) continue;
			map.set(key, [...(map.get(key) ?? []), section.body]);
		}
	}
	return map;
}

function collect(map: Map<string, string[]>, headingKey: string): string[] {
	const bodies = map.get(headingKey) ?? [];
	return unique(bodies.flatMap(items));
}

function collectMissing(map: Map<string, string[]>): string[] {
	return unique((map.get("missing context needed inspection") ?? []).flatMap(items));
}

function normalizeConsult(responses: PanelResponse[]): ConsultArtifact {
	const map = sectionsBy(responses);
	return {
		positions: collect(map, "position"),
		evidence: collect(map, "evidence"),
		risks: collect(map, "risks"),
		blindSpots: collect(map, "blind spots missing evidence"),
		recommendation: firstLine((map.get("recommendation") ?? []).join("\n")),
	};
}

function normalizeHypotheses(responses: PanelResponse[]): HypothesesArtifact {
	const map = sectionsBy(responses);
	return {
		rootCauses: collect(map, "likely root causes ranked"),
		confirmingEvidence: collect(map, "confirming evidence per cause"),
		distinguishingTests: collect(map, "minimal distinguishing test"),
		ruleOuts: collect(map, "what would rule this cause out"),
		missingContext: collectMissing(map),
	};
}

function normalizeCriteria(responses: PanelResponse[]): CriteriaArtifact {
	const map = sectionsBy(responses);
	return {
		criteria: collect(map, "acceptance criteria"),
		edgeCases: collect(map, "edge cases"),
		backwardCompatRisks: collect(map, "backward compatibility risks"),
		migrationConcerns: collect(map, "migration concerns"),
		testCases: collect(map, "test cases"),
		missingContext: collectMissing(map),
	};
}

function normalizeRepoMap(responses: PanelResponse[]): RepoMapArtifact {
	const map = sectionsBy(responses);
	const symbols = collect(map, "relevant symbols");
	const callPaths = collect(map, "call paths");
	const tests = collect(map, "tests touched");
	const configs = collect(map, "config files");
	const invariants = collect(map, "invariants prior patterns");
	const files = unique(extractFilePaths([...symbols, ...callPaths, ...tests, ...configs, ...invariants].join("\n")));
	return { symbols, callPaths, tests, configs, invariants, files, missingContext: collectMissing(map) };
}

function normalizeRisks(responses: PanelResponse[]): RisksArtifact {
	const findings: RiskFinding[] = [];
	const missing: string[] = [];
	for (const response of responses) {
		const sections = splitSections(response.content);
		const byKey = new Map(sections.map((s) => [normKey(s.heading), s.body]));
		const riskClass = firstLine(byKey.get("risk class") ?? "");
		const severity = firstLine(byKey.get("severity") ?? "");
		const suggestedCheck = firstLine(byKey.get("suggested check or test") ?? "");
		const findingItems = items(byKey.get("findings") ?? "");
		if (findingItems.length === 0 && (riskClass || severity || suggestedCheck)) {
			findings.push({ riskClass, finding: riskClass ?? "finding", severity, suggestedCheck });
		}
		for (const finding of findingItems) {
			findings.push({ riskClass, finding, severity, suggestedCheck });
		}
		const missBody = byKey.get("missing context needed inspection");
		if (missBody) missing.push(...items(missBody));
	}
	return { findings, missingContext: unique(missing) };
}

function extractFilePaths(text: string): string[] {
	const refs: string[] = [];
	const pattern = /(^|[\s([{"'`])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text))) refs.push(match[2].replace(/^\.\//, ""));
	const rootPattern = /(^|[\s([{"'`])([A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
	while ((match = rootPattern.exec(text))) {
		const file = match[2];
		if (/\.(md|mdx|txt|json|ya?ml|toml|ts|tsx|js|jsx|py|java|kt|go|rs|sql|proto|graphql|gradle|xml|properties|env|sh)$/i.test(file)) refs.push(file);
	}
	return refs;
}

function unique(items: string[]): string[] {
	return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

/** Compact, bounded per-surface handles derived from a SurfaceArtifact for history/UI (#13). */
export type SurfaceFacts = {
	rootCauses?: string[];
	distinguishingTests?: string[];
	findings?: string[];
	suggestedChecks?: string[];
	symbols?: string[];
	files?: string[];
	criteria?: string[];
	testCases?: string[];
	positions?: string[];
	recommendation?: string;
};

export function surfaceFacts(artifact: SurfaceArtifact): SurfaceFacts {
	switch (artifact.surface) {
		case "hypotheses":
			return { rootCauses: artifact.hypotheses.rootCauses.slice(0, 3), distinguishingTests: artifact.hypotheses.distinguishingTests.slice(0, 2) };
		case "risks":
			return {
				findings: artifact.risks.findings.slice(0, 3).map((f) => f.finding),
				suggestedChecks: unique(artifact.risks.findings.map((f) => f.suggestedCheck).filter((s): s is string => Boolean(s))).slice(0, 3),
			};
		case "repo-map":
			return { symbols: artifact.repoMap.symbols.slice(0, 5), files: artifact.repoMap.files.slice(0, 5) };
		case "criteria":
			return { criteria: artifact.criteria.criteria.slice(0, 3), testCases: artifact.criteria.testCases.slice(0, 2) };
		case "consult":
			return { positions: artifact.consult.positions.slice(0, 2), recommendation: artifact.consult.recommendation };
		case "verify":
			return {};
	}
}
