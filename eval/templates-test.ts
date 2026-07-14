import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeterministicAnalysis } from "../extensions/scrutiny/analysis.ts";
import { parseConfigPatch } from "../extensions/scrutiny/config.ts";
import { runScrutiny } from "../extensions/scrutiny/engine.ts";
import { panelPrompt } from "../extensions/scrutiny/packet.ts";
import { allTemplates, builtInTemplates, resolveRunPlan } from "../extensions/scrutiny/templates.ts";
import type { PanelResponse, ScrutinyConfig, ScrutinyTemplate } from "../extensions/scrutiny/types.ts";

const failures: Array<{ name: string; error: string }> = [];
let checks = 0;

function check(name: string, run: () => void | Promise<void>): Promise<void> | void {
	checks += 1;
	try {
		const result = run();
		if (result instanceof Promise) {
			return result.then(() => {
				process.stdout.write(`  ✓ ${name}\n`);
			}).catch((error) => {
				failures.push({ name, error: error instanceof Error ? error.message : String(error) });
				process.stdout.write(`  ✕ ${name}\n`);
			});
		}
		process.stdout.write(`  ✓ ${name}\n`);
	} catch (error) {
		failures.push({ name, error: error instanceof Error ? error.message : String(error) });
		process.stdout.write(`  ✕ ${name}\n`);
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function throws(run: () => unknown, pattern: RegExp): void {
	try {
		run();
	} catch (error) {
		assert(pattern.test(error instanceof Error ? error.message : String(error)), `expected ${pattern}, got ${String(error)}`);
		return;
	}
	throw new Error(`expected ${pattern} to throw`);
}

function makeConfig(input: Partial<Pick<ScrutinyConfig, "defaultPanel" | "panels" | "templates">> = {}): ScrutinyConfig {
	return {
		schemaVersion: 2,
		defaultPanel: input.defaultPanel,
		panels: input.panels ?? [],
		templates: input.templates ?? [],
		judge: "judge/model",
		maxPanelModels: 4,
		maxPanelOutputChars: 24_000,
		maxJudgeOutputChars: 24_000,
		panelTimeoutMs: 180_000,
		judgeTimeoutMs: 60_000,
		verifyTimeoutMs: 120_000,
		includeGitDiff: true,
		gitDiffCharLimit: 16_000,
		tools: [],
		verifyChecks: [],
		configSources: [],
		diagnostics: [],
		configurationErrors: [],
	};
}

function roleTemplate(name = "release-risk"): ScrutinyTemplate {
	return {
		name,
		surface: "risks",
		strategy: "roles",
		lenses: ["api compatibility", "failure semantics", "retry behavior"],
		judgeMode: "off",
		verify: true,
	};
}

function response(model: string, role: string, content: string): PanelResponse {
	return {
		model,
		role,
		status: "ok",
		content,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
		durationMs: 1,
		exitCode: 0,
	};
}

async function main(): Promise<void> {
	process.stdout.write("scrutiny templates · 10 checks\n");

	await check("v2 panels and templates parse with named policy ownership", () => {
		const patch = parseConfigPatch({
			schemaVersion: 2,
			defaultPanel: "balanced",
			panels: { balanced: { members: [{ model: "a/model", thinking: "low" }, { model: "b/model", thinking: "off" }] } },
			templates: { "release-risk": { surface: "risks", strategy: "roles", panel: "balanced", lenses: ["api compatibility", "failure semantics"], includeGitDiff: true, judgeMode: "off", verify: true } },
		}, "fixture");
		assert(patch.panels?.[0]?.members[0]?.model === "a/model", "panel model parsed");
		const template = patch.templates?.[0];
		assert(template?.surface === "risks", "template surface parsed");
		assert(template.strategy === "roles", "strategy parsed");
		assert(template.panel === "balanced", "template panel parsed");
	});

	await check("built-ins validate as ordinary templates", () => {
		const templates = builtInTemplates();
		assert(templates.length === 6, "six built-ins");
		assert(allTemplates(makeConfig()).map((template) => template.name).join(",") === templates.map((template) => template.name).join(","), "same runtime templates");
	});

	await check("two templates reuse one panel and a template accepts an alternate panel", () => {
		const config = makeConfig({
			defaultPanel: "balanced",
			panels: [
				{ name: "balanced", members: [{ model: "a/model" }, { model: "b/model" }] },
				{ name: "alternate", members: [{ model: "c/model" }, { model: "d/model" }] },
			],
			templates: [
				{ name: "release-risk", surface: "risks", strategy: "roles", lenses: ["api", "failure"], panel: "balanced" },
				{ name: "release-map", surface: "repo-map", strategy: "roles", lenses: ["call path", "tests"], panel: "balanced" },
			],
		});
		assert(resolveRunPlan({ templateName: "release-risk" }, config).panel?.name === "balanced", "template panel selected");
		assert(resolveRunPlan({ templateName: "release-map" }, config).panel?.name === "balanced", "shared panel selected");
		assert(resolveRunPlan({ templateName: "release-risk", panelName: "alternate" }, config).panel?.name === "alternate", "explicit panel wins");
	});

	await check("legacy bundled config migrates its effective roles behavior without rewriting", () => {
		const patch = parseConfigPatch({
			panel: [{ model: "a/model", thinking: "low" }, { model: "b/model", thinking: "off" }],
			panels: {
				"old-risk": {
					surface: "risks",
					members: [{ model: "a/model", lens: "api compatibility" }, { model: "b/model" }],
					judgeMode: "off",
					verify: true,
				},
			},
		}, "legacy");
		assert(patch.defaultPanel === "default", "top-level panel becomes default");
		assert(patch.panels?.some((panel) => panel.name === "old-risk" && !("lens" in panel.members[0]!)), "migrated panel has no lens");
		const template = patch.templates?.find((item) => item.name === "old-risk");
		assert(template?.surface === "risks" && template.strategy === "roles", "roles template migrated");
		assert(template?.lenses?.[0] === "api compatibility" && template?.lenses?.[1] === "reactive-chain reviewer", "effective fallback lenses preserved");
		assert(Boolean(patch.diagnostics?.[0]?.includes("schemaVersion: 2")), "migration diagnostic supplied");
	});

	await check("invalid template combinations have path-aware failures", () => {
		throws(() => parseConfigPatch({ schemaVersion: 2, templates: { invalid: { surface: "consult", strategy: "replicate", lenses: [] } } }, "fixture"), /fixture\.templates\.invalid\.lenses/);
		throws(() => parseConfigPatch({ schemaVersion: 2, templates: { invalid: { surface: "risks", strategy: "roles" } } }, "fixture"), /fixture\.templates\.invalid\.lenses/);
		throws(() => parseConfigPatch({ schemaVersion: 2, templates: { invalid: { surface: "verify", strategy: "replicate" } } }, "fixture"), /fixture\.templates\.invalid\.strategy/);
		throws(() => parseConfigPatch({ schemaVersion: 2, panels: { invalid: { members: [{ model: "a/model", lens: "wrong place" }] } } }, "fixture"), /fixture\.panels\.invalid\.members\[0\]\.lens/);
	});

	await check("roles member overflow rejects before packet construction", () => {
		const config = makeConfig({
			defaultPanel: "too-many",
			panels: [{ name: "too-many", members: [{ model: "a/model" }, { model: "b/model" }] }],
			templates: [{ name: "roles", surface: "risks", strategy: "roles", lenses: ["only one"] }],
		});
		throws(() => resolveRunPlan({ templateName: "roles" }, config), /cannot exceed their lenses/);
	});

	await check("roles plans preserve unassigned lenses explicitly", () => {
		const config = makeConfig({
			defaultPanel: "one",
			panels: [{ name: "one", members: [{ model: "a/model" }] }],
			templates: [roleTemplate()],
		});
		const plan = resolveRunPlan({ templateName: "release-risk" }, config);
		assert(plan.strategy === "roles", "roles strategy");
		assert(plan.assignments[0]?.lens === "api compatibility", "ordered prefix assignment");
		assert(plan.unassignedLenses.join(",") === "failure semantics,retry behavior", "unassigned lenses exposed");
	});

	await check("replicate prompts are byte-identical and role prompts preserve assigned lenses", () => {
		const packet = "# packet\n";
		const replicateA = panelPrompt({ packet, surface: "consult", strategy: "replicate" });
		const replicateB = panelPrompt({ packet, surface: "consult", strategy: "replicate" });
		assert(replicateA === replicateB, "replicate prompts differ");
		const role = panelPrompt({ packet, surface: "risks", strategy: "roles", lens: "failure semantics" });
		assert(role.includes("Assigned lens: failure semantics."), "role lens changed");
	});

	await check("roles analysis reports coverage gaps without contradiction or disagreement", () => {
		const analysis = buildDeterministicAnalysis({
			strategy: "roles",
			declaredLenses: ["api", "failure"],
			unassignedLenses: ["failure"],
			responses: [
				response("a/model", "api", "The public API should not change because compatibility remains required."),
				response("b/model", "failure", "The failure semantics should change because retries must stop."),
			],
		});
		assert(analysis.contradictions?.length === 0, "roles emitted contradiction");
		assert(analysis.disagreement_signal === false, "roles emitted disagreement");
		assert(analysis.coverage?.some((item) => item.includes("Unassigned lenses: failure")), "unassigned coverage gap absent");
	});

	await check("invalid config result creates no packet or response artifact", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrutiny-invalid-template-"));
		try {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".pi", "scrutiny.json"), JSON.stringify({
				schemaVersion: 2,
				defaultPanel: "bad",
				panels: { bad: { members: [{ model: "a/model" }] } },
				templates: { bad: { surface: "risks", strategy: "roles" } },
			}));
			const { result } = await runScrutiny({
				params: { prompt: "review", template: "bad" },
				cwd,
				projectTrusted: true,
				exec: async () => ({ code: 0 }),
			});
			assert(result.failure_reason === "invalid_configuration", "invalid config failure missing");
			const run = path.join(cwd, ".pi", "scrutiny", result.runId);
			assert(!fs.existsSync(path.join(run, "packet.md")), "invalid config wrote packet");
			assert(!fs.existsSync(path.join(run, "responses.json")), "invalid config wrote responses");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	const pass = checks - failures.length;
	process.stdout.write(`\nsuite: templates · ${pass}/${checks} pass · ${failures.length} fail\n`);
	if (failures.length) {
		process.stdout.write("\nfailures:\n");
		for (const failure of failures) process.stdout.write(`- ${failure.name}: ${failure.error}\n`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(`suite: templates · fail · ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

