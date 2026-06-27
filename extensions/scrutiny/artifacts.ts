import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ScrutinyRunResult, ScrutinySummary, ScrutinySurface } from "./types.js";

/**
 * Artifact memory module: owns the `.pi/scrutiny` file layout and exposes a
 * small interface for reading summaries, resolving artifacts, checking
 * freshness, and appending new runs (issue #7).
 *
 * One place for the layout rules. No database, no embeddings, no hidden project
 * brain. Summary writing, index append, history repair, freshness checks,
 * artifact path resolution, and prior-run lookup all go through here.
 */

const INDEX_FILE = "index.jsonl";
const RUN_PREFIX = "scr_";
const MAX_HASH_BYTES = 8 * 1024 * 1024;

export type Freshness = "fresh" | "stale" | "unknown";
export type ArtifactKind = "summary" | "result" | "surface" | "packet" | "responses" | "verify";

export type SummaryAnchor = { files: string[]; symbols: string[]; terms: string[] };

export type RelatedSummary = {
	summary: ScrutinySummary;
	freshness: Freshness;
	staleFiles: string[];
	why: string[];
	score: number;
};

const RELATED_SCAN_LIMIT = 100;
const RELATED_DEFAULT_LIMIT = 3;
const RELATED_FILE_WEIGHT = 8;
const RELATED_SYMBOL_WEIGHT = 4;
const RELATED_KEYWORD_WEIGHT = 1;
const RELATED_STALE_PENALTY = 4;

/**
 * Find prior summaries that overlap the given anchors (files, symbols, terms).
 * Owns index read, overlap scoring, freshness, stale penalty, and cap. Callers
 * (scout) own only candidate rendering. Storage stays behind this seam (#8).
 */
export async function findRelatedSummaries(cwd: string, anchors: SummaryAnchor, limit: number = RELATED_DEFAULT_LIMIT): Promise<RelatedSummary[]> {
	const { summaries } = await loadSummaries(cwd);
	const recent = summaries.slice(0, RELATED_SCAN_LIMIT); // loadSummaries is newest-first
	const scored: RelatedSummary[] = [];
	for (const summary of recent) {
		const why: string[] = [];
		let score = 0;
		const fileHits = summary.files.filter((file) => anchors.files.includes(file));
		if (fileHits.length) { score += RELATED_FILE_WEIGHT * fileHits.length; why.push(`file:${fileHits.slice(0, 2).join(",")}`); }
		const symbolHits = summary.symbols.filter((symbol) => anchors.symbols.includes(symbol));
		if (symbolHits.length) { score += RELATED_SYMBOL_WEIGHT * symbolHits.length; why.push(`symbol:${symbolHits.slice(0, 2).join(",")}`); }
		const keywordHits = summary.keywords.filter((keyword) => anchors.terms.includes(keyword));
		if (keywordHits.length) { score += RELATED_KEYWORD_WEIGHT * keywordHits.length; why.push(`keyword:${keywordHits.slice(0, 3).join(",")}`); }
		const f = await freshness(cwd, summary);
		if (f.freshness === "stale") score -= RELATED_STALE_PENALTY;
		if (score <= 0) continue;
		scored.push({ summary, freshness: f.freshness, staleFiles: f.staleFiles, why, score });
	}
	return scored.sort((a, b) => b.score - a.score || b.summary.startedAt - a.summary.startedAt).slice(0, limit);
}

export function dataDir(cwd: string): string {
	return path.join(cwd, ".pi", "scrutiny");
}

export function runDir(cwd: string, runId: string): string {
	return path.join(dataDir(cwd), runId);
}

export function indexPath(cwd: string): string {
	return path.join(dataDir(cwd), INDEX_FILE);
}

/** verify writes verify.json; every other surface writes <surface>.json next to result.json. */
export function surfaceArtifactFile(surface: ScrutinySurface | ScrutinyRunResult["surface"]): string | undefined {
	if (surface === "verify") return undefined;
	return `${surface}.json`;
}

