import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Council, PanelMember, PanelMode, ScrutinyConfig, ScrutinyConfigSource, ScrutinyParams, ScrutinySurface, ThinkingLevel, VerifyCheckSpec } from "./types.js";

const DEFAULT_MAX_PANEL_MODELS = 4;
const DEFAULT_PANEL_TIMEOUT_MS = 180_000;
const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const DEFAULT_PANEL_OUTPUT_CHARS = 24_000;
const DEFAULT_JUDGE_OUTPUT_CHARS = 24_000;
const DEFAULT_DIFF_CHARS = 16_000;
const CONFIG_DIR_NAME = ".pi";

const DEFAULT_VERIFY_CHECKS: VerifyCheckSpec[] = [
	{ name: "typecheck", command: "npm", args: ["run", "check"], timeoutMs: 60_000 },
	{ name: "tests", command: "npm", args: ["test"], timeoutMs: 120_000 },
	{ name: "lint", command: "npm", args: ["run", "lint"], timeoutMs: 60_000 },
];

export const SCRUTINY_SURFACES: ScrutinySurface[] = ["consult", "hypotheses", "criteria", "repo-map", "risks", "verify"];

export const SURFACE_DEFAULTS: Record<ScrutinySurface, { panelCount: number; panelMode?: PanelMode; judgeMode: "auto" | "off" | "on"; includeGitDiff: boolean; verify: boolean }> = {
	consult: { panelCount: 2, panelMode: "replicate", judgeMode: "auto", includeGitDiff: false, verify: false },
	hypotheses: { panelCount: 2, panelMode: "replicate", judgeMode: "off", includeGitDiff: true, verify: false },
	criteria: { panelCount: 2, panelMode: "replicate", judgeMode: "off", includeGitDiff: true, verify: false },
	"repo-map": { panelCount: 2, panelMode: "roles", judgeMode: "off", includeGitDiff: true, verify: false },
	risks: { panelCount: 2, panelMode: "roles", judgeMode: "off", includeGitDiff: true, verify: true },
	verify: { panelCount: 0, judgeMode: "off", includeGitDiff: true, verify: true },
};

export type ScrutinyConfigOptions = { cwd?: string; projectTrusted?: boolean };

type ConfigPatch = Partial<Omit<ScrutinyConfig, "configSources">>;

export function userConfigPath(): string {
	return path.join(getAgentDir(), "scrutiny.json");
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "scrutiny.json");
}

export function exampleConfigJson(): string {
	return `${JSON.stringify(
		{
			panel: [
				{ model: "openai-codex/gpt-5.4-mini", thinking: "low" },
				{ model: "opencode-go/kimi-k2.7-code", thinking: "off" },
			],
			judge: "openai-codex/gpt-5.4-mini",
			maxPanelModels: 4,
			includeGitDiff: true,
			verifyChecks: [{ name: "typecheck", command: "npm", args: ["run", "check"], timeoutMs: 60000 }],
			panels: {
				"code-duo": {
					surface: "risks",
					members: [
						{ model: "openai-codex/gpt-5.4-mini", lens: "concurrency", thinking: "low" },
						{ model: "opencode-go/kimi-k2.7-code", lens: "reactive-chain", thinking: "off" },
					],
					verify: true,
					judgeMode: "off",
				},
			},
		},
		null,
		2,
	)}\n`;
}

export function readScrutinyConfig(options: ScrutinyConfigOptions = {}): ScrutinyConfig {
	let config = baseConfig();
	const configSources: ScrutinyConfigSource[] = [];

	for (const source of configFileSources(options)) {
		if (source.status === "skipped" || source.status === "missing") {
			configSources.push(source);
			continue;
		}
		try {
			const raw = fs.readFileSync(source.path!, "utf8");
			const patch = parseConfigObject(JSON.parse(raw));
			config = mergeConfig(config, patch);
			configSources.push({ ...source, status: "loaded" });
		} catch (error) {
			configSources.push({ ...source, status: "error", reason: error instanceof Error ? error.message : String(error) });
		}
	}

	const envPatch = readEnvPatch();
	if (Object.keys(envPatch).length > 0) {
		config = mergeConfig(config, envPatch);
		configSources.push({ scope: "env", status: "loaded", reason: "PI_SCRUTINY_*" });
	}

	return { ...config, configSources };
}

