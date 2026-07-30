import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	inspectUserConfig,
	migrateUserConfig,
	PanelNameCollisionError,
	PanelReferencedError,
	removeUserPanel,
	renameUserPanel,
	setDefaultUserPanel,
} from "./config.js";
import { showPanelSetup } from "./setup.js";
import type { PanelDefinition, ScrutinyTemplate } from "./types.js";

export const PANEL_MANAGER_NON_INTERACTIVE = "Panel manager requires Pi TUI. Run `/scrutiny panels` in an interactive Pi session. Raw JSON editing is available as an advanced fallback with `/scrutiny config edit`.";

export async function showPanelManager(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(PANEL_MANAGER_NON_INTERACTIVE, "warning");
		return;
	}

	if (!(await ensureCurrentConfig(ctx))) return;
	while (true) {
		let state;
		try {
			state = await inspectUserConfig();
		} catch (error) {
			notifyConfigFailure(ctx, "Panel manager could not read the global settings", error);
			return;
		}
		const create = "Create panel";
		const panelOptions = state.panels.map((panel) => panelOption(panel, panel.name === state.defaultPanel));
		const choice = await ctx.ui.select(
			"Scrutiny panels · global settings · no model spend",
			[create, ...panelOptions],
		);
		if (choice === undefined) return;
		if (choice === create) {
			await showPanelSetup(ctx);
			continue;
		}
		const panelIndex = panelOptions.indexOf(choice);
		const panel = state.panels[panelIndex];
		if (!panel) continue;
		await managePanel(ctx, panel, state.defaultPanel, state.templates);
	}
}

async function ensureCurrentConfig(ctx: ExtensionCommandContext): Promise<boolean> {
	let state;
	try {
		state = await inspectUserConfig();
	} catch (error) {
		notifyConfigFailure(ctx, "Panel manager could not read the global settings", error);
		return false;
	}
	if (!state.legacy) return true;
	const confirmed = await ctx.ui.confirm(
		"Upgrade existing Scrutiny settings?",
		"Your settings use an older format that Scrutiny can read but the panel manager cannot safely change. Continue to create a private backup and convert the effective panels, templates, lenses, defaults, and policies without starting a run?",
	);
	if (!confirmed) {
		ctx.ui.notify("Panel manager closed. Nothing was changed; raw JSON editing remains available under `/scrutiny config edit`.", "info");
		return false;
	}
	try {
		const result = await migrateUserConfig();
		ctx.ui.notify(`Settings upgraded safely${result.backup ? `; original backed up at ${result.backup}` : ""}. No Scrutiny run was started.`, "info");
		return true;
	} catch (error) {
		notifyConfigFailure(ctx, "Settings could not be upgraded, so panel management cannot continue", error);
		return false;
	}
}

async function managePanel(
	ctx: ExtensionCommandContext,
	panel: PanelDefinition,
	defaultPanel: string | undefined,
	templates: ScrutinyTemplate[],
): Promise<void> {
	const inspect = "Inspect lineup";
	const edit = "Edit lineup and thinking levels";
	const rename = "Rename panel";
	const makeDefault = panel.name === defaultPanel ? "Default panel (already selected)" : "Set as default";
	const remove = "Remove panel";
	const back = "Back to panels";
	const choice = await ctx.ui.select(
		`Panel "${panel.name}"${panel.name === defaultPanel ? " · default" : ""} · ${panel.members.length} member${panel.members.length === 1 ? "" : "s"}`,
		[inspect, edit, rename, makeDefault, remove, back],
	);
	if (choice === undefined || choice === back) return;
	if (choice === inspect) {
		await ctx.ui.select(
			`Panel "${panel.name}" lineup · order is execution order`,
			[...panel.members.map((member, index) => `${index + 1}. ${member.model}${member.thinking ? ` · think:${member.thinking}` : ""}`), "Back"],
		);
		return;
	}
	if (choice === edit) {
		await showPanelSetup(ctx, { initialPanel: panel });
		return;
	}
	if (choice === rename) {
		await renamePanel(ctx, panel, defaultPanel, templates);
		return;
	}
	if (choice === makeDefault) {
		if (panel.name === defaultPanel) {
			ctx.ui.notify(`"${panel.name}" is already the default panel. Nothing changed.`, "info");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Change default Scrutiny panel?",
			`Use "${panel.name}" whenever a run or template does not select a panel explicitly? This changes settings only and starts no run.`,
		);
		if (!confirmed) return;
		try {
			await setDefaultUserPanel(panel.name);
			ctx.ui.notify(`"${panel.name}" is now the default panel. No Scrutiny run was started.`, "info");
		} catch (error) {
			notifyConfigFailure(ctx, "Default panel was not changed", error);
		}
		return;
	}
	if (choice === remove) await removePanel(ctx, panel, defaultPanel, templates);
}

