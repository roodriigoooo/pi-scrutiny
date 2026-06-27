import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ScrutinySummary } from "./types.js";
import { formatDuration, scrutinyDataDir, truncate } from "./util.js";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const ARTIFACT_CHAR_LIMIT = 24_000;

type Freshness = "fresh" | "stale" | "unknown";

type HistoryRow = {
	summary: ScrutinySummary;
	freshness: Freshness;
	staleFiles: string[];
};

type HistoryLoad = {
	rows: HistoryRow[];
	rebuilt: boolean;
	warnings: string[];
};

type Query = {
	text: string[];
	file?: string;
	symbol?: string;
	surface?: string;
	status?: string;
	freshness?: Freshness;
	since?: number;
	before?: number;
	limit: number;
};

export async function historyText(cwd: string, args: string): Promise<string> {
	const trimmed = args.trim();
	if (trimmed.startsWith("open ")) return openArtifactText(cwd, trimmed.slice("open ".length).trim());
	const queryText = trimmed.startsWith("list ") ? trimmed.slice("list ".length).trim() : trimmed;
	const query = parseQuery(queryText);
	const loaded = await loadHistory(cwd);
	const rows = loaded.rows.filter((row) => matchesQuery(row, query)).slice(0, query.limit);
	return renderHistory({ loaded, rows, query, rawQuery: queryText });
}

export async function showHistoryPicker(ctx: ExtensionCommandContext): Promise<string | null> {
	const loaded = await loadHistory(ctx.cwd);
	return ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => new HistoryPicker(tui, theme, ctx.cwd, loaded, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "78%",
				minWidth: 72,
				maxHeight: "84%",
				margin: 1,
			},
		},
	);
}