export function readEnvConfig(): ScrutinyConfig {
	const envPatch = readEnvPatch();
	const config = mergeConfig(baseConfig(), envPatch);
	const configSources: ScrutinyConfigSource[] = Object.keys(envPatch).length > 0 ? [{ scope: "env", status: "loaded", reason: "PI_SCRUTINY_*" }] : [];
	return { ...config, configSources };
}

export function resolvePanel(input: { panel?: string[]; panelMembers?: PanelMember[]; maxPanelModels?: number }, config: ScrutinyConfig): PanelMember[] {
	const members = input.panelMembers?.length ? input.panelMembers : input.panel?.length ? input.panel.map((model) => ({ model })) : config.panel;
	const unique = new Map<string, PanelMember>();
	for (const member of members) {
		const model = member.model.trim();
		if (model) unique.set(model, { ...member, model });
	}
	return [...unique.values()].slice(0, input.maxPanelModels ?? config.maxPanelModels);
}

export function resolveJudge(input: { judge?: string }, config: ScrutinyConfig, panel: PanelMember[]): string | undefined {
	return input.judge?.trim() || config.judge || panel[0]?.model;
}

export function resolveTools(input: { tools?: string[] }, config: ScrutinyConfig): string[] {
	return (input.tools && input.tools.length > 0 ? input.tools : config.tools).map((tool) => tool.trim()).filter(Boolean);
}

export function loadCouncils(options: ScrutinyConfigOptions = {}): Council[] {
	return readScrutinyConfig(options).councils;
}

export function findCouncil(name: string, options: ScrutinyConfigOptions = {}): Council | undefined {
	return loadCouncils(options).find((c) => c.name === name);
}

export function councilToParams(council: Council, prompt: string): ScrutinyParams {
	return {
		prompt,
		surface: council.surface,
		panelMembers: council.panelists,
		judge: council.judge,
		judgeMode: council.judgeMode,
		includeGitDiff: council.includeGitDiff,
		verify: council.verify,
	};
}

function baseConfig(): ScrutinyConfig {
	return {
		panel: [],
		judge: undefined,
		maxPanelModels: DEFAULT_MAX_PANEL_MODELS,
		maxPanelOutputChars: DEFAULT_PANEL_OUTPUT_CHARS,
		maxJudgeOutputChars: DEFAULT_JUDGE_OUTPUT_CHARS,
		panelTimeoutMs: DEFAULT_PANEL_TIMEOUT_MS,
		judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
		verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
		includeGitDiff: true,
		gitDiffCharLimit: DEFAULT_DIFF_CHARS,
		tools: [],
		verifyChecks: DEFAULT_VERIFY_CHECKS,
		councils: [],
		configSources: [],
	};
}

function configFileSources(options: ScrutinyConfigOptions): ScrutinyConfigSource[] {
	const sources: ScrutinyConfigSource[] = [];
	const globalPath = userConfigPath();
	sources.push(fs.existsSync(globalPath) ? { scope: "global", path: globalPath, status: "loaded" } : { scope: "global", path: globalPath, status: "missing" });

	if (options.cwd) {
		const projectPath = projectConfigPath(options.cwd);
		if (!fs.existsSync(projectPath)) sources.push({ scope: "project", path: projectPath, status: "missing" });
		else if (!options.projectTrusted) sources.push({ scope: "project", path: projectPath, status: "skipped", reason: "project not trusted" });
		else sources.push({ scope: "project", path: projectPath, status: "loaded" });
	}
	return sources;
}

