import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ConfigurationError,
	isBuiltinTemplateName,
	LEGACY_DEFAULT_PANEL_NAME,
	legacyTemplateForPanel,
	parsePanelDefinition,
	parseTemplateDefinition,
} from "./templates.js";
import type {
	JudgeMode,
	PanelDefinition,
	PanelMember,
	ScrutinyConfig,
	ScrutinyConfigSource,
	ThinkingLevel,
	VerifyCheckSpec,
} from "./types.js";

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

export type ScrutinyConfigOptions = { cwd?: string; projectTrusted?: boolean };

export class PanelNameCollisionError extends ConfigurationError {
	readonly panelName: string;

	constructor(panelName: string) {
		super(`panels.${panelName} already exists in global scrutiny config`);
		this.name = "PanelNameCollisionError";
		this.panelName = panelName;
	}
}

type ConfigPatch = {
	defaultPanel?: string | undefined;
	panels?: PanelDefinition[];
	templates?: ScrutinyConfig["templates"];
	judge?: string | undefined;
	maxPanelModels?: number;
	maxPanelOutputChars?: number;
	maxJudgeOutputChars?: number;
	panelTimeoutMs?: number;
	judgeTimeoutMs?: number;
	verifyTimeoutMs?: number;
	includeGitDiff?: boolean;
	gitDiffCharLimit?: number;
	tools?: string[];
	verifyChecks?: VerifyCheckSpec[];
	diagnostics?: string[];
};

type LegacyPanelMember = PanelMember & { lens?: string };

export function userConfigPath(): string {
	return path.join(getAgentDir(), "scrutiny.json");
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "scrutiny.json");
}

function configDocumentWithPanel(value: unknown, panel: PanelDefinition, overwrite = false, source = "global scrutiny config"): Record<string, unknown> {
	validatePanelForSave(panel, source);
	if (!isRecord(value)) throw new ConfigurationError(`${source} must contain a JSON object`);
	if (value.schemaVersion !== 2) {
		if (Object.keys(value).length > 0) throw new ConfigurationError(`${source} uses legacy configuration. Migrate it with /scrutiny config edit before adding panels through setup.`);
	} else {
		parseConfigPatch(value, source);
	}
	const panels = value.schemaVersion === 2 && isRecord(value.panels) ? value.panels : {};
	if (Object.hasOwn(panels, panel.name) && !overwrite) throw new PanelNameCollisionError(panel.name);
	return {
		...value,
		schemaVersion: 2,
		defaultPanel: typeof value.defaultPanel === "string" && value.defaultPanel.trim() ? value.defaultPanel : panel.name,
		panels: {
			...panels,
			[panel.name]: {
				members: panel.members.map((member) => ({
					model: member.model,
					...(member.thinking === undefined ? {} : { thinking: member.thinking }),
				})),
			},
		},
	};
}

export async function saveUserPanel(panel: PanelDefinition, options: { overwrite?: boolean } = {}): Promise<string> {
	const file = userConfigPath();
	let document: unknown = {};
	try {
		document = JSON.parse(await fs.promises.readFile(file, "utf8"));
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw new ConfigurationError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const next = configDocumentWithPanel(document, panel, options.overwrite, file);
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.promises.rename(temporary, file);
	} finally {
		await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
	}
	return file;
}

export function exampleConfigJson(): string {
	return `${JSON.stringify(
		{
			schemaVersion: 2,
			defaultPanel: "balanced",
			panels: {
				balanced: {
					members: [
						{ model: "openai-codex/gpt-5.4-mini", thinking: "low" },
						{ model: "opencode-go/kimi-k2.7-code", thinking: "off" },
					],
				},
			},
			templates: {
				"release-risk": {
					surface: "risks",
					strategy: "roles",
					panel: "balanced",
					lenses: ["api compatibility", "failure semantics"],
					includeGitDiff: true,
					judgeMode: "off",
					verify: true,
				},
			},
			judge: "openai-codex/gpt-5.4-mini",
			verifyChecks: [{ name: "typecheck", command: "npm", args: ["run", "check"], timeoutMs: 60000 }],
		},
		null,
		2,
	)}\n`;
}

