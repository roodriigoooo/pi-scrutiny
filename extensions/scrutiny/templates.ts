import { SCRUTINY_SURFACE_SET } from "./surfaces.js";
import type {
	DeliberationStrategy,
	DeliberationTemplate,
	JudgeMode,
	PanelDefinition,
	PanelMember,
	ResolvedDeliberationRunPlan,
	ResolvedPanelAssignment,
	ResolvedRunPlan,
	ResolvedRunPolicies,
	ResolvedVerifyRunPlan,
	ScrutinyConfig,
	ScrutinyParams,
	ScrutinySurface,
	ScrutinyTemplate,
	ThinkingLevel,
	VerifyTemplate,
} from "./types.js";

export const BUILTIN_TEMPLATE_NAMES = ["consult", "hypotheses", "criteria", "repo-map", "risks", "verify"] as const;

export const LEGACY_DEFAULT_PANEL_NAME = "default";

const BUILTIN_TEMPLATE_INPUTS: Record<(typeof BUILTIN_TEMPLATE_NAMES)[number], ScrutinyTemplate> = {
	consult: { name: "consult", surface: "consult", strategy: "replicate", includeGitDiff: false, judgeMode: "auto", verify: false },
	hypotheses: { name: "hypotheses", surface: "hypotheses", strategy: "replicate", includeGitDiff: true, judgeMode: "off", verify: false },
	criteria: { name: "criteria", surface: "criteria", strategy: "replicate", includeGitDiff: true, judgeMode: "off", verify: false },
	"repo-map": {
		name: "repo-map",
		surface: "repo-map",
		strategy: "roles",
		lenses: ["call-path mapper", "api/symbol mapper", "test/invariant mapper", "config/build mapper"],
		includeGitDiff: true,
		judgeMode: "off",
		verify: false,
	},
	risks: {
		name: "risks",
		surface: "risks",
		strategy: "roles",
		lenses: [
			"concurrency reviewer",
			"reactive-chain reviewer",
			"api-compatibility reviewer",
			"security reviewer",
			"performance reviewer",
			"data-migration reviewer",
			"null/error-handling reviewer",
			"flaky-test reviewer",
		],
		includeGitDiff: true,
		judgeMode: "off",
		verify: true,
	},
	verify: { name: "verify", surface: "verify", includeGitDiff: true, verify: true },
};

export class ConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigurationError";
	}
}

export class MissingPanelError extends ConfigurationError {
	constructor(message: string) {
		super(message);
		this.name = "MissingPanelError";
	}
}

export function builtInTemplates(): ScrutinyTemplate[] {
	return BUILTIN_TEMPLATE_NAMES.map((name) => {
		const template = BUILTIN_TEMPLATE_INPUTS[name];
		assertValidTemplate(template, `built-in templates.${name}`);
		return freezeTemplate(template);
	});
}

export function isBuiltinTemplateName(name: string): boolean {
	return (BUILTIN_TEMPLATE_NAMES as readonly string[]).includes(name);
}

export function parseTemplateDefinition(name: string, value: unknown, at: string): ScrutinyTemplate {
	if (!isRecord(value)) throw new ConfigurationError(`${at} must be an object`);
	const explicitName = optionalString(value.name, `${at}.name`);
	if (explicitName && explicitName !== name) throw new ConfigurationError(`${at}.name must match "${name}"`);
	const surface = requiredSurface(value.surface, `${at}.surface`);
	const includeGitDiff = optionalBoolean(value.includeGitDiff, `${at}.includeGitDiff`);
	const verify = optionalBoolean(value.verify, `${at}.verify`);

	if (surface === "verify") {
		for (const key of ["strategy", "lenses", "panel", "judgeMode", "judgePolicy"]) {
			if (key in value) throw new ConfigurationError(`${at}.${key} is not allowed for verify templates`);
		}
		const template: VerifyTemplate = { name, surface, ...(includeGitDiff === undefined ? {} : { includeGitDiff }), ...(verify === undefined ? {} : { verify }) };
		assertValidTemplate(template, at);
		return template;
	}

	const strategy = requiredStrategy(value.strategy, `${at}.strategy`);
	const panel = optionalString(value.panel, `${at}.panel`);
	const judgeMode = optionalJudgeMode(value.judgeMode ?? value.judgePolicy, `${at}.judgeMode`);
	if (strategy === "replicate" && "lenses" in value) throw new ConfigurationError(`${at}.lenses must be omitted for replicate templates`);
	const lenses = strategy === "roles" ? requiredLenses(value.lenses, `${at}.lenses`) : undefined;
	const template: DeliberationTemplate = {
		name,
		surface,
		strategy,
		...(lenses === undefined ? {} : { lenses }),
		...(panel === undefined ? {} : { panel }),
		...(judgeMode === undefined ? {} : { judgeMode }),
		...(includeGitDiff === undefined ? {} : { includeGitDiff }),
		...(verify === undefined ? {} : { verify }),
	};
	assertValidTemplate(template, at);
	return template;
}

