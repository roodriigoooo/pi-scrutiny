import fs from "node:fs";
import path from "node:path";
import {
	DELIBERATION_SURFACES,
	SCRUTINY_SURFACES,
	SCRUTINY_SURFACE_SET,
	SCRUTINY_STOP_STATEMENT,
	SURFACE_DOCS,
	SURFACE_HINTS,
	SURFACE_NEXT_STEP_LINES,
	SURFACE_PROMPT_SPECS,
	inferSurface,
} from "../extensions/scrutiny/surfaces.ts";
import { BUILTIN_TEMPLATE_NAMES, builtInTemplates } from "../extensions/scrutiny/templates.ts";
import type { ScrutinySurface } from "../extensions/scrutiny/types.ts";

type Check = { name: string; run: () => void };
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

const deliberation = SCRUTINY_SURFACES.filter((surface) => surface !== "verify") as Exclude<ScrutinySurface, "verify">[];

const CHECKS: Check[] = [
	{
		name: "surface catalog contains the six known surfaces without duplicates",
		run: () => {
			eq(SCRUTINY_SURFACES, ["consult", "hypotheses", "criteria", "repo-map", "risks", "verify"], "surface list");
			eq(new Set(SCRUTINY_SURFACES).size, SCRUTINY_SURFACES.length, "duplicates");
			eq([...SCRUTINY_SURFACE_SET].sort(), [...SCRUTINY_SURFACES].sort(), "surface set");
			eq(DELIBERATION_SURFACES, deliberation, "deliberation list");
		},
	},
	{
		name: "surface catalog owns prompt shape, hints, docs, and human-choice lines",
		run: () => {
			for (const surface of deliberation) {
				const prompt = SURFACE_PROMPT_SPECS[surface];
				assert(Boolean(prompt.heading && prompt.panelHeadings.length), `${surface}: prompt incomplete`);
				assert(prompt.panelHeadings.every((heading) => /^##\s/.test(heading)), `${surface}: panel headings invalid`);
			}
			for (const surface of SCRUTINY_SURFACES) {
				assert(Boolean(SURFACE_HINTS[surface]?.produces && SURFACE_HINTS[surface]?.flow), `${surface}: hint incomplete`);
				assert(Boolean(SURFACE_DOCS[surface]?.mode && SURFACE_DOCS[surface]?.description), `${surface}: docs incomplete`);
				assert(SURFACE_NEXT_STEP_LINES[surface].startsWith("POSSIBLE NEXT STEP:"), `${surface}: no human-choice footer`);
			}
			assert(SCRUTINY_STOP_STATEMENT.includes("No Pi agent turn or code edit follows automatically"), "stop boundary changed");
		},
	},
	{
		name: "built-in templates use each surface and own all strategies and role lenses",
		run: () => {
			const templates = builtInTemplates();
			eq(templates.map((template) => template.name), [...BUILTIN_TEMPLATE_NAMES], "built-in names");
			for (const template of templates) {
				if (template.surface === "verify") {
					assert(!("strategy" in template), "verify template has strategy");
					continue;
				}
				assert(template.strategy === "replicate" || template.strategy === "roles", `${template.name}: strategy missing`);
				if (template.strategy === "roles") assert(Boolean(template.lenses?.length), `${template.name}: roles lenses missing`);
				if (template.strategy === "replicate") assert(!("lenses" in template), `${template.name}: replicate declares lenses`);
			}
		},
	},
	{
		name: "surface catalog has no execution-policy tables",
		run: () => {
			const source = fs.readFileSync(path.resolve(process.cwd(), "extensions", "scrutiny", "surfaces.ts"), "utf8");
			for (const pattern of ["SURFACE_DEFAULTS", "SURFACE_LENSES", "panelMode", "judgeMode", "includeGitDiff"]) {
				assert(!source.includes(pattern), `surfaces.ts still owns ${pattern}`);
			}
		},
	},
	{
		name: "inferSurface routes coding terms to built-in template surfaces",
		run: () => {
			eq(inferSurface("verify the build passes"), "verify", "verify");
			eq(inferSurface("review this patch for race conditions"), "risks", "risks");
			eq(inferSurface("what is causing this intermittent bug"), "hypotheses", "hypotheses");
			eq(inferSurface("acceptance criteria for migrating orders"), "criteria", "criteria");
			eq(inferSurface("where is the call path to OrderConsumer"), "repo-map", "repo-map");
			eq(inferSurface("compare these two implementation plans"), "consult", "consult");
		},
	},
];

process.stdout.write(`scrutiny coverage · ${CHECKS.length} checks\n`);
for (const item of CHECKS) check(item.name, item.run);
const pass = checks - failures.length;
process.stdout.write(`\nsuite: coverage · ${pass}/${checks} pass · ${failures.length} fail\n`);
if (failures.length) {
	process.stdout.write("\nfailures:\n");
	for (const failure of failures) process.stdout.write(`- ${failure.name}: ${failure.error}\n`);
	process.exit(1);
}
