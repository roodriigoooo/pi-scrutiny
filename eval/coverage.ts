import fs from "node:fs";
import path from "node:path";
import {
	DELIBERATION_SURFACES,
	SCRUTINY_SURFACES,
	SCRUTINY_SURFACE_SET,
	SURFACE_ACTION_LINES,
	SURFACE_DEFAULTS,
	SURFACE_DOCS,
	SURFACE_HINTS,
	SURFACE_LENSES,
	SURFACE_PROMPT_SPECS,
	inferSurface,
	panelModeBriefLine,
	surfaceModeLine,
} from "../extensions/scrutiny/surfaces.ts";
import type { ScrutinySurface } from "../extensions/scrutiny/types.ts";

/**
 * Coverage test (issue #3): treats `SCRUTINY_SURFACES` as the source of truth
 * and checks every surface is wired everywhere it should be — defaults, prompt
 * specs, lenses, palette hints, action lines, docs, mode lines, and routing.
 * Also scans extension sources to catch anyone re-introducing a per-surface
 * table outside the catalog.
 *
 * Run: `npm run eval:coverage`. No model keys, no subprocess spawning.
 */

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

const deliberation = SCRUTINY_SURFACES.filter((s) => s !== "verify") as Exclude<ScrutinySurface, "verify">[];