export function validatePanelDefinition(panel: PanelDefinition, at: string): void {
	if (!panel.name.trim()) throw new ConfigurationError(`${at}.name must be non-empty`);
	if (!Array.isArray(panel.members) || panel.members.length === 0) throw new ConfigurationError(`${at}.members must contain at least one member`);
	const seen = new Set<string>();
	for (const [index, member] of panel.members.entries()) {
		if (!member.model.trim()) throw new ConfigurationError(`${at}.members[${index}].model must be non-empty`);
		if (seen.has(member.model)) throw new ConfigurationError(`${at}.members[${index}].model duplicates "${member.model}"`);
		seen.add(member.model);
	}
}

export function parsePanelDefinition(name: string, value: unknown, at: string): PanelDefinition {
	if (!isRecord(value)) throw new ConfigurationError(`${at} must be an object`);
	const explicitName = optionalString(value.name, `${at}.name`);
	if (explicitName && explicitName !== name) throw new ConfigurationError(`${at}.name must match "${name}"`);
	if (!Array.isArray(value.members)) throw new ConfigurationError(`${at}.members must be an array`);
	const members = value.members.map((member, index) => parsePanelMember(member, `${at}.members[${index}]`));
	const panel = { name, members };
	validatePanelDefinition(panel, at);
	return panel;
}

export function parsePanelMember(value: unknown, at: string): PanelMember {
	if (typeof value === "string") {
		const model = value.trim();
		if (!model) throw new ConfigurationError(`${at} must name a non-empty model`);
		return { model };
	}
	if (!isRecord(value)) throw new ConfigurationError(`${at} must be a model string or object`);
	if ("lens" in value) throw new ConfigurationError(`${at}.lens is not allowed; lenses belong to templates`);
	const model = requiredString(value.model, `${at}.model`);
	const thinking = optionalThinkingLevel(value.thinking, `${at}.thinking`);
	return { model, ...(thinking === undefined ? {} : { thinking }) };
}

export function resolveRunPlan(input: {
	templateName: string;
	panelName?: string;
	includeGitDiff?: boolean;
	judgeMode?: JudgeMode;
	verify?: boolean;
}, config: ScrutinyConfig): ResolvedRunPlan {
	if (config.configurationErrors.length) throw new ConfigurationError(config.configurationErrors.join("\n"));
	const foundTemplate = allTemplates(config).find((item) => item.name === input.templateName);
	if (!foundTemplate) throw new ConfigurationError(`templates.${input.templateName} is not configured`);
	const template = freezeTemplate(foundTemplate);

	if (template.surface === "verify") {
		const policies = freezePolicies({
			includeGitDiff: input.includeGitDiff ?? template.includeGitDiff ?? config.includeGitDiff,
			judgeMode: "off",
			verify: true,
		});
		return Object.freeze({
			template,
			panel: undefined,
			strategy: undefined,
			assignments: Object.freeze([]) as readonly [],
			unassignedLenses: Object.freeze([]) as readonly [],
			policies,
		} satisfies ResolvedVerifyRunPlan);
	}

	const selectedPanelName = input.panelName ?? template.panel ?? config.defaultPanel;
	if (!selectedPanelName) throw new MissingPanelError("No panel selected. Choose a panel, set template.panel, or configure defaultPanel.");
	const foundPanel = config.panels.find((item) => item.name === selectedPanelName);
	if (!foundPanel) throw new ConfigurationError(`panels.${selectedPanelName} is not configured`);
	validatePanelDefinition(foundPanel, `panels.${selectedPanelName}`);
	const panel = freezePanel(foundPanel);

	if (template.strategy === "roles" && panel.members.length > template.lenses!.length) {
		throw new ConfigurationError(`panels.${selectedPanelName}.members has ${panel.members.length} members but templates.${template.name}.lenses has ${template.lenses!.length}; roles panels cannot exceed their lenses`);
	}
	const assignments = freezeAssignments(panel.members, template.strategy === "roles" ? template.lenses : undefined);
	const policies = freezePolicies({
		includeGitDiff: input.includeGitDiff ?? template.includeGitDiff ?? config.includeGitDiff,
		judgeMode: input.judgeMode ?? template.judgeMode ?? "off",
		verify: input.verify ?? template.verify ?? false,
	});
	return Object.freeze({
		template,
		panel,
		strategy: template.strategy,
		assignments,
		unassignedLenses: Object.freeze((template.strategy === "roles" ? template.lenses!.slice(panel.members.length) : []).slice()),
		policies,
	} satisfies ResolvedDeliberationRunPlan);
}

export function allTemplates(config: ScrutinyConfig): ScrutinyTemplate[] {
	return [...builtInTemplates(), ...config.templates];
}

export function strategyPlainLanguage(strategy: DeliberationStrategy | undefined): string {
	if (strategy === "replicate") return "same prompt for every model; agreement and disagreement are signals";
	if (strategy === "roles") return "one assigned lens per model; coverage and gaps are signals";
	return "objective checks only; no model panel";
}

