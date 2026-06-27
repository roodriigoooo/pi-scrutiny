import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneScoutCandidates, renderScoutMarkdown, runContextScout } from "../extensions/scrutiny/scout.ts";
import type { ScoutReport } from "../extensions/scrutiny/types.ts";

/**
 * Unit test for the context scout (issues #4, #5, #6): runContextScout returns
 * structured data (anchors, ranked candidates with stable ids, first-class gaps),
 * renderScoutMarkdown renders at the edge, and pruneScoutCandidates rebuilds the
 * packet by candidate id. Uses a mock exec + temp cwd so no real git/rg/index
 * state leaks in. Run: `npm run eval:scout`.
 */

type Exec = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

const failures: Array<{ name: string; error: string }> = [];
let checks = 0;

function check(name: string, run: () => void): void {
	checks += 1;
	try {
		run();
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

function mockExec(rgJson: string, rgFiles: string, diffFiles: string): Exec {
	return async (command, args) => {
		if (command === "git" && args[0] === "rev-parse") return { stdout: "true", code: 0 };
		if (command === "git" && args[0] === "diff" && args[1] === "--name-only" && args[2] === "HEAD") return { stdout: diffFiles, code: 0 };
		if (command === "git" && args[0] === "diff" && args[1] === "--name-only") return { stdout: "", code: 0 };
		if (command === "rg" && args[0] === "--json") return { stdout: rgJson, code: 0 };
		if (command === "rg" && args[0] === "--files") return { stdout: rgFiles, code: 0 };
		return { stdout: "", code: 0 };
	};
}

function rgMatch(file: string, line: number, text: string): string {
	return JSON.stringify({ type: "match", data: { path: { text: file }, line_number: line, lines: { text } } });
}

async function main(): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrutiny-scout-"));
	try {
		const rgJson = rgMatch("src/retry.test.ts", 42, "withRetry swallows terminal error") + "\n" + rgMatch("src/retry.ts", 17, "function withRetry(fn) {");
		const rgFiles = "docs/adr/004-orders.md\nREADME.md\n";
		const exec = mockExec(rgJson, rgFiles, "src/retry.ts");

		const report = await runContextScout({
			params: { prompt: "review withRetry in src/retry.ts for duplicate orders" },
			surface: "risks",
			cwd,
			exec,
		});

		process.stdout.write(`scrutiny scout · ${4} checks\n`);

		check("runContextScout returns a non-skipped report with anchors", () => {
			assert(!report.skipped, "report should not be skipped");
			assert(report.anchors.files.includes("src/retry.ts"), "anchor file missing");
			assert(report.anchors.symbols.includes("withRetry"), "anchor symbol missing");
			assert(report.anchors.terms.includes("duplicate"), "anchor term 'duplicate' missing");
		});

		check("candidates are ranked with stable c0/c1... ids", () => {
			assert(report.candidates.length >= 2, "expected at least 2 candidates");
			eq(report.candidates.map((c) => c.id), report.candidates.map((_, i) => `c${i}`), "ids are c0.. in order");
			eq(report.candidates[0].title, "src/retry.ts", "top candidate is the explicit/diff file");
			assert(report.candidates.some((c) => c.kind === "match" && c.title.startsWith("src/retry.test.ts:")), "test match candidate missing");
			assert(report.priorCount === 0, "no prior candidates in temp cwd");
		});

		check("gaps are first-class data and empty when tests + docs are surfaced", () => {
			const ids = report.gaps.map((g) => g.id);
			assert(!ids.includes("no-tests"), "should not flag no-tests (test file surfaced)");
			assert(!ids.includes("no-docs-config"), "should not flag no-docs-config (doc surfaced)");
			assert(report.gaps.every((g) => g.id && g.severity && g.message), "every gap has id/severity/message");
		});

		check("pruneScoutCandidates toggles by id and rebuilds the section", () => {
			const packet = `# Scrutiny task packet\nsurface: risks\n\n## Task\nreview\n\n${renderScoutMarkdown(report)}\n\n## Instructions\n- go\n`;
			const matchCandidate = report.candidates.find((c) => c.kind === "match")!;
			const pruned = pruneScoutCandidates(packet, report, new Set([matchCandidate.id]));
			assert(!pruned.includes(matchCandidate.title), "pruned packet still contains excluded candidate title");
			assert(pruned.includes("preview pruning: 1 scout candidate(s) hidden"), "pruning note missing");
			assert(/^## Instructions$/m.test(pruned), "instructions section survived the splice");
			assert(/^## Context scout$/m.test(pruned), "scout heading survived the splice");

			const allPruned = pruneScoutCandidates(packet, report, new Set(report.candidates.map((c) => c.id)));
			assert(allPruned.includes("preview pruning: all scout candidates hidden"), "all-pruned note missing");
		});

		// Second scenario: no tests/docs surfaced -> no-tests + no-docs-config gaps.
		const thinReport = await runContextScout({
			params: { prompt: "review withRetry for duplicate orders" },
			surface: "risks",
			cwd,
			exec: mockExec(rgMatch("src/retry.ts", 17, "function withRetry(fn) {"), "", "src/retry.ts"),
		});

		check("thin packet surfaces no-tests and no-docs-config gaps", () => {
			const ids = thinReport.gaps.map((g) => g.id);
			assert(ids.includes("no-tests"), "no-tests gap missing");
			assert(ids.includes("no-docs-config"), "no-docs-config gap missing");
		});

		// Third scenario: no anchors at all -> skipped report + no-anchors gap.
		const skipped = await runContextScout({
			params: { prompt: "hi there" },
			surface: "consult",
			cwd,
			exec: mockExec("", "", ""),
		});

		check("no anchors -> skipped report + no-anchors gap, no candidates", () => {
			assert(skipped.skipped, "report should be skipped");
			eq(skipped.candidates, [], "skipped report has no candidates");
			assert(skipped.gaps.some((g) => g.id === "no-anchors"), "no-anchors gap missing");
			assert(renderScoutMarkdown(skipped).includes("skipped:"), "skipped render missing skip note");
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}

	const pass = checks - failures.length;
	process.stdout.write(`\nsuite: scout · ${pass}/${checks} pass · ${failures.length} fail\n`);
	if (failures.length > 0) {
		process.stdout.write("\nfailures:\n");
		for (const f of failures) process.stdout.write(`- ${f.name}: ${f.error}\n`);
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

main();
