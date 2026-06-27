import path from "node:path";
import { findRelatedSummaries } from "./artifacts.js";
import type { ScrutinyParams, ScrutinySurface, ScoutCandidate, ScoutGap, ScoutReport } from "./types.js";
import { truncate } from "./util.js";

type ExecLike = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

type Anchors = {
	files: string[];
	symbols: string[];
	terms: string[];
	reasons: string[];
};

const MAX_SCOUT_CHARS = 4_000;
const MAX_CANDIDATES = 12;
const MAX_RG_MATCHES = 80;
const MAX_PATTERN_PARTS = 12;
const MAX_DIFF_FILES = 30;
const MAX_PRIOR_RUNS = 3;
const SCOUT_HEADING = "Context scout";

const SKIP_REASON_NO_ANCHORS = "skipped: no `@file`, path, symbol-like term, prompt keyword, or git diff file found. ask user to choose scope before broad repo scan.";

/**
 * Cheap local anchor scan. Returns structured data (anchors, ranked candidates
 * with stable ids, prior-run count, and first-class gaps). Packet rendering and
 * packet-preview pruning consume this report instead of parsing Markdown back
 * into facts (issues #4, #5, #6).
 */
export async function runContextScout(input: {
	params: ScrutinyParams;
	surface: ScrutinySurface;
	cwd: string;
	exec: ExecLike;
	signal?: AbortSignal;
}): Promise<ScoutReport> {
	const surface = input.surface;
	if (surface === "verify") {
		return { surface, skipped: true, skipReason: "verify surface has no context scout", anchors: emptyAnchors(), candidates: [], priorCount: 0, gaps: [] };
	}

	const explicit = extractExplicitAnchors(`${input.params.prompt}\n${input.params.context ?? ""}`);
	const diffFiles = await readDiffFiles(input.exec, input.signal);
	const anchors = buildAnchors({ text: input.params.prompt, explicitFiles: explicit.files, explicitSymbols: explicit.symbols, diffFiles });

	if (anchors.files.length === 0 && anchors.symbols.length === 0 && anchors.terms.length === 0) {
		return {
			surface,
			skipped: true,
			skipReason: SKIP_REASON_NO_ANCHORS,
			anchors,
			candidates: [],
			priorCount: 0,
			gaps: [{ id: "no-anchors", severity: "warn", message: "no anchors found; ask user to choose scope before broad repo scan" }],
		};
	}

	const raw: ScoutCandidate[] = [];
	for (const file of diffFiles.slice(0, MAX_DIFF_FILES)) raw.push({ id: "", kind: "file", title: file, score: 10, why: ["git diff file"] });
	for (const file of explicit.files) raw.push({ id: "", kind: "file", title: file, score: 12, why: ["explicit file anchor"] });
	raw.push(...await rgCandidates(input.cwd, input.exec, anchors, input.signal));
	raw.push(...await pathCandidates(input.cwd, input.exec, anchors, input.signal));
	raw.push(...await priorRunCandidates(input.cwd, anchors));

	const ranked = dedupeCandidates(raw).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, MAX_CANDIDATES);
	ranked.forEach((candidate, index) => { candidate.id = `c${index}`; });
	const priorCount = ranked.filter((candidate) => candidate.kind === "prior").length;
	const gaps = computeGaps(ranked, priorCount);

	return { surface, skipped: false, anchors, candidates: ranked, priorCount, gaps };
}

/** Edge rendering: turns a ScoutReport into the `## Context scout` packet section. */
export function renderScoutMarkdown(report: ScoutReport, excludedIds?: ReadonlySet<string>): string {
	if (report.skipped) {
		return truncate(["## Context scout", report.skipReason ?? "skipped: no anchors found."].join("\n"), MAX_SCOUT_CHARS);
	}
	const lines: string[] = [];
	lines.push("## Context scout");
	lines.push("cheap local anchor scan. source for orientation only; not authority.");
	lines.push(`anchors: ${report.anchors.reasons.join(", ") || "none"}`);
	pushInline(lines, "files", report.anchors.files, 8);
	pushInline(lines, "symbols", report.anchors.symbols, 8);
	pushInline(lines, "terms", report.anchors.terms, 8);
	lines.push("");

	if (report.candidates.length === 0) {
		lines.push("no local candidates found from these anchors. if task depends on broader architecture, inspect scope manually before trusting panel output.");
		return truncate(lines.join("\n"), MAX_SCOUT_CHARS);
	}

	const included = report.candidates.filter((candidate) => !excludedIds?.has(candidate.id));
	if (included.length === 0) {
		lines.push("preview pruning: all scout candidates hidden before panel run.");
		return truncate(lines.join("\n"), MAX_SCOUT_CHARS);
	}
	lines.push("### Candidate context");
	for (const candidate of included) {
		lines.push(`- ${candidate.title} [${candidate.kind}; score ${candidate.score}; why: ${candidate.why.join(", ") || "anchor"}]`);
		if (candidate.preview) lines.push(`  ${truncate(candidate.preview.replace(/\s+/g, " "), 220)}`);
	}
	if (excludedIds && excludedIds.size > 0) lines.push(`preview pruning: ${excludedIds.size} scout candidate(s) hidden before panel run.`);
	return truncate(lines.join("\n"), MAX_SCOUT_CHARS);
}