export function legacyTemplateForPanel(input: {
	name: string;
	surface: ScrutinySurface;
	members: Array<PanelMember & { lens?: string }>;
	panel: string;
	judgeMode?: JudgeMode;
	includeGitDiff?: boolean;
	verify?: boolean;
}): ScrutinyTemplate {
	const builtIn = BUILTIN_TEMPLATE_INPUTS[input.surface];
	if (builtIn.surface === "verify") {
		return {
			name: input.name,
			surface: "verify",
			includeGitDiff: input.includeGitDiff ?? builtIn.includeGitDiff,
			verify: input.verify ?? true,
		};
	}
	if (builtIn.strategy === "replicate") {
		return {
			name: input.name,
			surface: input.surface,
			strategy: "replicate",
			panel: input.panel,
			includeGitDiff: input.includeGitDiff ?? builtIn.includeGitDiff,
			judgeMode: input.judgeMode ?? builtIn.judgeMode,
			verify: input.verify ?? builtIn.verify,
		};
	}
	const lenses = input.members.map((member, index) => member.lens?.trim() || builtIn.lenses![index] || `panelist-${index + 1}`);
	return {
		name: input.name,
		surface: input.surface,
		strategy: "roles",
		lenses,
		panel: input.panel,
		includeGitDiff: input.includeGitDiff ?? builtIn.includeGitDiff,
		judgeMode: input.judgeMode ?? builtIn.judgeMode,
		verify: input.verify ?? builtIn.verify,
	};
}

function allTemplateErrors(template: ScrutinyTemplate): string[] {
	const errors: string[] = [];
	if (!template.name.trim()) errors.push("name must be non-empty");
	if (template.surface === "verify") return errors;
	if (template.strategy !== "replicate" && template.strategy !== "roles") errors.push("deliberation templates require strategy");
	if (template.strategy === "replicate" && "lenses" in template) errors.push("replicate templates must omit lenses");
	if (template.strategy === "roles") {
		const lenses = template.lenses ?? [];
		if (lenses.length === 0) errors.push("roles templates require non-empty lenses");
		if (lenses.some((lens) => !lens.trim())) errors.push("roles template lenses must be non-empty");
		if (new Set(lenses.map((lens) => lens.trim())).size !== lenses.length) errors.push("roles template lenses must be unique");
	}
	return errors;
}

function assertValidTemplate(template: ScrutinyTemplate, at: string): void {
	const errors = allTemplateErrors(template);
	if (errors.length) throw new ConfigurationError(errors.map((error) => `${at}: ${error}`).join("\n"));
}

function freezeTemplate(template: ScrutinyTemplate): ScrutinyTemplate {
	if (template.surface === "verify") return Object.freeze({ ...template });
	return Object.freeze({ ...template, ...(template.lenses ? { lenses: Object.freeze([...template.lenses]) as unknown as string[] } : {}) });
}

function freezePanel(panel: PanelDefinition): PanelDefinition {
	return Object.freeze({
		...panel,
		members: Object.freeze(panel.members.map((member) => Object.freeze({ ...member }))) as unknown as PanelMember[],
	});
}

function freezeAssignments(members: PanelMember[], lenses: string[] | undefined): readonly ResolvedPanelAssignment[] {
	return Object.freeze(members.map((member, index) => Object.freeze({
		model: member.model,
		...(member.thinking === undefined ? {} : { thinking: member.thinking }),
		...(lenses?.[index] === undefined ? {} : { lens: lenses[index] }),
	})));
}

function freezePolicies(policies: ResolvedRunPolicies): Readonly<ResolvedRunPolicies> {
	return Object.freeze({ ...policies });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, at: string): string {
	const parsed = optionalString(value, at);
	if (!parsed) throw new ConfigurationError(`${at} must be a non-empty string`);
	return parsed;
}

function optionalString(value: unknown, at: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new ConfigurationError(`${at} must be a non-empty string`);
	return value.trim();
}

function requiredSurface(value: unknown, at: string): ScrutinySurface {
	const parsed = optionalString(value, at);
	if (!parsed || !SCRUTINY_SURFACE_SET.has(parsed as ScrutinySurface)) throw new ConfigurationError(`${at} must be a supported surface`);
	return parsed as ScrutinySurface;
}

function requiredStrategy(value: unknown, at: string): DeliberationStrategy {
	if (value === "replicate" || value === "roles") return value;
	throw new ConfigurationError(`${at} must be "replicate" or "roles"`);
}

function optionalJudgeMode(value: unknown, at: string): JudgeMode | undefined {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "off" || value === "on") return value;
	throw new ConfigurationError(`${at} must be "auto", "off", or "on"`);
}

function optionalBoolean(value: unknown, at: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new ConfigurationError(`${at} must be a boolean`);
	return value;
}

function requiredLenses(value: unknown, at: string): string[] {
	if (!Array.isArray(value)) throw new ConfigurationError(`${at} must be a non-empty array`);
	const lenses = value.map((lens, index) => requiredString(lens, `${at}[${index}]`));
	if (lenses.length === 0) throw new ConfigurationError(`${at} must be a non-empty array`);
	if (new Set(lenses).size !== lenses.length) throw new ConfigurationError(`${at} must contain unique values`);
	return lenses;
}

function optionalThinkingLevel(value: unknown, at: string): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	throw new ConfigurationError(`${at} must be a supported thinking level`);
}