function readEnvPatch(): ConfigPatch {
	const patch: ConfigPatch = {};
	if ("PI_SCRUTINY_PANEL" in process.env) patch.panel = parseCsv(process.env.PI_SCRUTINY_PANEL).map((model) => ({ model }));
	if ("PI_SCRUTINY_JUDGE" in process.env) patch.judge = emptyToUndefined(process.env.PI_SCRUTINY_JUDGE);
	if ("PI_SCRUTINY_MAX_PANEL_MODELS" in process.env) patch.maxPanelModels = parseIntEnv("PI_SCRUTINY_MAX_PANEL_MODELS", DEFAULT_MAX_PANEL_MODELS, 1, 8);
	if ("PI_SCRUTINY_MAX_PANEL_OUTPUT_CHARS" in process.env) patch.maxPanelOutputChars = parseIntEnv("PI_SCRUTINY_MAX_PANEL_OUTPUT_CHARS", DEFAULT_PANEL_OUTPUT_CHARS, 2_000, 200_000);
	if ("PI_SCRUTINY_MAX_JUDGE_OUTPUT_CHARS" in process.env) patch.maxJudgeOutputChars = parseIntEnv("PI_SCRUTINY_MAX_JUDGE_OUTPUT_CHARS", DEFAULT_JUDGE_OUTPUT_CHARS, 2_000, 200_000);
	if ("PI_SCRUTINY_PANEL_TIMEOUT_MS" in process.env) patch.panelTimeoutMs = parseIntEnv("PI_SCRUTINY_PANEL_TIMEOUT_MS", DEFAULT_PANEL_TIMEOUT_MS, 5_000, 30 * 60_000);
	if ("PI_SCRUTINY_JUDGE_TIMEOUT_MS" in process.env) patch.judgeTimeoutMs = parseIntEnv("PI_SCRUTINY_JUDGE_TIMEOUT_MS", DEFAULT_JUDGE_TIMEOUT_MS, 5_000, 30 * 60_000);
	if ("PI_SCRUTINY_VERIFY_TIMEOUT_MS" in process.env) patch.verifyTimeoutMs = parseIntEnv("PI_SCRUTINY_VERIFY_TIMEOUT_MS", DEFAULT_VERIFY_TIMEOUT_MS, 5_000, 30 * 60_000);
	if ("PI_SCRUTINY_INCLUDE_GIT_DIFF" in process.env) patch.includeGitDiff = parseBoolEnv("PI_SCRUTINY_INCLUDE_GIT_DIFF", true);
	if ("PI_SCRUTINY_GIT_DIFF_CHARS" in process.env) patch.gitDiffCharLimit = parseIntEnv("PI_SCRUTINY_GIT_DIFF_CHARS", DEFAULT_DIFF_CHARS, 0, 200_000);
	if ("PI_SCRUTINY_TOOLS" in process.env) patch.tools = parseCsv(process.env.PI_SCRUTINY_TOOLS);
	if ("PI_SCRUTINY_VERIFY_CHECKS" in process.env) patch.verifyChecks = parseVerifyChecksJson(process.env.PI_SCRUTINY_VERIFY_CHECKS) ?? DEFAULT_VERIFY_CHECKS;
	if ("PI_SCRUTINY_COUNCILS" in process.env) patch.councils = parseCouncilsJson(process.env.PI_SCRUTINY_COUNCILS) ?? [];
	if ("PI_SCRUTINY_PANELS" in process.env) patch.councils = parseCouncilsJson(process.env.PI_SCRUTINY_PANELS) ?? [];
	return patch;
}