/**
 * Rebuild the exact packet with the given scout candidates excluded. Toggles by
 * stable candidate id and re-renders the scout section, so preview pruning no
 * longer slices Markdown blocks (issue #5).
 */
export function pruneScoutCandidates(packet: string, report: ScoutReport, excludedIds: ReadonlySet<string>): string {
	if (excludedIds.size === 0 || report.skipped) return packet;
	return replaceSection(packet, SCOUT_HEADING, renderScoutMarkdown(report, excludedIds));
}

function computeGaps(candidates: ScoutCandidate[], priorCount: number): ScoutGap[] {
	const gaps: ScoutGap[] = [];
	if (candidates.length === 0) {
		gaps.push({ id: "no-candidates", severity: "warn", message: "anchors found, but no local candidates matched" });
		return gaps;
	}
	const hasTests = candidates.some((candidate) => candidate.why.includes("test file"));
	const hasDocs = candidates.some((candidate) => candidate.why.includes("doc/config path"));
	if (!hasTests) gaps.push({ id: "no-tests", severity: "warn", message: "no tests surfaced by scout" });
	if (!hasDocs) gaps.push({ id: "no-docs-config", severity: "warn", message: "no docs/config/project-frame snippets surfaced yet" });
	if (candidates.length > 10) gaps.push({ id: "many-candidates", severity: "info", message: "many scout candidates; consider narrower scope if result feels noisy" });
	const onlyStaleMemory = priorCount > 0 && candidates.every((candidate) => candidate.kind === "prior" && candidate.stale);
	if (onlyStaleMemory) gaps.push({ id: "only-stale-memory", severity: "warn", message: "only stale prior scrutiny memory surfaced; re-check before trusting" });
	return gaps;
}

function emptyAnchors(): Anchors {
	return { files: [], symbols: [], terms: [], reasons: [] };
}

function buildAnchors(input: { text: string; explicitFiles: string[]; explicitSymbols: string[]; diffFiles: string[] }): Anchors {
	const symbols = unique([...input.explicitSymbols, ...extractSymbols(input.text)]).slice(0, 12);
	const files = unique([...input.explicitFiles, ...input.diffFiles]).slice(0, 40);
	const terms = extractTerms(input.text, symbols, files).slice(0, 12);
	const reasons = [
		input.explicitFiles.length ? "explicit file refs" : undefined,
		input.explicitSymbols.length || symbols.length ? "prompt symbols" : undefined,
		input.diffFiles.length ? "git diff files" : undefined,
		terms.length ? "prompt keywords" : undefined,
	].filter((item): item is string => Boolean(item));
	return { files, symbols, terms, reasons };
}