export function readScrutinyConfig(options: ScrutinyConfigOptions = {}): ScrutinyConfig {
	let config = baseConfig();
	const configSources: ScrutinyConfigSource[] = [];
	const diagnostics: string[] = [];
	const configurationErrors: string[] = [];

	for (const source of configFileSources(options)) {
		if (source.status === "skipped" || source.status === "missing") {
			configSources.push(source);
			continue;
		}
		try {
			const raw = fs.readFileSync(source.path!, "utf8");
			const patch = parseConfigPatch(JSON.parse(raw), source.path!);
			config = mergeConfig(config, patch);
			diagnostics.push(...(patch.diagnostics ?? []));
			configSources.push({ ...source, status: "loaded" });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			configSources.push({ ...source, status: "error", reason });
			configurationErrors.push(`${source.path}: ${reason}`);
		}
	}

	try {
		const envPatch = readEnvPatch();
		if (Object.keys(envPatch).length > 0) {
			config = mergeConfig(config, envPatch);
			diagnostics.push(...(envPatch.diagnostics ?? []));
			configSources.push({ scope: "env", status: "loaded", reason: "PI_SCRUTINY_*" });
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		configSources.push({ scope: "env", status: "error", reason });
			configurationErrors.push(`environment: ${reason}`);
	}

	return { ...config, configSources, diagnostics, configurationErrors };
}

export function readEnvConfig(): ScrutinyConfig {
	let config = baseConfig();
	const diagnostics: string[] = [];
	try {
		const envPatch = readEnvPatch();
		config = mergeConfig(config, envPatch);
		diagnostics.push(...(envPatch.diagnostics ?? []));
		return {
			...config,
			configSources: Object.keys(envPatch).length > 0 ? [{ scope: "env", status: "loaded", reason: "PI_SCRUTINY_*" }] : [],
			diagnostics,
			configurationErrors: [],
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ...config, configSources: [{ scope: "env", status: "error", reason }], diagnostics, configurationErrors: [`environment: ${reason}`] };
	}
}

export function resolveJudge(input: { judge?: string }, config: ScrutinyConfig, panel?: PanelDefinition): string | undefined {
	return input.judge?.trim() || config.judge || panel?.members[0]?.model;
}

export function resolveTools(input: { tools?: string[] }, config: ScrutinyConfig): string[] {
	return (input.tools && input.tools.length > 0 ? input.tools : config.tools).map((tool) => tool.trim()).filter(Boolean);
}

export function parseConfigPatch(value: unknown, source = "config"): ConfigPatch {
	if (!isRecord(value)) throw new ConfigurationError(`${source} must contain a JSON object`);
	if (value.schemaVersion === 2) return parseV2Config(value, source);
	if ("schemaVersion" in value) throw new ConfigurationError(`${source}.schemaVersion must be 2`);
	return parseLegacyConfig(value, source);
}

function baseConfig(): ScrutinyConfig {
	return {
		schemaVersion: 2,
		defaultPanel: undefined,
		panels: [],
		templates: [],
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
		configSources: [],
		diagnostics: [],
		configurationErrors: [],
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

function parseV2Config(input: Record<string, unknown>, source: string): ConfigPatch {
	const patch = parseCommonConfig(input, source);
	if ("defaultPanel" in input) patch.defaultPanel = optionalString(input.defaultPanel, `${source}.defaultPanel`);
	if ("panels" in input) patch.panels = parseNamedPanels(input.panels, `${source}.panels`);
	if ("templates" in input) patch.templates = parseNamedTemplates(input.templates, `${source}.templates`);
	return patch;
}

function parseLegacyConfig(input: Record<string, unknown>, source: string): ConfigPatch {
	const patch = parseCommonConfig(input, source);
	const panels: PanelDefinition[] = [];
	const templates: ScrutinyConfig["templates"] = [];
	const topLevel = "panel" in input ? parseLegacyMembers(input.panel, `${source}.panel`) : undefined;
	if (topLevel?.length) {
		panels.push({ name: LEGACY_DEFAULT_PANEL_NAME, members: stripLegacyLenses(topLevel) });
		patch.defaultPanel = LEGACY_DEFAULT_PANEL_NAME;
	}
	if ("panels" in input || "councils" in input) {
		const bundled = parseLegacyBundledPanels(input.panels ?? input.councils, `${source}.${"panels" in input ? "panels" : "councils"}`);
		for (const entry of bundled) {
			if (isBuiltinTemplateName(entry.name)) throw new ConfigurationError(`${source}: legacy saved panel "${entry.name}" conflicts with reserved built-in template name`);
			if (panels.some((panel) => panel.name === entry.name)) throw new ConfigurationError(`${source}: duplicate panel name "${entry.name}"`);
			if (entry.surface !== "verify") panels.push({ name: entry.name, members: stripLegacyLenses(entry.members) });
			templates.push(legacyTemplateForPanel({
				name: entry.name,
				surface: entry.surface,
				members: entry.members,
				panel: entry.name,
				judgeMode: entry.judgeMode,
				includeGitDiff: entry.includeGitDiff,
				verify: entry.verify,
			}));
		}
	}
	if (panels.length) patch.panels = panels;
	if (templates.length) patch.templates = templates;
	if (topLevel || "panels" in input || "councils" in input) {
		patch.diagnostics = [
			`${source}: legacy panel configuration was read without rewriting the file. Migrate to schemaVersion: 2; panels now contain only model/thinking members and templates own strategy, lenses, and policies.`,
			`Example:\n${exampleConfigJson().trim()}`,
		];
	}
	return patch;
}

function parseCommonConfig(input: Record<string, unknown>, source: string): ConfigPatch {
	const patch: ConfigPatch = {};
	if ("judge" in input) patch.judge = optionalString(input.judge, `${source}.judge`);
	if ("maxPanelModels" in input) patch.maxPanelModels = requiredNumber(input.maxPanelModels, `${source}.maxPanelModels`, 1, 8);
	if ("maxPanelOutputChars" in input) patch.maxPanelOutputChars = requiredNumber(input.maxPanelOutputChars, `${source}.maxPanelOutputChars`, 2_000, 200_000);
	if ("maxJudgeOutputChars" in input) patch.maxJudgeOutputChars = requiredNumber(input.maxJudgeOutputChars, `${source}.maxJudgeOutputChars`, 2_000, 200_000);
	if ("panelTimeoutMs" in input) patch.panelTimeoutMs = requiredNumber(input.panelTimeoutMs, `${source}.panelTimeoutMs`, 5_000, 30 * 60_000);
	if ("judgeTimeoutMs" in input) patch.judgeTimeoutMs = requiredNumber(input.judgeTimeoutMs, `${source}.judgeTimeoutMs`, 5_000, 30 * 60_000);
	if ("verifyTimeoutMs" in input) patch.verifyTimeoutMs = requiredNumber(input.verifyTimeoutMs, `${source}.verifyTimeoutMs`, 5_000, 30 * 60_000);
	if ("includeGitDiff" in input) patch.includeGitDiff = requiredBoolean(input.includeGitDiff, `${source}.includeGitDiff`);
	if ("gitDiffCharLimit" in input || "gitDiffChars" in input) patch.gitDiffCharLimit = requiredNumber(input.gitDiffCharLimit ?? input.gitDiffChars, `${source}.gitDiffCharLimit`, 0, 200_000);
	if ("tools" in input) patch.tools = requiredStringList(input.tools, `${source}.tools`);
	if ("verifyChecks" in input) patch.verifyChecks = parseVerifyChecksValue(input.verifyChecks, `${source}.verifyChecks`);
	return patch;
}

function mergeConfig(config: ScrutinyConfig, patch: ConfigPatch): ScrutinyConfig {
	const next = { ...config };
	if ("defaultPanel" in patch) next.defaultPanel = patch.defaultPanel;
	if (patch.panels) next.panels = mergeNamed(config.panels, patch.panels);
	if (patch.templates) next.templates = mergeNamed(config.templates, patch.templates);
	if ("judge" in patch) next.judge = patch.judge;
	if (patch.maxPanelModels !== undefined) next.maxPanelModels = patch.maxPanelModels;
	if (patch.maxPanelOutputChars !== undefined) next.maxPanelOutputChars = patch.maxPanelOutputChars;
	if (patch.maxJudgeOutputChars !== undefined) next.maxJudgeOutputChars = patch.maxJudgeOutputChars;
	if (patch.panelTimeoutMs !== undefined) next.panelTimeoutMs = patch.panelTimeoutMs;
	if (patch.judgeTimeoutMs !== undefined) next.judgeTimeoutMs = patch.judgeTimeoutMs;
	if (patch.verifyTimeoutMs !== undefined) next.verifyTimeoutMs = patch.verifyTimeoutMs;
	if (patch.includeGitDiff !== undefined) next.includeGitDiff = patch.includeGitDiff;
	if (patch.gitDiffCharLimit !== undefined) next.gitDiffCharLimit = patch.gitDiffCharLimit;
	if (patch.tools) next.tools = patch.tools;
	if (patch.verifyChecks) next.verifyChecks = patch.verifyChecks;
	return next;
}

function mergeNamed<T extends { name: string }>(base: T[], overrides: T[]): T[] {
	const values = new Map(base.map((item) => [item.name, item]));
	for (const item of overrides) values.set(item.name, item);
	return [...values.values()];
}

function readEnvPatch(): ConfigPatch {
	const patch: ConfigPatch = {};
	if ("PI_SCRUTINY_PANEL" in process.env) {
		const members = parseLegacyMembers(process.env.PI_SCRUTINY_PANEL ?? "", "PI_SCRUTINY_PANEL");
		if (members.length) {
			patch.panels = [{ name: LEGACY_DEFAULT_PANEL_NAME, members: stripLegacyLenses(members) }];
			patch.defaultPanel = LEGACY_DEFAULT_PANEL_NAME;
		} else {
			patch.defaultPanel = undefined;
		}
	}
	if ("PI_SCRUTINY_DEFAULT_PANEL" in process.env) patch.defaultPanel = optionalString(process.env.PI_SCRUTINY_DEFAULT_PANEL, "PI_SCRUTINY_DEFAULT_PANEL");
	if ("PI_SCRUTINY_JUDGE" in process.env) patch.judge = optionalString(process.env.PI_SCRUTINY_JUDGE, "PI_SCRUTINY_JUDGE");
	if ("PI_SCRUTINY_MAX_PANEL_MODELS" in process.env) patch.maxPanelModels = requiredNumber(process.env.PI_SCRUTINY_MAX_PANEL_MODELS, "PI_SCRUTINY_MAX_PANEL_MODELS", 1, 8);
	if ("PI_SCRUTINY_MAX_PANEL_OUTPUT_CHARS" in process.env) patch.maxPanelOutputChars = requiredNumber(process.env.PI_SCRUTINY_MAX_PANEL_OUTPUT_CHARS, "PI_SCRUTINY_MAX_PANEL_OUTPUT_CHARS", 2_000, 200_000);
	if ("PI_SCRUTINY_MAX_JUDGE_OUTPUT_CHARS" in process.env) patch.maxJudgeOutputChars = requiredNumber(process.env.PI_SCRUTINY_MAX_JUDGE_OUTPUT_CHARS, "PI_SCRUTINY_MAX_JUDGE_OUTPUT_CHARS", 2_000, 200_000);
	if ("PI_SCRUTINY_PANEL_TIMEOUT_MS" in process.env) patch.panelTimeoutMs = requiredNumber(process.env.PI_SCRUTINY_PANEL_TIMEOUT_MS, "PI_SCRUTINY_PANEL_TIMEOUT_MS", 5_000, 30 * 60_000);
	if ("PI_SCRUTINY_JUDGE_TIMEOUT_MS" in process.env) patch.judgeTimeoutMs = requiredNumber(process.env.PI_SCRUTINY_JUDGE_TIMEOUT_MS, "PI_SCRUTINY_JUDGE_TIMEOUT_MS", 5_000, 30 * 60_000);
	if ("PI_SCRUTINY_VERIFY_TIMEOUT_MS" in process.env) patch.verifyTimeoutMs = requiredNumber(process.env.PI_SCRUTINY_VERIFY_TIMEOUT_MS, "PI_SCRUTINY_VERIFY_TIMEOUT_MS", 5_000, 30 * 60_000);
	if ("PI_SCRUTINY_INCLUDE_GIT_DIFF" in process.env) patch.includeGitDiff = requiredBoolean(process.env.PI_SCRUTINY_INCLUDE_GIT_DIFF, "PI_SCRUTINY_INCLUDE_GIT_DIFF");
	if ("PI_SCRUTINY_GIT_DIFF_CHARS" in process.env) patch.gitDiffCharLimit = requiredNumber(process.env.PI_SCRUTINY_GIT_DIFF_CHARS, "PI_SCRUTINY_GIT_DIFF_CHARS", 0, 200_000);
	if ("PI_SCRUTINY_TOOLS" in process.env) patch.tools = parseCsv(process.env.PI_SCRUTINY_TOOLS);
	if ("PI_SCRUTINY_VERIFY_CHECKS" in process.env) patch.verifyChecks = parseEnvJson(process.env.PI_SCRUTINY_VERIFY_CHECKS, "PI_SCRUTINY_VERIFY_CHECKS", (value) => parseVerifyChecksValue(value, "PI_SCRUTINY_VERIFY_CHECKS"));
	if ("PI_SCRUTINY_TEMPLATES" in process.env) patch.templates = parseEnvJson(process.env.PI_SCRUTINY_TEMPLATES, "PI_SCRUTINY_TEMPLATES", (value) => parseNamedTemplates(value, "PI_SCRUTINY_TEMPLATES"));
	if ("PI_SCRUTINY_PANELS" in process.env || "PI_SCRUTINY_COUNCILS" in process.env) {
		const raw = process.env.PI_SCRUTINY_PANELS ?? process.env.PI_SCRUTINY_COUNCILS;
		const legacy = parseEnvJson(raw, "PI_SCRUTINY_PANELS", (value) => parseLegacyConfig({ panels: value }, "PI_SCRUTINY_PANELS"));
		patch.panels = legacy.panels;
		patch.templates = legacy.templates;
		patch.diagnostics = legacy.diagnostics;
	}
	return patch;
}

function parseNamedPanels(value: unknown, at: string): PanelDefinition[] {
	if (!isRecord(value)) throw new ConfigurationError(`${at} must be an object keyed by panel name`);
	return Object.entries(value).map(([name, panel]) => parsePanelDefinition(requiredName(name, at), panel, `${at}.${name}`));
}

function parseNamedTemplates(value: unknown, at: string): ScrutinyConfig["templates"] {
	if (!isRecord(value)) throw new ConfigurationError(`${at} must be an object keyed by template name`);
	return Object.entries(value).map(([name, template]) => {
		const parsedName = requiredName(name, at);
		if (isBuiltinTemplateName(parsedName)) throw new ConfigurationError(`${at}.${parsedName} is reserved for a built-in template`);
		return parseTemplateDefinition(parsedName, template, `${at}.${parsedName}`);
	});
}

function parseLegacyBundledPanels(value: unknown, at: string): Array<{
	name: string;
	surface: ScrutinyConfig["templates"][number]["surface"];
	members: LegacyPanelMember[];
	judgeMode?: JudgeMode;
	includeGitDiff?: boolean;
	verify?: boolean;
}> {
	const entries: Array<readonly [string, Record<string, unknown>]> = Array.isArray(value)
		? value.map((entry, index) => {
			if (!isRecord(entry)) throw new ConfigurationError(`${at}[${index}] must be an object`);
			return [requiredString(entry.name, `${at}[${index}].name`), entry] as const;
		})
		: isRecord(value) ? Object.entries(value).map(([name, entry]) => {
			if (!isRecord(entry)) throw new ConfigurationError(`${at}.${name} must be an object`);
			return [name, entry] as const;
		}) : (() => { throw new ConfigurationError(`${at} must be an array or object`); })();
	const seen = new Set<string>();
	return entries.map(([name, entry]) => {
		const parsedName = requiredName(name, at);
		if (seen.has(parsedName)) throw new ConfigurationError(`${at}: duplicate saved panel "${parsedName}"`);
		seen.add(parsedName);
		const surface = optionalSurface(entry.surface, `${at}.${parsedName}.surface`) ?? "consult";
		const sharedThinking = optionalThinkingLevel(entry.thinking, `${at}.${parsedName}.thinking`);
		const members = parseLegacyMembers(entry.members ?? entry.panelists ?? entry.panel, `${at}.${parsedName}.members`)
			.map((member) => ({ ...member, thinking: member.thinking ?? sharedThinking }));
		if (surface !== "verify" && members.length === 0) throw new ConfigurationError(`${at}.${parsedName}.members must contain at least one member`);
		return {
			name: parsedName,
			surface,
			members,
			judgeMode: optionalJudgeMode(entry.judgeMode ?? entry.judgePolicy, `${at}.${parsedName}.judgeMode`),
			includeGitDiff: optionalBoolean(entry.includeGitDiff, `${at}.${parsedName}.includeGitDiff`),
			verify: optionalVerifyPolicy(entry.verify ?? entry.verifyPolicy, `${at}.${parsedName}.verify`),
		};
	});
}

function parseLegacyMembers(value: unknown, at: string): LegacyPanelMember[] {
	if (typeof value === "string") return parseCsv(value).map((model) => ({ model }));
	if (!Array.isArray(value)) throw new ConfigurationError(`${at} must be a comma-separated model list or member array`);
	return value.map((member, index) => {
		if (typeof member === "string") return { model: requiredString(member, `${at}[${index}]`) };
		if (!isRecord(member)) throw new ConfigurationError(`${at}[${index}] must be a model string or object`);
		const model = requiredString(member.model, `${at}[${index}].model`);
		const lens = optionalString(member.lens, `${at}[${index}].lens`);
		const thinking = optionalThinkingLevel(member.thinking, `${at}[${index}].thinking`);
		return { model, ...(lens === undefined ? {} : { lens }), ...(thinking === undefined ? {} : { thinking }) };
	});
}

function stripLegacyLenses(members: LegacyPanelMember[]): PanelMember[] {
	return members.map(({ model, thinking }) => ({ model, ...(thinking === undefined ? {} : { thinking }) }));
}

function parseVerifyChecksValue(value: unknown, at: string): VerifyCheckSpec[] {
	if (!Array.isArray(value)) throw new ConfigurationError(`${at} must be an array`);
	return value.map((item, index) => {
		if (!isRecord(item)) throw new ConfigurationError(`${at}[${index}] must be an object`);
		const name = requiredString(item.name, `${at}[${index}].name`);
		const command = requiredString(item.command, `${at}[${index}].command`);
		const args = item.args === undefined ? undefined : requiredStringList(item.args, `${at}[${index}].args`);
		const timeoutMs = item.timeoutMs === undefined ? undefined : requiredNumber(item.timeoutMs, `${at}[${index}].timeoutMs`, 1_000, 30 * 60_000);
		return { name, command, ...(args === undefined ? {} : { args }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
	});
}

function parseEnvJson<T>(raw: string | undefined, at: string, parse: (value: unknown) => T): T {
	if (!raw?.trim()) throw new ConfigurationError(`${at} must contain JSON`);
	try {
		return parse(JSON.parse(raw));
	} catch (error) {
		if (error instanceof ConfigurationError) throw error;
		throw new ConfigurationError(`${at} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseCsv(value: string | undefined): string[] {
	return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function requiredStringList(value: unknown, at: string): string[] {
	if (typeof value === "string") return parseCsv(value);
	if (!Array.isArray(value)) throw new ConfigurationError(`${at} must be a string or array of strings`);
	return value.map((item, index) => requiredString(item, `${at}[${index}]`));
}

function requiredName(value: string, at: string): string {
	const name = value.trim();
	if (!name) throw new ConfigurationError(`${at} has an empty name`);
	return name;
}

function requiredString(value: unknown, at: string): string {
	const parsed = optionalString(value, at);
	if (!parsed) throw new ConfigurationError(`${at} must be a non-empty string`);
	return parsed;
}

function optionalString(value: unknown, at: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !value.trim()) throw new ConfigurationError(`${at} must be a non-empty string`);
	return value.trim();
}

function requiredBoolean(value: unknown, at: string): boolean {
	const parsed = optionalBoolean(value, at);
	if (parsed === undefined) throw new ConfigurationError(`${at} must be a boolean`);
	return parsed;
}

function optionalBoolean(value: unknown, at: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
		if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
	}
	throw new ConfigurationError(`${at} must be a boolean`);
}

function optionalVerifyPolicy(value: unknown, at: string): boolean | undefined {
	if (value === "on") return true;
	if (value === "off") return false;
	return optionalBoolean(value, at);
}

function requiredNumber(value: unknown, at: string, min: number, max: number): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(number)) throw new ConfigurationError(`${at} must be a number`);
	if (number < min || number > max) throw new ConfigurationError(`${at} must be between ${min} and ${max}`);
	return Math.floor(number);
}

function optionalSurface(value: unknown, at: string): ScrutinyConfig["templates"][number]["surface"] | undefined {
	const parsed = optionalString(value, at);
	if (!parsed) return undefined;
	if (parsed === "consult" || parsed === "hypotheses" || parsed === "criteria" || parsed === "repo-map" || parsed === "risks" || parsed === "verify") return parsed;
	throw new ConfigurationError(`${at} must be a supported surface`);
}

function optionalJudgeMode(value: unknown, at: string): JudgeMode | undefined {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "off" || value === "on") return value;
	throw new ConfigurationError(`${at} must be "auto", "off", or "on"`);
}

function optionalThinkingLevel(value: unknown, at: string): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	throw new ConfigurationError(`${at} must be a supported thinking level`);
}

function validatePanelForSave(panel: PanelDefinition, source: string): void {
	if (!panel.name.trim()) throw new ConfigurationError(`${source} panel name must be non-empty`);
	parsePanelDefinition(panel.name, { members: panel.members }, `${source}.panels.${panel.name}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