/** Resolve an artifact to an absolute path, guarded to stay inside cwd. */
export function artifactPath(cwd: string, summary: ScrutinySummary, artifact: ArtifactKind): string | undefined {
	const base = runDir(cwd, summary.runId);
	const relPath = artifact === "result" ? summary.resultPath
		: artifact === "surface" ? summary.surfaceArtifactPath
		: artifact === "packet" ? summary.packetPath
		: artifact === "responses" ? summary.responsesPath
		: artifact === "verify" ? summary.verifyPath
		: path.join(".pi", "scrutiny", summary.runId, "summary.json");
	const resolved = path.resolve(cwd, relPath ?? path.join(base, `${artifact}.json`));
	return isInside(cwd, resolved) ? resolved : undefined;
}

/** sha1 of referenced files (capped at MAX_HASH_BYTES), skipping files outside cwd. */
export async function hashFiles(cwd: string, files: string[]): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const file of files) {
		const abs = path.resolve(cwd, file);
		if (!isInside(cwd, abs)) continue;
		try {
			const stat = await fs.stat(abs);
			if (!stat.isFile() || stat.size > MAX_HASH_BYTES) continue;
			hashes[file] = createHash("sha1").update(await fs.readFile(abs)).digest("hex");
		} catch {
			// deleted/missing/generated file; leave unhashed.
		}
	}
	return hashes;
}