function extractExplicitAnchors(text: string): { files: string[]; symbols: string[] } {
	const files: string[] = [];
	const symbols: string[] = [];
	for (const match of text.matchAll(/@([^\s`'"),;]+)/g)) {
		const value = match[1].replace(/^\/+/, "");
		if (looksLikePath(value)) files.push(value.replace(/^\.\//, ""));
		else if (/^[A-Za-z_$][A-Za-z0-9_$.:-]*$/.test(value)) symbols.push(value.replace(/[:.].*$/, ""));
	}
	for (const match of text.matchAll(/(^|[\s([{"'`])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+)(?=[:\s)'"`,.;]|$)/g)) {
		const file = normalizeFile(match[2]);
		if (file) files.push(file);
	}
	return { files: unique(files), symbols: unique(symbols) };
}

function extractSymbols(text: string): string[] {
	const symbols: string[] = [];
	for (const match of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)`/g)) symbols.push(match[1]);
	for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g)) symbols.push(match[1]);
	return symbols.filter((symbol) => symbol.length >= 4 && !STOP.has(symbol.toLowerCase()));
}

function extractTerms(text: string, symbols: string[], files: string[]): string[] {
	const skip = new Set(symbols.map((symbol) => symbol.toLowerCase()));
	for (const file of files) for (const part of file.toLowerCase().split(/[^a-z0-9]+/)) skip.add(part);
	return unique((text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])
		.filter((term) => !STOP.has(term) && !skip.has(term) && term.length <= 40));
}

async function readDiffFiles(exec: ExecLike, signal?: AbortSignal): Promise<string[]> {
	try {
		const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 3_000, signal });
		if (inside.code !== 0 || inside.stdout?.trim() !== "true") return [];
		const result = await exec("git", ["diff", "--name-only", "HEAD", "--"], { timeout: 5_000, signal });
		const stdout = result.stdout?.trim() ? result.stdout : (await exec("git", ["diff", "--name-only", "--"], { timeout: 5_000, signal })).stdout;
		return unique((stdout ?? "").split(/\r?\n/).map(normalizeFile).filter((file): file is string => Boolean(file))).slice(0, MAX_DIFF_FILES);
	} catch {
		return [];
	}
}

async function rgCandidates(cwd: string, exec: ExecLike, anchors: Anchors, signal?: AbortSignal): Promise<ScoutCandidate[]> {
	const patternParts = unique([...anchors.symbols, ...anchors.terms]).slice(0, MAX_PATTERN_PARTS);
	if (patternParts.length === 0) return [];
	const pattern = patternParts.map(escapeRegex).join("|");
	try {
		const result = await exec("rg", [
			"--json", "-n", "-S", "--max-count", "3", "--max-filesize", "1M",
			"--glob", "!node_modules/**", "--glob", "!.git/**", "--glob", "!.pi/scrutiny/**",
			"--glob", "!package-lock.json", "--glob", "!pnpm-lock.yaml", "--glob", "!yarn.lock", "--glob", "!bun.lockb",
			pattern, ".",
		], { timeout: 6_000, signal });
		return parseRgMatches(cwd, result.stdout ?? "", anchors);
	} catch {
		return [];
	}
}

function parseRgMatches(cwd: string, stdout: string, anchors: Anchors): ScoutCandidate[] {
	const candidates: ScoutCandidate[] = [];
	const anchorFiles = new Set(anchors.files);
	const terms = new Set([...anchors.terms, ...anchors.symbols].map((item) => item.toLowerCase()));
	for (const line of stdout.split(/\r?\n/)) {
		if (candidates.length >= MAX_RG_MATCHES) break;
		if (!line.trim()) continue;
		let event: any;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type !== "match") continue;
		const file = normalizeFile(path.relative(cwd, path.resolve(cwd, event.data?.path?.text ?? "")));
		if (!file) continue;
		const lineNumber = Number(event.data?.line_number ?? 0) || undefined;
		const text = String(event.data?.lines?.text ?? "").trim();
		const why: string[] = [];
		let score = 1;
		if (anchorFiles.has(file)) { score += 8; why.push("anchor file"); }
		const lower = `${file}\n${text}`.toLowerCase();
		for (const term of terms) {
			if (lower.includes(term)) {
				score += anchors.symbols.map((symbol) => symbol.toLowerCase()).includes(term) ? 3 : 1;
				why.push(`hit:${term}`);
			}
		}
		if (isTestPath(file)) { score += 3; why.push("test file"); }
		if (isDocConfigPath(file)) { score += 2; why.push("doc/config path"); }
		candidates.push({ id: "", kind: "match", title: `${file}${lineNumber ? `:${lineNumber}` : ""}`, score, why: unique(why).slice(0, 5), preview: text });
	}
	return candidates;
}

async function pathCandidates(cwd: string, exec: ExecLike, anchors: Anchors, signal?: AbortSignal): Promise<ScoutCandidate[]> {
	const terms = unique([...anchors.terms, ...anchors.symbols.map((symbol) => symbol.toLowerCase())]);
	if (terms.length === 0) return [];
	try {
		const result = await exec("rg", ["--files", "--glob", "!node_modules/**", "--glob", "!.git/**", "--glob", "!.pi/scrutiny/**", "--glob", "!package-lock.json", "--glob", "!pnpm-lock.yaml", "--glob", "!yarn.lock", "--glob", "!bun.lockb"], { timeout: 5_000, signal });
		return (result.stdout ?? "")
			.split(/\r?\n/)
			.map(normalizeFile)
			.filter((file): file is string => Boolean(file))
			.filter((file) => isDocConfigPath(file) || isTestPath(file))
			.map((file): ScoutCandidate | undefined => {
				const lower = file.toLowerCase();
				const hits = terms.filter((term) => lower.includes(term));
				return hits.length ? { id: "", kind: "file", title: file, score: 4 + hits.length + (isTestPath(file) ? 2 : 0), why: [`path:${hits.slice(0, 3).join(",")}`, isTestPath(file) ? "test file" : "doc/config path"].filter(Boolean) } : undefined;
			})
			.filter((item): item is ScoutCandidate => item !== undefined)
			.slice(0, 30);
	} catch {
		return [];
	}
}

async function priorRunCandidates(cwd: string, anchors: Anchors): Promise<ScoutCandidate[]> {
	const related = await findRelatedSummaries(cwd, anchors, MAX_PRIOR_RUNS);
	return related.map(({ summary, freshness, why, score }) => ({
		id: "",
		kind: "prior",
		title: `${summary.runId} · ${summary.surface} · ${summary.status}${freshness && freshness !== "unknown" ? ` · ${freshness}` : ""}`,
		score,
		why,
		preview: truncate([summary.prompt, ...summary.signals.slice(0, 2), ...summary.risks.slice(0, 2)].filter(Boolean).join("; "), 260),
		stale: freshness === "stale",
	}));
}

function dedupeCandidates(candidates: ScoutCandidate[]): ScoutCandidate[] {
	const byTitle = new Map<string, ScoutCandidate>();
	for (const candidate of candidates) {
		const existing = byTitle.get(candidate.title);
		if (!existing) byTitle.set(candidate.title, candidate);
		else byTitle.set(candidate.title, {
			...existing,
			score: Math.max(existing.score, candidate.score),
			why: unique([...existing.why, ...candidate.why]).slice(0, 6),
			preview: existing.preview ?? candidate.preview,
			stale: existing.stale ?? candidate.stale,
		});
	}
	return [...byTitle.values()];
}

function replaceSection(packet: string, heading: string, newBody: string): string {
	const lines = packet.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
	if (start < 0) return packet;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s+/.test(lines[i])) { end = i; break; }
	}
	return [...lines.slice(0, start), ...newBody.split(/\r?\n/), ...lines.slice(end)].join("\n");
}

function pushInline(lines: string[], label: string, items: string[], limit: number): void {
	if (items.length === 0) return;
	lines.push(`${label}: ${items.slice(0, limit).join(", ")}${items.length > limit ? `, +${items.length - limit}` : ""}`);
}

function normalizeFile(raw: string | undefined): string | undefined {
	let file = raw?.trim().replace(/^['"`]|['"`,.;)\]]$/g, "");
	if (!file) return undefined;
	file = file.replace(/^@/, "").replace(/^(?:a|b)\//, "").replace(/^\.\//, "");
	if (!file || file.includes("://") || path.isAbsolute(file)) return undefined;
	if (file.split("/").some((part) => part === "..")) return undefined;
	if (/^(?:node_modules|\.git|\.pi\/scrutiny)\//.test(file)) return undefined;
	if (/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(file)) return undefined;
	return file;
}

function looksLikePath(value: string): boolean {
	return value.includes("/") || /\.[A-Za-z0-9]+(?::\d+)?$/.test(value);
}

function isTestPath(file: string): boolean {
	return /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\.[A-Za-z0-9]+$/i.test(file);
}

function isDocConfigPath(file: string): boolean {
	return /(^|\/)(README|CONTEXT|docs|adr|architecture|service|schema|schemas|proto|openapi|routes|migrations|config|configs)(\/|\.|$)|\.(ya?ml|toml|json|proto|graphql|sql|properties|env)$/i.test(file);
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(items: string[]): string[] {
	return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

const STOP = new Set([
	"about", "after", "again", "answer", "because", "before", "could", "first", "model", "panel", "there", "these", "thing", "which", "would", "should", "their", "while", "where", "under", "using", "without", "recommendation", "evidence", "position", "panelist", "scrutiny", "surface", "packet", "context", "result", "status", "failed", "error", "output", "outputs", "returned", "usable", "technical", "vocabulary", "shared", "confidence", "deterministic", "analysis", "compare", "review", "change", "changes", "patch", "please", "maybe", "think", "tell", "what", "when", "does", "this", "that", "with", "from", "into", "doesn", "isn", "aren", "have", "been", "will", "just", "really", "basically", "actually", "simply",
]);
