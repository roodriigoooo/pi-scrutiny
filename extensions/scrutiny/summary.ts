import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PanelResponse, ScrutinyRunResult, ScrutinySummary } from "./types.js";
import { scrutinyDataDir, truncate } from "./util.js";

const MAX_ITEMS = 40;
const MAX_SOURCE_REFS = 60;
const MAX_HASH_BYTES = 8 * 1024 * 1024;

export async function writeRunResult(input: { cwd: string; runDir: string; result: ScrutinyRunResult; prompt?: string }): Promise<void> {
	await fs.writeFile(path.join(input.runDir, "result.json"), JSON.stringify(input.result, null, 2), { encoding: "utf8", mode: 0o600 });
	await writeSurfaceArtifact(input).catch(() => undefined);
	try {
		await writeRunSummary(input);
	} catch {
		// Summary/index is best-effort. Never hide primary result.json write.
	}
}

async function writeSurfaceArtifact(input: { runDir: string; result: ScrutinyRunResult }): Promise<void> {
	const file = surfaceArtifactFile(input.result.surface);
	if (!file) return;
	const artifact = {
		runId: input.result.runId,
		surface: input.result.surface,
		status: input.result.status,
		failure_reason: input.result.failure_reason,
		error: input.result.error,
		packetPath: input.result.packetPath,
		analysis: input.result.analysis,
		panel: input.result.responses.map((response) => ({
			model: response.model,
			role: response.role,
			status: response.status,
			content: response.content,
			error: response.error,
			durationMs: response.durationMs,
		})),
		failed_models: input.result.failed_models,
		verify: input.result.verify ? {
			passed: input.result.verify.passed,
			failed: input.result.verify.failed,
			skipped: input.result.verify.skipped,
			durationMs: input.result.verify.durationMs,
		} : undefined,
		startedAt: input.result.startedAt,
		endedAt: input.result.endedAt,
		durationMs: input.result.durationMs,
	};
	await fs.writeFile(path.join(input.runDir, file), JSON.stringify(artifact, null, 2), { encoding: "utf8", mode: 0o600 });
}

function surfaceArtifactFile(surface: ScrutinyRunResult["surface"]): string | undefined {
	if (surface === "verify") return undefined; // verify already writes verify.json.
	return `${surface}.json`;
}

export async function writeRunSummary(input: { cwd: string; runDir: string; result: ScrutinyRunResult; prompt?: string }): Promise<ScrutinySummary> {
	const summary = await buildRunSummary(input);
	await fs.writeFile(path.join(input.runDir, "summary.json"), JSON.stringify(summary, null, 2), { encoding: "utf8", mode: 0o600 });
	await appendSummaryIndex(input.cwd, summary);
	return summary;
}

async function buildRunSummary(input: { cwd: string; runDir: string; result: ScrutinyRunResult; prompt?: string }): Promise<ScrutinySummary> {
	const { cwd, runDir, result } = input;
	const prompt = truncate((input.prompt?.trim() || extractTask(result.packet) || result.error || "").trim(), 1_000);
	const responseText = result.responses.map((response) => response.content).join("\n");
	const analysisText = analysisToText(result);
	const searchableText = [prompt, result.packet, responseText, analysisText].filter(Boolean).join("\n");
	const sourceRefs = limit(extractSourceRefs(searchableText), MAX_SOURCE_REFS);
	const files = limit(unique([...sourceRefs.map(fileFromRef), ...extractDiffFiles(result.packet)]).filter(Boolean), MAX_ITEMS);
	const symbols = limit(extractSymbols(searchableText), MAX_ITEMS);
	const keywords = limit(extractKeywords([prompt, analysisText, files.join(" ")].join("\n")), MAX_ITEMS);
	const missingContext = limit(extractMissingContext(result.responses, result.analysis?.blind_spots), 8);
	const fileHashes = await hashReferencedFiles(cwd, files);
	const verifyPath = result.verify && await exists(path.join(runDir, "verify.json")) ? rel(cwd, path.join(runDir, "verify.json")) : undefined;
	const responsesPath = await exists(path.join(runDir, "responses.json")) ? rel(cwd, path.join(runDir, "responses.json")) : undefined;
	const surfaceArtifactName = surfaceArtifactFile(result.surface);
	const surfaceArtifactPath = surfaceArtifactName && await exists(path.join(runDir, surfaceArtifactName)) ? rel(cwd, path.join(runDir, surfaceArtifactName)) : undefined;

	return {
		runId: result.runId,
		surface: result.surface,
		startedAt: result.startedAt,
		endedAt: result.endedAt,
		prompt,
		status: result.status,
		failure_reason: result.failure_reason,
		error: result.error ? truncate(result.error, 500) : undefined,
		files,
		symbols,
		keywords,
		signals: limit(extractSignals(result), 8),
		risks: limit(result.analysis?.risks ?? [], 8).map((item) => truncate(item, 300)),
		contradictions: limit(extractContradictions(result), 6),
		missingContext,
		sourceRefs,
		fileHashes,
		resultPath: rel(cwd, path.join(runDir, "result.json")),
		surfaceArtifactPath,
		packetPath: result.packetPath ? rel(cwd, result.packetPath) : undefined,
		responsesPath,
		verifyPath,
	};
}