export async function freshness(cwd: string, summary: ScrutinySummary): Promise<{ freshness: Freshness; staleFiles: string[] }> {
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

/** Append one summary row to the JSONL index. Best-effort: caller guards primary result. */
export async function appendSummary(cwd: string, summary: ScrutinySummary): Promise<void> {
	const file = indexPath(cwd);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.appendFile(file, `${JSON.stringify(summary)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readIndex(cwd: string): Promise<{ summaries: ScrutinySummary[]; warnings: string[] }> {
	const warnings: string[] = [];
	let content: string;
	try {
		content = await fs.readFile(indexPath(cwd), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`index read failed: ${error instanceof Error ? error.message : String(error)}`);
		return { summaries: [], warnings };
	}
	return { summaries: parseIndex(content, warnings), warnings };
}

/** Scan run dirs for summary.json (used to repair a missing/corrupt index). */
export async function scanSummaries(cwd: string): Promise<{ summaries: ScrutinySummary[]; warnings: string[] }> {
	const warnings: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dataDir(cwd), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`run-dir scan failed: ${error instanceof Error ? error.message : String(error)}`);
		return { summaries: [], warnings };
	}
	const summaries: ScrutinySummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(RUN_PREFIX)) continue;
		try {
			const parsed = JSON.parse(await fs.readFile(path.join(dataDir(cwd), entry.name, "summary.json"), "utf8")) as ScrutinySummary;
			if (parsed?.runId) summaries.push(parsed);
		} catch {
			warnings.push(`${entry.name}: missing/corrupt summary.json`);
		}
	}
	return { summaries, warnings };
}

export async function writeIndex(cwd: string, summaries: ScrutinySummary[]): Promise<void> {
	const file = indexPath(cwd);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, summaries.map((summary) => JSON.stringify(summary)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * Load summaries from the index, repairing by scanning run dirs when the index
 * is missing/corrupt. Returns deduped summaries sorted newest-first plus
 * whether the index was rebuilt and any warnings.
 */
export async function loadSummaries(cwd: string): Promise<{ summaries: ScrutinySummary[]; rebuilt: boolean; warnings: string[] }> {
	const warnings: string[] = [];
	let summaries: ScrutinySummary[] = [];
	let rebuilt = false;
	try {
		summaries = parseIndex(await fs.readFile(indexPath(cwd), "utf8"), warnings);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`index read failed: ${error instanceof Error ? error.message : String(error)}`);
		const scanned = await scanSummaries(cwd);
		summaries = scanned.summaries;
		warnings.push(...scanned.warnings);
		if (summaries.length > 0) {
			await writeIndex(cwd, summaries);
			rebuilt = true;
		}
	}
	return { summaries: dedupeSummaries(summaries).sort((a, b) => b.startedAt - a.startedAt), rebuilt, warnings };
}

export function isInside(cwd: string, file: string): boolean {
	const relative = path.relative(cwd, file);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export type RunPreview = { runId: string; runDir: string; files: string[]; bytes: number; exists: boolean };

export type DeleteResult = { runId: string; deleted: boolean; runDir: string; removedFiles: string[]; indexRebuilt: boolean; remainingCount: number };

export type ClearResult = { deletedCount: number; removedFiles: string[]; remainingCount: number };

/** Rebuild index.jsonl from remaining run-dir summaries. Returns remaining count. */
export async function rebuildIndex(cwd: string): Promise<number> {
	const { summaries } = await scanSummaries(cwd);
	await writeIndex(cwd, summaries);
	return summaries.length;
}

/** Preview a run dir's files and bytes without deleting. Guarded to dataDir children only. */
export async function previewRun(cwd: string, runId: string): Promise<RunPreview> {
	const target = runDir(cwd, runId);
	if (!isRunChild(cwd, runId) || !(await isDirectory(target))) return { runId, runDir: target, files: [], bytes: 0, exists: false };
	const files = await listFiles(target);
	let bytes = 0;
	for (const file of files) {
		try { bytes += (await fs.stat(path.join(target, file))).size; } catch { /* deleted mid-walk */ }
	}
	return { runId, runDir: target, files, bytes, exists: true };
}

/** Delete one run dir and rebuild the index. Never touches .pi/scrutiny.json; never escapes dataDir. */
export async function deleteRun(cwd: string, runId: string): Promise<DeleteResult> {
	const target = runDir(cwd, runId);
	if (!isRunChild(cwd, runId) || !(await isDirectory(target))) {
		return { runId, deleted: false, runDir: target, removedFiles: [], indexRebuilt: false, remainingCount: await countSummaries(cwd) };
	}
	const removedFiles = await listFiles(target);
	await fs.rm(target, { recursive: true, force: true });
	const remainingCount = await rebuildIndex(cwd);
	return { runId, deleted: true, runDir: target, removedFiles, indexRebuilt: true, remainingCount };
}

/** Delete every scr_* run dir under dataDir and empty the index. Never touches .pi/scrutiny.json. */
export async function deleteAllRuns(cwd: string): Promise<ClearResult> {
	const dir = dataDir(cwd);
	let entries: import("node:fs").Dirent[];
	try { entries = await fs.readdir(dir, { withFileTypes: true }); }
	catch { return { deletedCount: 0, removedFiles: [], remainingCount: 0 }; }
	let deletedCount = 0;
	const removedFiles: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(RUN_PREFIX)) continue;
		const target = path.join(dir, entry.name);
		removedFiles.push(...(await listFiles(target)).map((f) => path.join(entry.name, f)));
		await fs.rm(target, { recursive: true, force: true });
		deletedCount += 1;
	}
	await writeIndex(cwd, []);
	return { deletedCount, removedFiles, remainingCount: 0 };
}

/** True if runId names a direct scr_* child of dataDir (no traversal, no escape). */
function isRunChild(cwd: string, runId: string): boolean {
	if (!runId.startsWith(RUN_PREFIX)) return false;
	const rel = path.relative(dataDir(cwd), runDir(cwd, runId));
	return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

async function isDirectory(target: string): Promise<boolean> {
	try { return (await fs.stat(target)).isDirectory(); } catch { return false; }
}

async function listFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	const stack: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: "" }];
	while (stack.length) {
		const { abs, rel } = stack.pop()!;
		let entries: import("node:fs").Dirent[];
		try { entries = await fs.readdir(abs, { withFileTypes: true }); }
		catch { continue; }
		for (const entry of entries) {
			const childRel = rel ? path.join(rel, entry.name) : entry.name;
			if (entry.isDirectory()) stack.push({ abs: path.join(abs, entry.name), rel: childRel });
			else out.push(childRel);
		}
	}
	return out.sort();
}

async function countSummaries(cwd: string): Promise<number> {
	const { summaries } = await loadSummaries(cwd);
	return summaries.length;
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

function dedupeSummaries(summaries: ScrutinySummary[]): ScrutinySummary[] {
	const byRun = new Map<string, ScrutinySummary>();
	for (const summary of summaries) byRun.set(summary.runId, summary);
	return [...byRun.values()];
}