async function loadHistory(cwd: string): Promise<HistoryLoad> {
	const dataDir = scrutinyDataDir(cwd);
	const indexPath = path.join(dataDir, "index.jsonl");
	const warnings: string[] = [];
	let summaries: ScrutinySummary[] = [];
	let rebuilt = false;
	try {
		const content = await fs.readFile(indexPath, "utf8");
		summaries = parseIndex(content, warnings);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`index read failed: ${error instanceof Error ? error.message : String(error)}`);
		summaries = await scanSummaryFiles(dataDir, warnings);
		if (summaries.length > 0) {
			await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
			await fs.writeFile(indexPath, summaries.map((summary) => JSON.stringify(summary)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
			rebuilt = true;
		}
	}
	const deduped = dedupeSummaries(summaries).sort((a, b) => b.startedAt - a.startedAt);
	const rows = await Promise.all(deduped.map(async (summary) => ({ summary, ...(await freshnessFor(cwd, summary)) })));
	return { rows, rebuilt, warnings };
}

function parseIndex(content: string, warnings: string[]): ScrutinySummary[] {
	const rows: ScrutinySummary[] = [];
	const lines = content.split(/\r?\n/).filter(Boolean);
	for (let i = 0; i < lines.length; i++) {
		try {
			const parsed = JSON.parse(lines[i]) as ScrutinySummary;
			if (parsed?.runId && parsed.surface && parsed.startedAt) rows.push(parsed);
			else warnings.push(`index row ${i + 1} missing required fields`);
		} catch (error) {
			warnings.push(`index row ${i + 1} invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return rows;
}

async function scanSummaryFiles(dataDir: string, warnings: string[]): Promise<ScrutinySummary[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dataDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`run-dir scan failed: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	const summaries: ScrutinySummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("scr_")) continue;
		const file = path.join(dataDir, entry.name, "summary.json");
		try {
			const parsed = JSON.parse(await fs.readFile(file, "utf8")) as ScrutinySummary;
			if (parsed?.runId) summaries.push(parsed);
		} catch {
			warnings.push(`${entry.name}: missing/corrupt summary.json`);
		}
	}
	return summaries;
}

function dedupeSummaries(summaries: ScrutinySummary[]): ScrutinySummary[] {
	const byRun = new Map<string, ScrutinySummary>();
	for (const summary of summaries) byRun.set(summary.runId, summary);
	return [...byRun.values()];
}

async function freshnessFor(cwd: string, summary: ScrutinySummary): Promise<{ freshness: Freshness; staleFiles: string[] }> {
	const entries = Object.entries(summary.fileHashes ?? {});
	if (entries.length === 0) return { freshness: "unknown", staleFiles: [] };
	const staleFiles: string[] = [];
	for (const [file, expected] of entries) {
		try {
			const abs = path.resolve(cwd, file);
			if (!isInside(cwd, abs)) {
				staleFiles.push(file);
				continue;
			}
			const actual = createHash("sha1").update(await fs.readFile(abs)).digest("hex");
			if (actual !== expected) staleFiles.push(file);
		} catch {
			staleFiles.push(file);
		}
	}
	return { freshness: staleFiles.length ? "stale" : "fresh", staleFiles };
}

function parseQuery(raw: string): Query {
	const query: Query = { text: [], limit: DEFAULT_LIMIT };
	for (const token of tokenize(raw)) {
		const [key, value] = splitFilter(token);
		if (!value) {
			query.text.push(token.toLowerCase());
			continue;
		}
		switch (key) {
			case "file": query.file = value.toLowerCase(); break;
			case "symbol": query.symbol = value.toLowerCase(); break;
			case "surface": query.surface = value.toLowerCase(); break;
			case "status": query.status = value.toLowerCase(); break;
			case "fresh": query.freshness = truthy(value) ? "fresh" : "stale"; break;
			case "stale": query.freshness = truthy(value) ? "stale" : "fresh"; break;
			case "since":
			case "after": query.since = parseDateWindow(value); break;
			case "before":
			case "until": query.before = parseDateWindow(value); break;
			case "limit": query.limit = clampLimit(value); break;
			default: query.text.push(token.toLowerCase()); break;
		}
	}
	return query;
}

function tokenize(raw: string): string[] {
	const tokens: string[] = [];
	const pattern = /"([^"]+)"|'([^']+)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(raw))) tokens.push(match[1] ?? match[2] ?? match[3]);
	return tokens;
}

function splitFilter(token: string): [string, string | undefined] {
	const idx = token.indexOf(":");
	if (idx <= 0) return [token.toLowerCase(), undefined];
	return [token.slice(0, idx).toLowerCase(), token.slice(idx + 1)];
}

function truthy(value: string): boolean {
	return !/^(?:false|0|no|off)$/i.test(value);
}

function clampLimit(value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
	return Math.min(parsed, MAX_LIMIT);
}

function parseDateWindow(value: string): number | undefined {
	const relative = value.match(/^(\d+)([smhdw])$/i);
	if (relative) {
		const amount = Number.parseInt(relative[1], 10);
		const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2].toLowerCase() as "s" | "m" | "h" | "d" | "w"];
		return Date.now() - amount * unitMs;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function matchesQuery(row: HistoryRow, query: Query): boolean {
	const summary = row.summary;
	const fileFilter = query.file;
	const symbolFilter = query.symbol;
	if (fileFilter && !summary.files.some((file) => file.toLowerCase().includes(fileFilter)) && !summary.sourceRefs.some((ref) => ref.toLowerCase().includes(fileFilter))) return false;
	if (symbolFilter && !summary.symbols.some((symbol) => symbol.toLowerCase().includes(symbolFilter))) return false;
	if (query.surface && summary.surface !== query.surface) return false;
	if (query.status && summary.status !== query.status) return false;
	if (query.freshness && row.freshness !== query.freshness) return false;
	if (query.since && summary.startedAt < query.since) return false;
	if (query.before && summary.startedAt > query.before) return false;
	if (query.text.length === 0) return true;
	const haystack = [
		summary.runId,
		summary.prompt,
		summary.surface,
		summary.status,
		summary.failure_reason ?? "",
		summary.error ?? "",
		...summary.files,
		...summary.symbols,
		...summary.keywords,
		...summary.signals,
		...summary.risks,
		...summary.contradictions,
		...summary.missingContext,
		...summary.sourceRefs,
	].join("\n").toLowerCase();
	return query.text.every((token) => haystack.includes(token));
}