function parseConfigObject(value: unknown): ConfigPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const patch: ConfigPatch = {};
	const panel = parsePanelMembers(input.panel);
	if (panel) patch.panel = panel;
	const judge = parseString(input.judge);
	if (judge !== undefined || "judge" in input) patch.judge = judge;
	const maxPanelModels = parseNumber(input.maxPanelModels, 1, 8);
	if (maxPanelModels !== undefined) patch.maxPanelModels = maxPanelModels;
	const maxPanelOutputChars = parseNumber(input.maxPanelOutputChars, 2_000, 200_000);
	if (maxPanelOutputChars !== undefined) patch.maxPanelOutputChars = maxPanelOutputChars;
	const maxJudgeOutputChars = parseNumber(input.maxJudgeOutputChars, 2_000, 200_000);
	if (maxJudgeOutputChars !== undefined) patch.maxJudgeOutputChars = maxJudgeOutputChars;
	const panelTimeoutMs = parseNumber(input.panelTimeoutMs, 5_000, 30 * 60_000);
	if (panelTimeoutMs !== undefined) patch.panelTimeoutMs = panelTimeoutMs;
	const judgeTimeoutMs = parseNumber(input.judgeTimeoutMs, 5_000, 30 * 60_000);
	if (judgeTimeoutMs !== undefined) patch.judgeTimeoutMs = judgeTimeoutMs;
	const verifyTimeoutMs = parseNumber(input.verifyTimeoutMs, 5_000, 30 * 60_000);
	if (verifyTimeoutMs !== undefined) patch.verifyTimeoutMs = verifyTimeoutMs;
	const includeGitDiff = parseBoolValue(input.includeGitDiff);
	if (includeGitDiff !== undefined) patch.includeGitDiff = includeGitDiff;
	const gitDiffCharLimit = parseNumber(input.gitDiffCharLimit ?? input.gitDiffChars, 0, 200_000);
	if (gitDiffCharLimit !== undefined) patch.gitDiffCharLimit = gitDiffCharLimit;
	const tools = parseStringList(input.tools);
	if (tools) patch.tools = tools;
	const verifyChecks = parseVerifyChecksValue(input.verifyChecks);
	if (verifyChecks) patch.verifyChecks = verifyChecks;
	const councils = parseCouncilsValue(input.panels ?? input.councils);
	if (councils) patch.councils = councils;
	return patch;
}

function mergeConfig(config: ScrutinyConfig, patch: ConfigPatch): ScrutinyConfig {
	const next = { ...config };
	if ("panel" in patch && patch.panel) next.panel = patch.panel;
	if ("judge" in patch) next.judge = patch.judge;
	if ("maxPanelModels" in patch && patch.maxPanelModels !== undefined) next.maxPanelModels = patch.maxPanelModels;
	if ("maxPanelOutputChars" in patch && patch.maxPanelOutputChars !== undefined) next.maxPanelOutputChars = patch.maxPanelOutputChars;
	if ("maxJudgeOutputChars" in patch && patch.maxJudgeOutputChars !== undefined) next.maxJudgeOutputChars = patch.maxJudgeOutputChars;
	if ("panelTimeoutMs" in patch && patch.panelTimeoutMs !== undefined) next.panelTimeoutMs = patch.panelTimeoutMs;
	if ("judgeTimeoutMs" in patch && patch.judgeTimeoutMs !== undefined) next.judgeTimeoutMs = patch.judgeTimeoutMs;
	if ("verifyTimeoutMs" in patch && patch.verifyTimeoutMs !== undefined) next.verifyTimeoutMs = patch.verifyTimeoutMs;
	if ("includeGitDiff" in patch && patch.includeGitDiff !== undefined) next.includeGitDiff = patch.includeGitDiff;
	if ("gitDiffCharLimit" in patch && patch.gitDiffCharLimit !== undefined) next.gitDiffCharLimit = patch.gitDiffCharLimit;
	if ("tools" in patch && patch.tools) next.tools = patch.tools;
	if ("verifyChecks" in patch && patch.verifyChecks) next.verifyChecks = patch.verifyChecks;
	if ("councils" in patch && patch.councils) next.councils = patch.councils;
	return next;
}

function parseCouncilsJson(value: string | undefined): Council[] | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return [];
	try {
		return parseCouncilsValue(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
}

function parseCouncilsValue(value: unknown): Council[] | undefined {
	if (!value) return undefined;
	if (Array.isArray(value)) return value.map((item) => parseCouncil(item)).filter((item): item is Council => Boolean(item));
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.map(([name, item]) => parseCouncil({ ...(item && typeof item === "object" ? (item as Record<string, unknown>) : {}), name }))
			.filter((item): item is Council => Boolean(item));
	}
	return undefined;
}

