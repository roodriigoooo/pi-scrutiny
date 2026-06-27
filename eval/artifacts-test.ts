import { createHash } from "node:crypto";
import fs from "node:fs";
import fsP from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	appendSummary,
	artifactPath,
	dataDir,
	freshness,
	hashFiles,
	indexPath,
	loadSummaries,
	runDir,
	surfaceArtifactFile,
	writeIndex,
	type ArtifactKind,
} from "../extensions/scrutiny/artifacts.ts";
import type { ScrutinySummary } from "../extensions/scrutiny/types.ts";

/**
 * Unit test for the artifact memory module (issue #7): owns the .pi/scrutiny
 * layout (dataDir/runDir/indexPath/surfaceArtifactFile/artifactPath), freshness,
 * hashing, and summary index append/load/repair. Uses a temp cwd with planted
 * files. Also scans extension sources to fail if anyone re-introduces layout
 * logic outside artifacts.ts. artifacts.ts has no relative runtime imports, so
 * no resolve hook is needed. Run: `npm run eval:artifacts`.
 */

const failures: Array<{ name: string; error: string }> = [];
let checks = 0;

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
	checks += 1;
	try {
		await run();
		process.stdout.write(`  ✓ ${name}\n`);
	} catch (error) {
		failures.push({ name, error: error instanceof Error ? error.message : String(error) });
		process.stdout.write(`  ✕ ${name}\n`);
	}
}
function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}
function eq<T>(actual: T, expected: T, label: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeSummary(runId: string, startedAt: number, fileHashes: Record<string, string> = {}): ScrutinySummary {
	return {
		runId,
		surface: "risks",
		startedAt,
		endedAt: startedAt + 1,
		prompt: "review " + runId,
		status: "ok",
		files: [],
		symbols: [],
		keywords: [],
		signals: [],
		risks: [],
		contradictions: [],
		missingContext: [],
		sourceRefs: [],
		fileHashes,
		resultPath: path.join(".pi", "scrutiny", runId, "result.json"),
	};
}

async function main(): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrutiny-artifacts-"));
	try {
		const fileAbs = path.join(cwd, "src", "retry.ts");
		await fsP.mkdir(path.dirname(fileAbs), { recursive: true });
		await fsP.writeFile(fileAbs, "export function withRetry() {}", "utf8");
		const fileHash = createHash("sha1").update("export function withRetry() {}").digest("hex");

		process.stdout.write(`scrutiny artifacts · 8 checks\n`);

		await check("layout paths + surfaceArtifactFile", () => {
			eq(dataDir(cwd), path.join(cwd, ".pi", "scrutiny"), "dataDir");
			eq(runDir(cwd, "scr_abc"), path.join(cwd, ".pi", "scrutiny", "scr_abc"), "runDir");
			eq(indexPath(cwd), path.join(cwd, ".pi", "scrutiny", "index.jsonl"), "indexPath");
			eq(surfaceArtifactFile("risks"), "risks.json", "surfaceArtifactFile risks");
			eq(surfaceArtifactFile("verify"), undefined, "surfaceArtifactFile verify");
		});

		await check("artifactPath resolves inside cwd and guards escapes", () => {
			const summary = makeSummary("scr_abc", 1_000);
			const resolved = artifactPath(cwd, summary, "result");
			assert(resolved === path.join(cwd, ".pi", "scrutiny", "scr_abc", "result.json"), "result artifact path");
			const escaping: ScrutinySummary = { ...summary, resultPath: "../../etc/passwd" };
			eq(artifactPath(cwd, escaping, "result"), undefined, "escape guarded");
			const summaryArtifact = artifactPath(cwd, summary, "summary" as ArtifactKind);
			assert(summaryArtifact !== undefined && summaryArtifact.endsWith(path.join("scr_abc", "summary.json")), "summary artifact fallback path");
		});

		await check("hashFiles hashes referenced files, skips missing/outside/oversize", async () => {
			const hashes = await hashFiles(cwd, ["src/retry.ts", "missing.ts", "../outside.ts"]);
			eq(Object.keys(hashes), ["src/retry.ts"], "only the inside-cwd existing file is hashed");
			eq(hashes["src/retry.ts"], fileHash, "hash matches sha1 of contents");
		});

		await check("freshness is fresh / stale / unknown", async () => {
			const summary = makeSummary("scr_abc", 1_000, { "src/retry.ts": fileHash });
			eq((await freshness(cwd, summary)).freshness, "fresh", "unchanged file is fresh");
			await fsP.writeFile(fileAbs, "changed", "utf8");
			eq((await freshness(cwd, summary)).freshness, "stale", "changed file is stale");
			eq((await freshness(cwd, makeSummary("scr_def", 2_000))).freshness, "unknown", "no hashes is unknown");
		});

		await check("appendSummary + loadSummaries round-trip sorted newest-first", async () => {
			const indexCwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrutiny-artifacts-idx-"));
			try {
				await appendSummary(indexCwd, makeSummary("scr_old", 1_000));
				await appendSummary(indexCwd, makeSummary("scr_new", 3_000));
				const loaded = await loadSummaries(indexCwd);
				eq(loaded.summaries.map((s) => s.runId), ["scr_new", "scr_old"], "sorted newest-first");
				assert(!loaded.rebuilt, "should not rebuild when index exists");
				assert(loaded.warnings.length === 0, "no warnings");
			} finally {
				fs.rmSync(indexCwd, { recursive: true, force: true });
			}
		});

		await check("loadSummaries repairs a missing index by scanning run dirs", async () => {
			const repairCwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrutiny-artifacts-repair-"));
			try {
				const runId = "scr_planted";
				const dir = runDir(repairCwd, runId);
				await fsP.mkdir(dir, { recursive: true });
				const summary = makeSummary(runId, 5_000);
				await fsP.writeFile(path.join(dir, "summary.json"), JSON.stringify(summary), "utf8");
				const loaded = await loadSummaries(repairCwd);
				eq(loaded.summaries.map((s) => s.runId), [runId], "scanned summary loaded");
				assert(loaded.rebuilt, "index was rebuilt");
				assert(fs.existsSync(indexPath(repairCwd)), "index file written after rebuild");
				const again = await loadSummaries(repairCwd);
				assert(!again.rebuilt, "second load uses the rebuilt index");
			} finally {
				fs.rmSync(repairCwd, { recursive: true, force: true });
			}
		});

		await check("writeIndex rewrites the index from given summaries", async () => {
			const wCwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrutiny-artifacts-write-"));
			try {
				await writeIndex(wCwd, [makeSummary("scr_a", 1_000), makeSummary("scr_b", 2_000)]);
				const content = await fsP.readFile(indexPath(wCwd), "utf8");
				eq(content.trim().split("\n").length, 2, "two rows written");
				const loaded = await loadSummaries(wCwd);
				eq(loaded.summaries.map((s) => s.runId), ["scr_b", "scr_a"], "loaded sorted");
			} finally {
				fs.rmSync(wCwd, { recursive: true, force: true });
			}
		});

		await check("no extension re-declares artifact-layout logic outside artifacts.ts", () => {
			const extDir = path.resolve(process.cwd(), "extensions", "scrutiny");
			const files = fs.readdirSync(extDir).filter((f) => f.endsWith(".ts") && f !== "artifacts.ts");
			const banned = [
				"function scrutinyDataDir",
				"function surfaceArtifactFile",
				"function appendSummaryIndex",
				"function hashReferencedFiles",
				"function freshnessFor",
				"function pathForArtifact",
				"function summaryFreshness",
				"function scanSummaryFiles",
				"function parseIndex",
				"function dedupeSummaries",
				"function hashFile",
			];
			for (const file of files) {
				const src = fs.readFileSync(path.join(extDir, file), "utf8");
				for (const pattern of banned) {
					assert(!src.includes(pattern), `${file}: re-declares "${pattern}" (must live in artifacts.ts)`);
				}
			}
			const utilSrc = fs.readFileSync(path.join(extDir, "util.ts"), "utf8");
			assert(!/scrutinyDataDir/.test(utilSrc), "util.ts still references scrutinyDataDir (must live in artifacts.ts)");
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}

	const pass = checks - failures.length;
	process.stdout.write(`\nsuite: artifacts · ${pass}/${checks} pass · ${failures.length} fail\n`);
	if (failures.length > 0) {
		process.stdout.write("\nfailures:\n");
		for (const f of failures) process.stdout.write(`- ${f.name}: ${f.error}\n`);
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

main();