function renderHistory(input: { loaded: HistoryLoad; rows: HistoryRow[]; query: Query; rawQuery: string }): string {
	const lines: string[] = [];
	lines.push("# scrutiny history");
	lines.push("");
	lines.push(`${input.loaded.rows.length} indexed runs${input.rawQuery ? ` · query: \`${input.rawQuery}\`` : ""}${input.loaded.rebuilt ? " · rebuilt index from summaries" : ""}`);
	if (input.loaded.warnings.length > 0) {
		lines.push("");
		lines.push("## index warnings");
		for (const warning of input.loaded.warnings.slice(0, 8)) lines.push(`- ${warning}`);
	}
	if (input.rows.length === 0) {
		lines.push("", "no matching scrutiny runs.", "", "filters: `file:`, `symbol:`, `surface:`, `status:`, `fresh:true|false`, `stale:true|false`, `since:`, `before:`, `limit:`");
		return lines.join("\n");
	}
	lines.push("", "filters: `file:`, `symbol:`, `surface:`, `status:`, `fresh:true|false`, `stale:true|false`, `since:`, `before:`, `limit:`");
	lines.push("open: `/scrutiny history open <runId|latest> [result|summary|surface|packet|responses|verify]`", "");
	for (const row of input.rows) renderRow(lines, row);
	return lines.join("\n");
}

function renderRow(lines: string[], row: HistoryRow): void {
	const summary = row.summary;
	const age = formatDuration(Date.now() - summary.startedAt);
	const status = summary.failure_reason ? `${summary.status}/${summary.failure_reason}` : summary.status;
	const fresh = row.freshness === "stale" ? `stale: ${row.staleFiles.slice(0, 3).join(", ")}` : row.freshness;
	lines.push(`## ${summary.runId} · ${summary.surface} · ${status} · ${age} ago · ${fresh}`);
	lines.push(truncate(summary.prompt || "(no prompt)", 220));
	pushCompact(lines, "files", summary.files, 5);
	pushCompact(lines, "symbols", summary.symbols, 6);
	pushCompact(lines, "signals", summary.signals, 3);
	pushCompact(lines, "risks", summary.risks, 3);
	pushCompact(lines, "missing", summary.missingContext, 3);
	pushCompact(lines, "scout-gaps", summary.scoutGaps, 3);
	pushCompact(lines, "refs", summary.sourceRefs, 5);
	const paths = [summary.resultPath, summary.surfaceArtifactPath, summary.packetPath, summary.responsesPath, summary.verifyPath].filter(Boolean).join(" · ");
	if (paths) lines.push(`paths: ${paths}`);
	lines.push("");
}

function pushCompact(lines: string[], label: string, items: string[] | undefined, limit: number): void {
	if (!items?.length) return;
	lines.push(`${label}: ${items.slice(0, limit).map((item) => truncate(item, 140)).join("; ")}${items.length > limit ? `; +${items.length - limit}` : ""}`);
}

type HistoryArtifact = "summary" | "result" | "surface" | "packet" | "responses" | "verify";