function parseCouncil(value: unknown): Council | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	const name = parseString(input.name);
	const surface = parseSurface(input.surface) ?? "consult";
	if (!name) return undefined;
	const thinking = parseThinkingLevel(input.thinking);
	const panelists = parsePanelMembers(input.members ?? input.panelists ?? input.panel)
		?.map((member) => ({ ...member, thinking: member.thinking ?? thinking })) ?? [];
	const judge = parseString(input.judge);
	const judgeMode = parseJudgeMode(input.judgeMode ?? input.judgePolicy);
	const includeGitDiff = parseBoolValue(input.includeGitDiff);
	const verify = parseVerifyPolicy(input.verify ?? input.verifyPolicy);
	return { name, surface, panelists, thinking, judge, judgeMode, includeGitDiff, verify };
}

function parsePanelMembers(value: unknown): PanelMember[] | undefined {
	if (typeof value === "string") return parseCsv(value).map((model) => ({ model }));
	if (!Array.isArray(value)) return undefined;
	const members = value
		.map((item) => {
			if (typeof item === "string") return { model: item.trim() };
			if (!item || typeof item !== "object") return undefined;
			const input = item as Record<string, unknown>;
			const model = parseString(input.model);
			if (!model) return undefined;
			const member: PanelMember = { model };
			const lens = parseString(input.lens);
			const thinking = parseThinkingLevel(input.thinking);
			if (lens) member.lens = lens;
			if (thinking) member.thinking = thinking;
			return member;
		})
		.filter((item): item is PanelMember => Boolean(item));
	return members.length ? members : undefined;
}

function parseVerifyChecksJson(value: string | undefined): VerifyCheckSpec[] | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	try {
		return parseVerifyChecksValue(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
}

function parseVerifyChecksValue(value: unknown): VerifyCheckSpec[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const checks = value
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const input = item as Record<string, unknown>;
			const name = parseString(input.name);
			const command = parseString(input.command);
			if (!name || !command) return undefined;
			const args = parseStringList(input.args);
			const timeoutMs = parseNumber(input.timeoutMs, 1_000, 30 * 60_000);
			const check: VerifyCheckSpec = { name, command };
			if (args) check.args = args;
			if (timeoutMs !== undefined) check.timeoutMs = timeoutMs;
			return check;
		})
		.filter((item): item is VerifyCheckSpec => Boolean(item));
	return checks.length ? checks : undefined;
}

function parseCsv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function parseStringList(value: unknown): string[] | undefined {
	if (typeof value === "string") return parseCsv(value);
	if (!Array.isArray(value)) return undefined;
	return value.map(String).map((part) => part.trim()).filter(Boolean);
}

function parseString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parseBoolValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
	return parseBoolValue(process.env[name]) ?? fallback;
}

function parseNumber(value: unknown, min: number, max: number): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
	if (!Number.isFinite(n)) return undefined;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
	return parseNumber(process.env[name], min, max) ?? fallback;
}

function parseSurface(value: unknown): ScrutinySurface | undefined {
	const surface = parseString(value) as ScrutinySurface | undefined;
	return surface && SCRUTINY_SURFACES.includes(surface) ? surface : undefined;
}

function parseJudgeMode(value: unknown): Council["judgeMode"] | undefined {
	const mode = parseString(value);
	if (mode === "auto" || mode === "off" || mode === "on") return mode;
	return undefined;
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const level = parseString(value);
	if (level === "off" || level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh") return level;
	return undefined;
}

function parseVerifyPolicy(value: unknown): boolean | undefined {
	const bool = parseBoolValue(value);
	if (bool !== undefined) return bool;
	const policy = parseString(value);
	if (policy === "on") return true;
	if (policy === "off") return false;
	return undefined;
}