async function appendSummaryIndex(cwd: string, summary: ScrutinySummary): Promise<void> {
	const indexPath = path.join(scrutinyDataDir(cwd), "index.jsonl");
	await fs.mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
	await fs.appendFile(indexPath, `${JSON.stringify(summary)}\n`, { encoding: "utf8", mode: 0o600 });
}

function extractTask(packet: string): string {
	const match = packet.match(/^## Task\s*\n([\s\S]*?)(?=\n## |$)/m);
	return match?.[1]?.trim() ?? "";
}

function analysisToText(result: ScrutinyRunResult): string {
	const analysis = result.analysis;
	if (!analysis) return "";
	return [
		...(analysis.consensus ?? []),
		...(analysis.risks ?? []),
		...(analysis.coverage ?? []),
		...(analysis.blind_spots ?? []),
		...(analysis.unique_insights ?? []).map((item) => item.insight),
		...(result.panel_mode === "roles" ? [] : (analysis.contradictions ?? []).flatMap((item) => [item.topic, ...item.stances.map((stance) => stance.stance)])),
	].join("\n");
}

function extractSignals(result: ScrutinyRunResult): string[] {
	const analysis = result.analysis;
	if (!analysis) return [];
	const consensus = (analysis.consensus ?? []).filter((item) => !/panelists returned usable output|shared technical vocabulary/i.test(item));
	const uniqueInsights = (analysis.unique_insights ?? []).map((item) => item.insight);
	return unique([...consensus, ...(analysis.coverage ?? []), ...uniqueInsights]).map((item) => truncate(item, 300));
}

function extractContradictions(result: ScrutinyRunResult): string[] {
	if (result.panel_mode === "roles") return [];
	return (result.analysis?.contradictions ?? []).map((item) => {
		const stances = item.stances.map((stance) => `${stance.model}: ${stance.stance}`).join(" | ");
		return truncate(`${item.topic}${stances ? ` — ${stances}` : ""}`, 400);
	});
}

function extractMissingContext(responses: PanelResponse[], blindSpots: string[] | undefined): string[] {
	const lines = responses.flatMap((response) => response.content.split(/\r?\n/));
	const missing = lines
		.map(cleanBullet)
		.filter((line) => line.length >= 20 && line.length <= 500)
		.filter((line) => /\b(missing|not shown|not in (the )?packet|insufficient|unknown|cannot determine|can't determine|need(?:s)? to inspect|must inspect|would need|need more evidence|not enough evidence)\b/i.test(line));
	const nonGenericBlindSpots = (blindSpots ?? []).filter((line) => !/^Deterministic analysis does not infer/i.test(line));
	return unique([...missing, ...nonGenericBlindSpots]).map((item) => truncate(item, 300));
}

function extractSourceRefs(text: string): string[] {
	const refs: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const diff = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (diff) {
			pushRef(refs, diff[1]);
			pushRef(refs, diff[2]);
			continue;
		}
		const marker = line.match(/^(?:---|\+\+\+)\s+(?:a|b)\/(.+)$/);
		if (marker) pushRef(refs, marker[1]);
		const status = line.match(/^\s*(?:[MADRCU?]{1,2}|[ MADRCU?][ MADRCU?])\s+(.+?\.[A-Za-z0-9]+)$/);
		if (status) pushRef(refs, status[1]);
	}
	const pathPattern = /(^|[\s([{"'`])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+)(?::(\d+))?/g;
	let match: RegExpExecArray | null;
	while ((match = pathPattern.exec(text))) pushRef(refs, match[2], match[3]);
	const rootFilePattern = /(^|[\s([{"'`])([A-Za-z0-9_.@+-]+\.(?:md|mdx|txt|json|ya?ml|toml|ts|tsx|js|jsx|py|java|kt|go|rs|sql|proto|graphql|gradle|xml|properties|env|sh))(?::(\d+))?/gi;
	while ((match = rootFilePattern.exec(text))) pushRef(refs, match[2], match[3]);
	return unique(refs);
}

function extractDiffFiles(packet: string): string[] {
	const files: string[] = [];
	for (const ref of extractSourceRefs(packet)) files.push(fileFromRef(ref));
	return unique(files.filter(Boolean));
}

function pushRef(refs: string[], rawFile: string, line?: string): void {
	const file = normalizeFilePath(rawFile);
	if (!file) return;
	refs.push(line ? `${file}:${line}` : file);
}

function normalizeFilePath(raw: string): string | undefined {
	let file = raw.trim().replace(/^['"`]|['"`,.;)\]]$/g, "");
	file = file.replace(/^(?:a|b)\//, "").replace(/^\.\//, "");
	if (!file || file.includes("://") || path.isAbsolute(file)) return undefined;
	if (file.split("/").some((part) => part === "..")) return undefined;
	if (/^(?:node_modules|\.git|\.pi\/scrutiny)\//.test(file)) return undefined;
	if (/^(?:packet\.md|responses\.json|result\.json|summary\.json|verify\.json)$/.test(file)) return undefined;
	return file;
}

function fileFromRef(ref: string): string {
	const match = ref.match(/^(.+?)(?::\d+)?$/);
	return normalizeFilePath(match?.[1] ?? "") ?? "";
}

function extractSymbols(text: string): string[] {
	const symbols: string[] = [];
	for (const match of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)`/g)) symbols.push(match[1]);
	for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g)) symbols.push(match[1]);
	return unique(symbols.filter((symbol) => symbol.length >= 4 && !STOP.has(symbol.toLowerCase())));
}

function extractKeywords(text: string): string[] {
	const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
	return unique(tokens.filter((token) => !STOP.has(token) && token.length <= 40));
}

async function hashReferencedFiles(cwd: string, files: string[]): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const file of files) {
		const abs = path.resolve(cwd, file);
		if (!isInside(cwd, abs)) continue;
		try {
			const stat = await fs.stat(abs);
			if (!stat.isFile() || stat.size > MAX_HASH_BYTES) continue;
			const data = await fs.readFile(abs);
			hashes[file] = createHash("sha1").update(data).digest("hex");
		} catch {
			// deleted/missing/generated file; leave unhashed.
		}
	}
	return hashes;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

function rel(cwd: string, file: string): string {
	const relative = path.relative(cwd, file);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

function isInside(cwd: string, file: string): boolean {
	const relative = path.relative(cwd, file);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function cleanBullet(line: string): string {
	return line.trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
}

function unique(items: string[]): string[] {
	return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function limit<T>(items: T[], count: number): T[] {
	return items.slice(0, count);
}

const STOP = new Set([
	"about", "after", "again", "answer", "because", "before", "could", "first", "model", "panel", "there", "these", "thing", "which", "would", "should", "their", "while", "where", "under", "using", "without", "recommendation", "evidence", "position", "panelist", "scrutiny", "surface", "packet", "context", "result", "status", "failed", "error", "output", "outputs", "returned", "usable", "technical", "vocabulary", "shared", "confidence", "deterministic", "analysis",
]);