class HistoryPicker implements Component, Focusable {
	focused = false;
	private query = "";
	private selected = 0;
	private artifact: HistoryArtifact = "summary";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly cwd: string,
		private readonly loaded: HistoryLoad,
		private readonly done: (value: string | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) return this.done(null);
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("o"))) return void this.openSelected();
		if (matchesKey(data, Key.tab)) {
			this.cycleArtifact(1);
			return this.rerender();
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.cycleArtifact(-1);
			return this.rerender();
		}
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			return this.rerender();
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(Math.max(0, this.filteredRows().length - 1), this.selected + 1);
			return this.rerender();
		}
		if (matchesKey(data, Key.pageUp)) {
			this.selected = Math.max(0, this.selected - 8);
			return this.rerender();
		}
		if (matchesKey(data, Key.pageDown)) {
			this.selected = Math.min(Math.max(0, this.filteredRows().length - 1), this.selected + 8);
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.query = "";
			this.selected = 0;
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("w"))) {
			this.query = this.query.replace(/\s*\S+\s*$/, "");
			this.selected = 0;
			return this.rerender();
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.query = this.query.slice(0, -1);
			this.selected = 0;
			return this.rerender();
		}
		if (isPrintable(data)) {
			this.query += data.replace(/[\r\n\t]/g, " ");
			this.selected = 0;
			return this.rerender();
		}
	}

	render(width: number): string[] {
		const w = Math.max(60, width);
		const lines: string[] = [];
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const rows = this.filteredRows();
		if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
		const selected = rows[this.selected];

		lines.push(topBorder(w, `${accent("scrutiny history")} ${dim("search")}`, this.theme));
		lines.push(frameLine(this.inputLine(w - 4), w, this.theme));
		lines.push(frameLine(`${dim("runs")} ${accent(String(this.loaded.rows.length))} ${dim("matches")} ${accent(String(rows.length))} ${dim("artifact")} ${accent(this.artifact)}${this.loaded.rebuilt ? ` ${warning("rebuilt index")}` : ""}`, w, this.theme));
		if (this.loaded.warnings.length) lines.push(frameLine(warning(`warnings: ${this.loaded.warnings.slice(0, 2).join("; ")}`), w, this.theme));
		lines.push(midBorder(w, this.theme));

		if (rows.length === 0) {
			lines.push(frameLine(dim("no matching scrutiny runs"), w, this.theme));
		} else {
			const windowed = visibleWindow(rows, this.selected, 9);
			for (const item of windowed) lines.push(frameLine(this.rowLine(item.row, item.index === this.selected), w, this.theme));
		}

		lines.push(midBorder(w, this.theme));
		for (const line of this.previewLines(selected).slice(0, 9)) lines.push(frameLine(line, w, this.theme));
		lines.push(midBorder(w, this.theme));
		lines.push(frameLine(dim("type search · ↑↓ move · tab artifact · enter/^o open · ^u clear · esc close"), w, this.theme));
		lines.push(bottomBorder(w, this.theme));
		return lines;
	}

	invalidate(): void {}

	private inputLine(width: number): string {
		const label = this.theme.fg("muted", "search › ");
		const empty = this.theme.fg("dim", "keyword file:symbol surface:risks status:ok...");
		const cursor = this.focused ? `${CURSOR_MARKER}${this.theme.bg("selectedBg", " ")}` : "";
		return truncateToWidth(`${label}${this.query || empty}${cursor}`, width);
	}

	private filteredRows(): HistoryRow[] {
		return rankRows(this.loaded.rows, this.query).slice(0, MAX_LIMIT);
	}

	private rowLine(row: HistoryRow, selected: boolean): string {
		const summary = row.summary;
		const age = formatDuration(Date.now() - summary.startedAt);
		const status = summary.failure_reason ? `${summary.status}/${summary.failure_reason}` : summary.status;
		const fresh = row.freshness === "stale" ? `stale:${row.staleFiles[0] ?? "changed"}` : row.freshness;
		const refs = [...summary.files, ...summary.symbols, ...summary.keywords].slice(0, 3).join(" ");
		const prefix = selected ? this.theme.fg("accent", ">") : this.theme.fg("dim", " ");
		const freshText = row.freshness === "stale" ? this.theme.fg("warning", fresh) : this.theme.fg("muted", fresh);
		return `${prefix} ${summary.runId.slice(-8)} ${this.theme.fg("accent", summary.surface)} ${status} ${freshText} ${this.theme.fg("dim", age)} ${truncate(summary.prompt || refs, 90)}`;
	}

	private previewLines(row: HistoryRow | undefined): string[] {
		if (!row) return [this.theme.fg("dim", "preview: no run selected")];
		const s = row.summary;
		const lines = [`${this.theme.fg("accent", s.runId)} · ${s.surface} · ${s.status} · ${this.artifact}`];
		lines.push(this.theme.fg("dim", truncate(s.prompt || "(no prompt)", 160)));
		pushPreview(lines, this.theme, "files", s.files, 4);
		pushPreview(lines, this.theme, "symbols", s.symbols, 5);
		pushPreview(lines, this.theme, "signals", s.signals, 2);
		pushPreview(lines, this.theme, "risks", s.risks, 2);
		pushPreview(lines, this.theme, "missing", s.missingContext, 2);
		pushPreview(lines, this.theme, "scout-gaps", s.scoutGaps, 2);
		pushPreview(lines, this.theme, "paths", [s.resultPath, s.surfaceArtifactPath, s.packetPath, s.responsesPath, s.verifyPath].filter((item): item is string => Boolean(item)), 3);
		return lines;
	}

	private cycleArtifact(delta: number): void {
		const artifacts: HistoryArtifact[] = ["summary", "result", "surface", "packet", "responses", "verify"];
		const index = artifacts.indexOf(this.artifact);
		this.artifact = artifacts[(index + delta + artifacts.length) % artifacts.length]!;
	}

	private async openSelected(): Promise<void> {
		const row = this.filteredRows()[this.selected];
		if (!row) return;
		this.done(await artifactTextForSummary(this.cwd, row.summary, this.artifact));
	}

	private rerender(): void {
		this.tui.requestRender();
	}
}

