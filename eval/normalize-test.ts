import { normalizeSurface } from "../extensions/scrutiny/normalize.ts";
import type { PanelResponse } from "../extensions/scrutiny/types.ts";

/**
 * Unit test for surface normalization (issue #12): parses messy panel Markdown
 * by canonical headings into structured per-surface artifacts. normalize.ts has
 * only type-only relative imports, so no resolve hook is needed. Run:
 * `npm run eval:normalize`.
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

function resp(model: string, role: string, content: string): PanelResponse {
	return { model, role, status: "ok", content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, durationMs: 1, exitCode: 0 };
}

async function main(): Promise<void> {
	process.stdout.write(`scrutiny normalize · 7 checks\n`);

	await check("hypotheses: extracts root causes, evidence, tests, missing context from messy text", () => {
		const responses = [
			resp("m1", "replicate analyst", [
				"## Likely root causes (ranked)",
				"- withRetry swallows the terminal retry error",
				"- offset commit happens before the handler returns",
				"## Confirming evidence per cause",
				"- src/retry.ts:42 returns success on final failure",
				"## Minimal distinguishing test",
				"- force the 4th retry to fail and assert ack is NOT called",
				"## What would rule this cause out",
				"- if ack only fires on explicit success, retry is innocent",
				"## Missing context / needed inspection",
				"- inspect OrderRepository unique constraints",
			].join("\n")),
			resp("m2", "replicate analyst", [
				"## Likely root causes (ranked)",
				"1. duplicate idempotency key not enforced at the consumer",
				"## Minimal distinguishing test",
				"* replay the same message twice and count inserts",
				"## Missing context / needed inspection",
				"- inspect payment capture boundary",
			].join("\n")),
		];
		const art = normalizeSurface("hypotheses", responses);
		assert(art?.surface === "hypotheses", "surface");
		const h = art?.hypotheses!;
		eq(h.rootCauses, [
			"withRetry swallows the terminal retry error",
			"offset commit happens before the handler returns",
			"duplicate idempotency key not enforced at the consumer",
		], "rootCauses (bullets + numbered)");
		assert(h.confirmingEvidence.some((e) => e.includes("src/retry.ts:42")), "confirming evidence captured");
		eq(h.distinguishingTests, [
			"force the 4th retry to fail and assert ack is NOT called",
			"replay the same message twice and count inserts",
		], "distinguishingTests (dash + bullet)");
		eq(h.missingContext, ["inspect OrderRepository unique constraints", "inspect payment capture boundary"], "missingContext merged across panelists");
	});

	await check("risks: groups findings by risk class with severity + suggested check", () => {
		const responses = [
			resp("m1", "concurrency reviewer", [
				"## Risk class",
				"concurrency",
				"## Findings",
				"- retry final failure may still ack the message",
				"## Severity",
				"high",
				"## Suggested check or test",
				"- assert ack is not called when all retries fail",
			].join("\n")),
			resp("m2", "reactive-chain reviewer", [
				"## Risk class",
				"reactive-chain",
				"## Findings",
				"- flatMap swallows onError per inner publisher",
				"## Severity",
				"medium",
				"## Suggested check or test",
				"- stepVerifier with an error-emitting inner",
			].join("\n")),
		];
		const art = normalizeSurface("risks", responses);
		const r = art?.risks!;
		eq(r.findings.length, 2, "two findings");
		eq(r.findings[0]!.riskClass, "concurrency", "first risk class");
		eq(r.findings[0]!.severity, "high", "first severity");
		eq(r.findings[0]!.suggestedCheck, "assert ack is not called when all retries fail", "first suggested check");
		eq(r.findings[1]!.riskClass, "reactive-chain", "second risk class");
		assert(r.findings[1]!.finding.includes("flatMap"), "second finding text");
	});

	await check("criteria: extracts criteria, edge cases, test cases, migration concerns", () => {
		const responses = [resp("m1", "replicate analyst", [
			"## Acceptance criteria",
			"- idempotency key enforced on the consumer",
			"## Edge cases",
			"- duplicate message after rebalance",
			"## Backward-compatibility risks",
			"- existing consumers without a key must keep working",
			"## Migration concerns",
			"- backfill keys for in-flight messages",
			"## Test cases",
			"- replay duplicate, assert single insert",
			"## Missing context / needed inspection",
			"- inspect schema for unique index",
		].join("\n"))];
		const c = normalizeSurface("criteria", responses)?.criteria!;
		eq(c.criteria, ["idempotency key enforced on the consumer"], "criteria");
		eq(c.edgeCases, ["duplicate message after rebalance"], "edgeCases");
		eq(c.testCases, ["replay duplicate, assert single insert"], "testCases");
		eq(c.migrationConcerns, ["backfill keys for in-flight messages"], "migrationConcerns");
		eq(c.missingContext, ["inspect schema for unique index"], "missingContext");
	});

	await check("repo-map: extracts symbols, call paths, tests, configs, and file paths", () => {
		const responses = [resp("m1", "call-path mapper", [
			"## Relevant symbols",
			"- `withRetry`, `commitOffset`",
			"## Call paths",
			"- OrderConsumer.handle -> withRetry -> commitOffset (src/consumer.ts:30)",
			"## Tests touched",
			"- src/retry.test.ts",
			"## Config / files",
			"- config/kafka.properties",
			"## Invariants / prior patterns",
			"- offset commit must follow handler success",
			"## Missing context / needed inspection",
			"- inspect OrderRepository",
		].join("\n"))];
		const m = normalizeSurface("repo-map", responses)?.repoMap!;
		assert(m.symbols.some((s) => s.includes("withRetry")), "symbols captured");
		assert(m.callPaths.some((p) => p.includes("OrderConsumer.handle")), "callPaths captured");
		assert(m.tests.includes("src/retry.test.ts"), "tests captured");
		assert(m.configs.includes("config/kafka.properties"), "configs captured");
		assert(m.files.includes("src/consumer.ts") || m.files.some((f) => f.startsWith("src/consumer.ts")), "file path extracted from call path");
		assert(m.missingContext.includes("inspect OrderRepository"), "missingContext captured");
	});

	await check("consult: extracts position, evidence, risks, recommendation", () => {
		const responses = [resp("m1", "replicate analyst", [
			"## Position",
			"- prefer subagent over docket for this scope",
			"## Evidence",
			"- subagents preserve ctx isolation",
			"## Risks",
			"- docket has better status UI",
			"## Blind spots / missing evidence",
			"- no latency data for docket",
			"## Recommendation",
			"use subagents for now; revisit after docket status lands",
		].join("\n"))];
		const c = normalizeSurface("consult", responses)?.consult!;
		eq(c.positions, ["prefer subagent over docket for this scope"], "positions");
		eq(c.risks, ["docket has better status UI"], "risks");
		eq(c.blindSpots, ["no latency data for docket"], "blindSpots");
		assert(Boolean(c.recommendation?.includes("use subagents")), "recommendation first line");
	});

	await check("verify: returns a minimal marker artifact", () => {
		const art = normalizeSurface("verify", []);
		eq(art, { surface: "verify" }, "verify marker");
	});

	await check("no ok responses -> undefined artifact", () => {
		const responses = [resp("m1", "replicate analyst", "")];
		// empty content filtered out
		eq(normalizeSurface("hypotheses", responses), undefined, "empty content -> undefined");
		const errored = [{ ...resp("m1", "replicate analyst", "x"), status: "error" as const }];
		eq(normalizeSurface("hypotheses", errored), undefined, "errored -> undefined");
	});

	const pass = checks - failures.length;
	process.stdout.write(`\nsuite: normalize · ${pass}/${checks} pass · ${failures.length} fail\n`);
	if (failures.length > 0) {
		process.stdout.write("\nfailures:\n");
		for (const f of failures) process.stdout.write(`- ${f.name}: ${f.error}\n`);
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

main();