async function renamePanel(
	ctx: ExtensionCommandContext,
	panel: PanelDefinition,
	defaultPanel: string | undefined,
	templates: ScrutinyTemplate[],
): Promise<void> {
	const entered = await ctx.ui.input("Rename global Scrutiny panel", panel.name);
	if (entered === undefined) return;
	const nextName = entered.trim();
	if (!nextName || nextName === panel.name) {
		ctx.ui.notify(nextName ? "Panel name is unchanged." : "Panel name must not be empty. Nothing changed.", nextName ? "info" : "warning");
		return;
	}
	const references = referencesTo(templates, panel.name);
	const consequences = [
		references.length ? `update ${references.length === 1 ? "template" : "templates"} ${references.map(quoted).join(", ")}` : "no template references need updating",
		panel.name === defaultPanel ? "keep this panel as the default under its new name" : "leave the default unchanged",
	].join("; ");
	const confirmed = await ctx.ui.confirm(
		"Rename Scrutiny panel?",
		`Rename "${panel.name}" to "${nextName}" and ${consequences}? The change is atomic and starts no run.`,
	);
	if (!confirmed) return;
	try {
		await renameUserPanel(panel.name, nextName, { updateTemplateReferences: references.length > 0 });
		ctx.ui.notify(`Renamed "${panel.name}" to "${nextName}"${references.length ? ` and updated ${references.length} template reference${references.length === 1 ? "" : "s"}` : ""}.`, "info");
	} catch (error) {
		if (error instanceof PanelNameCollisionError) {
			ctx.ui.notify(`Panel was not renamed because "${nextName}" already exists. Choose a different name; no settings were changed.`, "warning");
			return;
		}
		notifyConfigFailure(ctx, "Panel was not renamed", error);
	}
}

async function removePanel(
	ctx: ExtensionCommandContext,
	panel: PanelDefinition,
	defaultPanel: string | undefined,
	templates: ScrutinyTemplate[],
): Promise<void> {
	const references = referencesTo(templates, panel.name);
	let state;
	try {
		state = await inspectUserConfig();
	} catch (error) {
		notifyConfigFailure(ctx, "Panel was not removed because settings could not be read", error);
		return;
	}
	const remaining = state.panels.filter((candidate) => candidate.name !== panel.name);
	const consequences = [
		`permanently remove the ${panel.members.length}-member lineup`,
		...(references.length ? [`also remove referencing ${references.length === 1 ? "template" : "templates"} ${references.map(quoted).join(", ")}`] : []),
		...(panel.name === defaultPanel ? [`change the default to ${remaining[0] ? quoted(remaining[0].name) : "none"}`] : []),
	];
	const confirmed = await ctx.ui.confirm(
		"Remove Scrutiny panel?",
		`${consequences.join("; ")}? This cannot be undone from the manager, but the settings update is atomic. No run will start.`,
	);
	if (!confirmed) return;
	try {
		await removeUserPanel(panel.name, { removeReferencedTemplates: references.length > 0 });
		ctx.ui.notify(`Removed panel "${panel.name}"${references.length ? ` and ${references.length} referencing template${references.length === 1 ? "" : "s"}` : ""}. No Scrutiny run was started.`, "info");
	} catch (error) {
		if (error instanceof PanelReferencedError) {
			ctx.ui.notify(`Panel was not removed because it is still referenced by ${error.templateNames.map(quoted).join(", ")}. Nothing changed.`, "warning");
			return;
		}
		notifyConfigFailure(ctx, "Panel was not removed", error);
	}
}

function panelOption(panel: PanelDefinition, isDefault: boolean): string {
	const models = panel.members.map((member) => shortModel(member.model)).join(", ");
	return `${isDefault ? "default · " : ""}${panel.name} · ${panel.members.length} member${panel.members.length === 1 ? "" : "s"} · ${models}`;
}

function referencesTo(templates: ScrutinyTemplate[], panelName: string): string[] {
	return templates.filter((template) => "panel" in template && template.panel === panelName).map((template) => template.name);
}

function shortModel(model: string): string {
	return model.split("/").at(-1) ?? model;
}

function quoted(value: string): string {
	return `"${value}"`;
}

function notifyConfigFailure(ctx: ExtensionCommandContext, outcome: string, error: unknown): void {
	ctx.ui.notify(
		`${outcome}. Scrutiny left the previous settings unchanged. Check the file detail and permissions, then retry or use \`/scrutiny config edit\` as an advanced fallback. Detail: ${error instanceof Error ? error.message : String(error)}`,
		"error",
	);
}