function visibleWindow<T>(items: T[], selected: number, size: number): Array<{ item: T; row: T; index: number }> {
	const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
	return items.slice(start, start + size).map((item, offset) => ({ item, row: item, index: start + offset }));
}

function rankRows(rows: HistoryRow[], query: string): HistoryRow[] {
	if (/\b(?:file|symbol|surface|status|fresh|stale|since|after|before|until):/i.test(query)) {
		const parsed = parseQuery(query);
		return rows.filter((row) => matchesQuery(row, parsed)).slice(0, parsed.limit);
	}
	const tokens = tokenize(query.toLowerCase());
	if (tokens.length === 0) return rows;
	return rows
		.map((row) => ({ row, score: fuzzyScore(row, tokens) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || b.row.summary.startedAt - a.row.summary.startedAt)
		.map((item) => item.row);
}

function fuzzyScore(row: HistoryRow, tokens: string[]): number {
	const summary = row.summary;
	const haystack = [
		summary.runId,
		summary.prompt,
		summary.surface,
		summary.status,
		summary.failure_reason ?? "",
		...summary.files,
		...summary.symbols,
		...summary.keywords,
		...summary.signals,
		...summary.risks,
		...summary.missingContext,
		...summary.sourceRefs,
	].join("\n").toLowerCase();
	let score = 0;
	for (const token of tokens) {
		if (haystack.includes(token)) score += 10 + token.length;
		else if (isSubsequence(token, haystack)) score += 2;
		else return 0;
	}
	if (row.freshness === "fresh") score += 2;
	if (row.freshness === "stale") score -= 2;
	return score;
}

function isSubsequence(needle: string, haystack: string): boolean {
	let index = 0;
	for (const char of haystack) if (char === needle[index]) index++;
	return index >= needle.length;
}

function pushPreview(lines: string[], theme: Theme, label: string, items: string[] | undefined, limit: number): void {
	if (!items?.length) return;
	lines.push(`${theme.fg("muted", `${label}:`)} ${items.slice(0, limit).map((item) => truncate(item, 120)).join("; ")}${items.length > limit ? `; +${items.length - limit}` : ""}`);
}

async function openArtifactText(cwd: string, args: string): Promise<string> {
	const [runToken, artifactToken = "result"] = tokenize(args);
	if (!runToken) return "# scrutiny history\n\nusage: `/scrutiny history open <runId|latest> [result|summary|surface|packet|responses|verify]`";
	const loaded = await loadHistory(cwd);
	const matches = runToken === "latest"
		? loaded.rows.slice(0, 1)
		: loaded.rows.filter((row) => row.summary.runId === runToken || row.summary.runId.endsWith(runToken) || row.summary.runId.startsWith(runToken));
	if (matches.length === 0) return `# scrutiny history\n\nrun not found: \`${runToken}\``;
	if (matches.length > 1) return [`# scrutiny history`, "", `ambiguous run id: \`${runToken}\``, "", ...matches.slice(0, 10).map((row) => `- ${row.summary.runId} · ${row.summary.surface} · ${row.summary.prompt}`)].join("\n");
	const summary = matches[0].summary;
	const artifact = normalizeArtifact(artifactToken);
	if (!artifact) return "# scrutiny history\n\nunknown artifact. use `result`, `summary`, `surface`, `packet`, `responses`, or `verify`.";
	return artifactTextForSummary(cwd, summary, artifact);
}

async function artifactTextForSummary(cwd: string, summary: ScrutinySummary, artifact: HistoryArtifact): Promise<string> {
	const artifactPath = pathForArtifact(cwd, summary, artifact);
	if (!artifactPath) return `# scrutiny history\n\n${artifact} artifact not available for ${summary.runId}.`;
	try {
		const content = await fs.readFile(artifactPath, "utf8");
		return [`# scrutiny artifact`, "", `${summary.runId} · ${artifact} · ${path.relative(cwd, artifactPath)}`, "", "```", truncate(content.trim(), ARTIFACT_CHAR_LIMIT), "```"].join("\n");
	} catch (error) {
		return `# scrutiny history\n\nfailed to read ${artifact}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function normalizeArtifact(token: string): HistoryArtifact | undefined {
	if (["result", "summary", "surface", "packet", "responses", "verify"].includes(token)) return token as HistoryArtifact;
	return undefined;
}

function pathForArtifact(cwd: string, summary: ScrutinySummary, artifact: HistoryArtifact): string | undefined {
	const runDir = path.join(scrutinyDataDir(cwd), summary.runId);
	const relPath = artifact === "result" ? summary.resultPath
		: artifact === "surface" ? summary.surfaceArtifactPath
		: artifact === "packet" ? summary.packetPath
		: artifact === "responses" ? summary.responsesPath
		: artifact === "verify" ? summary.verifyPath
		: path.join(".pi", "scrutiny", summary.runId, "summary.json");
	const resolved = path.resolve(cwd, relPath ?? path.join(runDir, `${artifact}.json`));
	return isInside(cwd, resolved) ? resolved : undefined;
}

function topBorder(width: number, title: string, theme: Theme): string {
	const plain = `╭─ ${title} `;
	return theme.fg("borderAccent", truncateToWidth(`${plain}${"─".repeat(width)}`, width - 1, "")) + theme.fg("borderAccent", "╮");
}

function midBorder(width: number, theme: Theme): string {
	return theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
}

function bottomBorder(width: number, theme: Theme): string {
	return theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function frameLine(content: string, width: number, theme: Theme): string {
	const innerWidth = Math.max(0, width - 4);
	const clipped = truncateToWidth(content, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${theme.fg("borderMuted", "│ ")}${clipped}${padding}${theme.fg("borderMuted", " │")}`;
}

function isPrintable(data: string): boolean {
	return data.length > 0 && !/^\x1b/.test(data) && [...data].every((char) => char >= " " || char === "\n" || char === "\t");
}

function isInside(cwd: string, file: string): boolean {
	const relative = path.relative(cwd, file);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
