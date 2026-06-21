import type { Council, ScrutinyConfig, ScrutinyParams, ScrutinySurface, VerifyCheckSpec } from "./types.js";

const DEFAULT_MAX_PANEL_MODELS = 4;
const DEFAULT_PANEL_TIMEOUT_MS = 60_000;
const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const DEFAULT_PANEL_OUTPUT_CHARS = 24_000;
const DEFAULT_JUDGE_OUTPUT_CHARS = 24_000;
const DEFAULT_DIFF_CHARS = 16_000;

const DEFAULT_VERIFY_CHECKS: VerifyCheckSpec[] = [
	{ name: "typecheck", command: "npm", args: ["run", "check"], timeoutMs: 60_000 },
	{ name: "tests", command: "npm", args: ["test"], timeoutMs: 120_000 },
	{ name: "lint", command: "npm", args: ["run", "lint"], timeoutMs: 60_000 },
];

export const SCRUTINY_SURFACES: ScrutinySurface[] = ["consult", "hypotheses", "criteria", "repo-map", "risks", "verify"];

export const SURFACE_DEFAULTS: Record<ScrutinySurface, { panelCount: number; judgeMode: "auto" | "off" | "on"; includeGitDiff: boolean; verify: boolean }> = {
	consult: { panelCount: 2, judgeMode: "auto", includeGitDiff: false, verify: false },
	hypotheses: { panelCount: 2, judgeMode: "off", includeGitDiff: true, verify: false },
	criteria: { panelCount: 2, judgeMode: "off", includeGitDiff: true, verify: false },
	"repo-map": { panelCount: 2, judgeMode: "off", includeGitDiff: true, verify: false },
	risks: { panelCount: 2, judgeMode: "off", includeGitDiff: true, verify: true },
	verify: { panelCount: 0, judgeMode: "off", includeGitDiff: true, verify: true },
};

export function readEnvConfig(): ScrutinyConfig {
	return {
		panel: parseCsv(process.env.PI_SCRUTINY_PANEL),
		judge: emptyToUndefined(process.env.PI_SCRUTINY_JUDGE),
		maxPanelModels: parseIntEnv("PI_SCRUTINY_MAX_PANEL_MODELS", DEFAULT_MAX_PANEL_MODELS, 1, 8),
		maxPanelOutputChars: parseIntEnv("PI_SCRUTINY_MAX_PANEL_OUTPUT_CHARS", DEFAULT_PANEL_OUTPUT_CHARS, 2_000, 200_000),
		maxJudgeOutputChars: parseIntEnv("PI_SCRUTINY_MAX_JUDGE_OUTPUT_CHARS", DEFAULT_JUDGE_OUTPUT_CHARS, 2_000, 200_000),
		panelTimeoutMs: parseIntEnv("PI_SCRUTINY_PANEL_TIMEOUT_MS", DEFAULT_PANEL_TIMEOUT_MS, 5_000, 30 * 60_000),
		judgeTimeoutMs: parseIntEnv("PI_SCRUTINY_JUDGE_TIMEOUT_MS", DEFAULT_JUDGE_TIMEOUT_MS, 5_000, 30 * 60_000),
		verifyTimeoutMs: parseIntEnv("PI_SCRUTINY_VERIFY_TIMEOUT_MS", DEFAULT_VERIFY_TIMEOUT_MS, 5_000, 30 * 60_000),
		includeGitDiff: parseBoolEnv("PI_SCRUTINY_INCLUDE_GIT_DIFF", true),
		gitDiffCharLimit: parseIntEnv("PI_SCRUTINY_GIT_DIFF_CHARS", DEFAULT_DIFF_CHARS, 0, 200_000),
		tools: parseCsv(process.env.PI_SCRUTINY_TOOLS),
		verifyChecks: parseVerifyChecks(process.env.PI_SCRUTINY_VERIFY_CHECKS) ?? DEFAULT_VERIFY_CHECKS,
	};
}

export function resolvePanel(input: { panel?: string[]; maxPanelModels?: number }, config: ScrutinyConfig): string[] {
	const models = (input.panel && input.panel.length > 0 ? input.panel : config.panel)
		.map((model) => model.trim())
		.filter(Boolean);
	const unique = [...new Set(models)];
	return unique.slice(0, input.maxPanelModels ?? config.maxPanelModels);
}

export function resolveJudge(input: { judge?: string }, config: ScrutinyConfig, panel: string[]): string | undefined {
	return input.judge?.trim() || config.judge || panel[0];
}

export function resolveTools(input: { tools?: string[] }, config: ScrutinyConfig): string[] {
	return (input.tools && input.tools.length > 0 ? input.tools : config.tools).map((tool) => tool.trim()).filter(Boolean);
}

export function loadCouncils(): Council[] {
	const raw = process.env.PI_SCRUTINY_COUNCILS?.trim();
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((item) => ({
				name: String(item?.name ?? "").trim(),
				surface: String(item?.surface ?? "consult") as Council["surface"],
				panelists: Array.isArray(item?.panelists)
					? item.panelists.map((p: any) => ({ model: String(p?.model ?? "").trim(), lens: p?.lens ? String(p.lens) : undefined })).filter((p: any) => p.model)
					: [],
				judge: item?.judge ? String(item.judge).trim() || undefined : undefined,
				judgeMode: item?.judgeMode,
				includeGitDiff: item?.includeGitDiff,
				verify: item?.verify,
			}))
			.filter((c) => c.name && c.surface);
	} catch {
		return [];
	}
}

export function findCouncil(name: string): Council | undefined {
	return loadCouncils().find((c) => c.name === name);
}

export function councilToParams(council: Council, prompt: string): ScrutinyParams {
	return {
		prompt,
		surface: council.surface,
		panel: council.panelists.map((p) => p.model),
		judge: council.judge,
		judgeMode: council.judgeMode,
		includeGitDiff: council.includeGitDiff,
		verify: council.verify,
	};
}

function parseCsv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function emptyToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return fallback;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	return fallback;
}

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, value));
}

function parseVerifyChecks(value: string | undefined): VerifyCheckSpec[] | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		if (!Array.isArray(parsed)) return undefined;
		return parsed
			.map((item) => ({
				name: String(item?.name ?? "").trim(),
				command: String(item?.command ?? "").trim(),
				args: Array.isArray(item?.args) ? item.args.map(String) : undefined,
				timeoutMs: typeof item?.timeoutMs === "number" ? item.timeoutMs : undefined,
			}))
			.filter((item) => item.name && item.command);
	} catch {
		return undefined;
	}
}