const CHECKS: Check[] = [
	{
		name: "SCRUTINY_SURFACES is the six surfaces, no duplicates",
		run: () => {
			eq(SCRUTINY_SURFACES, ["consult", "hypotheses", "criteria", "repo-map", "risks", "verify"], "surface list");
			eq(new Set(SCRUTINY_SURFACES).size, SCRUTINY_SURFACES.length, "no duplicates");
		},
	},
	{
		name: "SCRUTINY_SURFACE_SET and DELIBERATION_SURFACES derive from the list",
		run: () => {
			eq([...SCRUTINY_SURFACE_SET].sort(), [...SCRUTINY_SURFACES].sort(), "surface set");
			eq(DELIBERATION_SURFACES, deliberation, "deliberation surfaces exclude verify");
		},
	},
	{
		name: "every surface has complete defaults",
		run: () => {
			for (const surface of SCRUTINY_SURFACES) {
				const d = SURFACE_DEFAULTS[surface];
				assert(d != null, `${surface}: missing defaults`);
				assert(typeof d.panelCount === "number", `${surface}: panelCount missing`);
				assert(d.judgeMode === "auto" || d.judgeMode === "off" || d.judgeMode === "on", `${surface}: judgeMode invalid`);
				assert(typeof d.includeGitDiff === "boolean", `${surface}: includeGitDiff missing`);
				assert(typeof d.verify === "boolean", `${surface}: verify missing`);
			}
			eq(SURFACE_DEFAULTS.verify.panelCount, 0, "verify has no panel");
			assert(SURFACE_DEFAULTS.verify.panelMode === undefined, "verify has no panelMode");
		},
	},
	{
		name: "every deliberation surface has a panelMode",
		run: () => {
			for (const surface of deliberation) {
				const mode = SURFACE_DEFAULTS[surface].panelMode;
				assert(mode === "replicate" || mode === "roles", `${surface}: panelMode must be replicate|roles`);
			}
		},
	},
	{
		name: "every deliberation surface has a prompt spec with headings + trailer",
		run: () => {
			for (const surface of deliberation) {
				const spec = SURFACE_PROMPT_SPECS[surface];
				assert(spec != null, `${surface}: missing prompt spec`);
				assert(typeof spec.heading === "string" && spec.heading.length > 0, `${surface}: heading empty`);
				assert(Array.isArray(spec.panelHeadings) && spec.panelHeadings.length > 0, `${surface}: panelHeadings empty`);
				for (const h of spec.panelHeadings) assert(/^##\s+/.test(h), `${surface}: heading "${h}" not a ## heading`);
				assert(Array.isArray(spec.trailer), `${surface}: trailer missing`);
			}
		},
	},
	{
		name: "every deliberation surface has non-empty lenses",
		run: () => {
			for (const surface of deliberation) {
				const lenses = SURFACE_LENSES[surface];
				assert(Array.isArray(lenses) && lenses.length > 0, `${surface}: lenses empty`);
			}
		},
	},
	{
		name: "every surface has palette hint (produces + flow) and action line and docs",
		run: () => {
			for (const surface of SCRUTINY_SURFACES) {
				const hint = SURFACE_HINTS[surface];
				assert(Boolean(hint && hint.produces && hint.flow), `${surface}: palette hint incomplete`);
				assert(typeof SURFACE_ACTION_LINES[surface] === "string" && SURFACE_ACTION_LINES[surface].length > 0, `${surface}: action line missing`);
				const doc = SURFACE_DOCS[surface];
				assert(Boolean(doc && doc.mode && doc.description), `${surface}: docs incomplete`);
			}
		},
	},
	{
		name: "no catalog table has keys outside SCRUTINY_SURFACES",
		run: () => {
			const tables: Array<[string, Record<string, unknown>]> = [
				["SURFACE_DEFAULTS", SURFACE_DEFAULTS as unknown as Record<string, unknown>],
				["SURFACE_HINTS", SURFACE_HINTS as unknown as Record<string, unknown>],
				["SURFACE_ACTION_LINES", SURFACE_ACTION_LINES as unknown as Record<string, unknown>],
				["SURFACE_DOCS", SURFACE_DOCS as unknown as Record<string, unknown>],
				["SURFACE_PROMPT_SPECS", SURFACE_PROMPT_SPECS as unknown as Record<string, unknown>],
				["SURFACE_LENSES", SURFACE_LENSES as unknown as Record<string, unknown>],
			];
			for (const [label, table] of tables) {
				for (const key of Object.keys(table)) {
					assert(SCRUTINY_SURFACE_SET.has(key as ScrutinySurface), `${label}: unknown surface key "${key}"`);
				}
			}
		},
	},
	{
		name: "mode lines return non-empty for every surface",
		run: () => {
			for (const surface of SCRUTINY_SURFACES) {
				assert(surfaceModeLine(surface).length > 0, `${surface}: surfaceModeLine empty`);
				const mode = SURFACE_DEFAULTS[surface].panelMode ?? "replicate";
				assert(panelModeBriefLine(surface, mode as "replicate" | "roles").length > 0, `${surface}: panelModeBriefLine empty`);
			}
		},
	},
	{
		name: "inferSurface routes coding words to deliberation surfaces, not answer-scrutiny",
		run: () => {
			eq(inferSurface("verify the build passes"), "verify", "verify routing");
			eq(inferSurface("typecheck and linting"), "verify", "verify routing (typecheck/linting)");
			eq(inferSurface("review this patch for race conditions"), "risks", "risks routing");
			eq(inferSurface("security review of this change"), "risks", "risks routing (security)");
			eq(inferSurface("does this retry risk duplicate orders"), "risks", "risks routing (risk word)");
			eq(inferSurface("idempotency check for the consumer"), "risks", "risks routing (idempotency stem)");
			eq(inferSurface("what is causing this intermittent bug"), "hypotheses", "hypotheses routing");
			eq(inferSurface("debugging a flaky test"), "hypotheses", "hypotheses routing (debugging/flaky)");
			eq(inferSurface("acceptance criteria for migrating orders"), "criteria", "criteria routing");
			eq(inferSurface("edge cases and backward-compat concerns"), "criteria", "criteria routing (edge cases)");
			eq(inferSurface("backward compatibility of this migration"), "criteria", "criteria routing (migration stem)");
			eq(inferSurface("where is the call path to OrderConsumer"), "repo-map", "repo-map routing");
			eq(inferSurface("repo map of the kafka consumer"), "repo-map", "repo-map routing (repo map)");
			eq(inferSurface("compare these two implementation plans"), "consult", "consult default");
		},
	},
	{
		name: "no extension re-declares catalog-owned surface tables or routing",
		run: () => {
			const extDir = path.resolve(process.cwd(), "extensions", "scrutiny");
			const files = fs.readdirSync(extDir).filter((f) => f.endsWith(".ts") && f !== "surfaces.ts");
			const banned = [
				"const SCRUTINY_SURFACES",
				"const SCRUTINY_SURFACE_SET",
				"const SURFACE_DEFAULTS",
				"const SURFACE_PROMPT_SPECS",
				"const SURFACE_SPECS",
				"const SURFACE_LENSES",
				"const SURFACE_HINTS",
				"const SURFACE_ACTION_LINES",
				"const SURFACE_DOCS",
				"function inferSurface",
				"function inferPaletteSurface",
				"function surfaceActionLine",
				"function panelModeBriefLine",
				"function surfaceModeLine",
			];
			for (const file of files) {
				const src = fs.readFileSync(path.join(extDir, file), "utf8");
				for (const pattern of banned) {
					assert(!src.includes(pattern), `${file}: re-declares "${pattern}" (must live in surfaces.ts)`);
				}
			}
		},
	},
	{
		name: "entrypoint derives its surface enum and set from the catalog",
		run: () => {
			const entry = fs.readFileSync(path.resolve(process.cwd(), "extensions", "scrutiny.ts"), "utf8");
			assert(!/StringEnum\(\[\s*"consult"/.test(entry), "entrypoint hardcodes SurfaceEnum literals — derive from SCRUTINY_SURFACES");
			assert(!/new Set<ScrutinySurface>\(\[\s*"consult"/.test(entry), "entrypoint hardcodes SCRUTINY_SURFACE_SET — import from catalog");
			assert(entry.includes("SCRUTINY_SURFACES"), "entrypoint does not reference SCRUTINY_SURFACES");
		},
	},
];

async function main(): Promise<void> {
	process.stdout.write(`scrutiny coverage · ${CHECKS.length} checks\n`);
	for (const c of CHECKS) check(c.name, c.run);
	const pass = checks - failures.length;
	process.stdout.write(`\nsuite: coverage · ${pass}/${checks} pass · ${failures.length} fail\n`);
	if (failures.length > 0) {
		process.stdout.write("\nfailures:\n");
		for (const f of failures) process.stdout.write(`- ${f.name}: ${f.error}\n`);
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

main();
