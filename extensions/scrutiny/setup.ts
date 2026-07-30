import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	LegacyConfigMigrationRequiredError,
	migrateUserConfig,
	PanelNameCollisionError,
	readScrutinyConfig,
	saveUserPanel,
} from "./config.js";
import type { PanelDefinition, PanelMember, ScrutinyConfig, ThinkingLevel } from "./types.js";

export const PANEL_SETUP_NON_INTERACTIVE = "Panel setup requires Pi TUI. Run `/scrutiny setup` in an interactive Pi session, or edit `~/.pi/agent/scrutiny.json`.";
export const NO_AUTHENTICATED_MODELS = "No authenticated models available. Run `/login` to authenticate a provider, then `/model` to confirm model availability. Custom providers can be configured in `~/.pi/agent/models.json`.";

type RegistryModel = ReturnType<ExtensionCommandContext["modelRegistry"]["getAvailable"]>[number];

type SetupModel = {
	key: string;
	label: string;
	searchText: string;
	name: string;
	thinkingLevels: ThinkingLevel[];
};

type SelectedModel = {
	thinking?: ThinkingLevel;
	order: number;
};

export type PanelSetupResult = {
	panelName: string;
	file: string;
};

export async function showPanelSetup(
	ctx: ExtensionCommandContext,
	options: { config?: ScrutinyConfig; maxMembers?: number; initialPanel?: PanelDefinition } = {},
): Promise<PanelSetupResult | null> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(PANEL_SETUP_NON_INTERACTIVE, "warning");
		return null;
	}

	let available: RegistryModel[];
	try {
		ctx.modelRegistry.refresh();
		available = ctx.modelRegistry.getAvailable();
	} catch (error) {
		ctx.ui.notify(`Unable to load authenticated models: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
	if (!available.length && !options.initialPanel) {
		ctx.ui.notify(NO_AUTHENTICATED_MODELS, "warning");
		return null;
	}
	if (!available.length && options.initialPanel) {
		ctx.ui.notify("No authenticated models are currently available. Existing configured members remain editable; use `/login` before adding another model.", "warning");
	}

	const config = options.config ?? readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
	const configuredLimit = options.initialPanel
		? Math.max(config.maxPanelModels, options.initialPanel.members.length)
		: config.maxPanelModels;
	const maxMembers = Math.max(
		1,
		options.initialPanel?.members.length ?? 0,
		Math.min(options.maxMembers ?? configuredLimit, configuredLimit),
	);
	const choices = available
		.map(toSetupModel)
		.sort((left, right) => left.label.localeCompare(right.label));
	for (const member of options.initialPanel?.members ?? []) {
		const configured = choices.find((choice) => choice.key === member.model);
		if (configured) {
			if (member.thinking && !configured.thinkingLevels.includes(member.thinking)) configured.thinkingLevels.unshift(member.thinking);
			continue;
		}
		choices.push({
			key: member.model,
			label: member.model,
			searchText: `${member.model} configured unavailable`,
			name: "Configured model (not currently authenticated)",
			thinkingLevels: thinkingLevelsWithCurrent(member.thinking),
		});
	}
	const members = await ctx.ui.custom<PanelMember[] | null>(
		(tui, theme, _kb, done) => new PanelSetupPicker(tui, theme, choices, maxMembers, done, options.initialPanel?.members),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "74%", minWidth: 68, maxHeight: "84%", margin: 1 },
		},
	);
	if (!members?.length) return null;

	if (options.initialPanel) {
		const saved = await persistPanel(ctx, { name: options.initialPanel.name, members }, true);
		if (!saved) return null;
		ctx.ui.notify(`Updated global panel "${options.initialPanel.name}" in ${saved}. No Scrutiny run was started.`, "info");
		return { panelName: options.initialPanel.name, file: saved };
	}

	while (true) {
		const entered = await ctx.ui.input("Name global scrutiny panel", "e.g. balanced");
		if (entered === undefined) return null;
		const panelName = entered.trim();
		if (!panelName) {
			ctx.ui.notify("Panel name must not be empty.", "warning");
			continue;
		}
		const panel: PanelDefinition = { name: panelName, members };
		const saved = await persistPanel(ctx, panel, false);
		if (saved === "choose-another-name") continue;
		if (saved) {
			const file = saved;
			ctx.ui.notify(`Saved global panel "${panelName}" to ${file}. Review task packet before running.`, "info");
			return { panelName, file };
		}
		return null;
	}
}

export function supportedThinkingLevels(model: Pick<RegistryModel, "reasoning" | "thinkingLevelMap">): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
	return levels.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return level !== "xhigh" || mapped !== undefined;
	});
}

function toSetupModel(model: RegistryModel): SetupModel {
	const label = `${model.provider}/${model.id}`;
	return {
		key: label,
		label,
		searchText: `${label} ${model.name}`,
		name: model.name,
		thinkingLevels: supportedThinkingLevels(model),
	};
}

class PanelSetupPicker implements Component, Focusable {
	private readonly search = new Input();
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly models: SetupModel[];
	private readonly maxMembers: number;
	private readonly done: (value: PanelMember[] | null) => void;
	private filtered: SetupModel[];
	private selectedIndex = 0;
	private readonly selected = new Map<string, SelectedModel>();
	private nextOrder = 0;
	private message = "";
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		models: SetupModel[],
		maxMembers: number,
		done: (value: PanelMember[] | null) => void,
		initialMembers: PanelMember[] = [],
	) {
		this.tui = tui;
		this.theme = theme;
		this.models = models;
		this.maxMembers = maxMembers;
		this.done = done;
		this.filtered = models;
		for (const [order, member] of initialMembers.slice(0, maxMembers).entries()) {
			const model = models.find((candidate) => candidate.key === member.model);
			if (model) this.selected.set(model.key, { thinking: member.thinking, order });
		}
		this.nextOrder = this.selected.size;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) return this.done(null);
		if (matchesKey(data, Key.ctrl("s"))) {
			const members = this.members();
			if (!members.length) {
				this.message = "Select at least one model before continuing.";
				return this.rerender();
			}
			return this.done(members);
		}
		if (matchesKey(data, Key.up)) {
			if (this.filtered.length) this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
			return this.rerender();
		}
		if (matchesKey(data, Key.down)) {
			if (this.filtered.length) this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
			return this.rerender();
		}
		if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
			this.toggleSelected();
			return this.rerender();
		}
		if (matchesKey(data, Key.left)) {
			this.cycleThinking(-1);
			return this.rerender();
		}
		if (matchesKey(data, Key.right)) {
			this.cycleThinking(1);
			return this.rerender();
		}

		const before = this.search.getValue();
		this.search.handleInput(data);
		if (this.search.getValue() !== before) {
			this.filtered = this.search.getValue()
				? fuzzyFilter(this.models, this.search.getValue(), (model) => model.searchText)
				: this.models;
			this.selectedIndex = 0;
			this.message = "";
		}
		this.rerender();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const lines: string[] = [];
		const accent = (text: string) => this.theme.fg("accent", text);
		const dim = (text: string) => this.theme.fg("dim", text);
		const success = (text: string) => this.theme.fg("success", text);
		const warning = (text: string) => this.theme.fg("warning", text);

		lines.push(topBorder(w, `${accent("scrutiny panel setup")} ${dim("global · no spend")}`, this.theme));
		lines.push(frameLine(`${dim("search ›")} ${this.search.render(Math.max(1, w - 14))[0] ?? ""}`, w, this.theme));
		lines.push(frameLine(`${accent(`${this.selected.size}/${this.maxMembers}`)} ${dim("members selected · selection order maps to role-lens order")}`, w, this.theme));
		lines.push(midBorder(w, this.theme));

		if (!this.filtered.length) {
			lines.push(frameLine(dim("No matching authenticated models."), w, this.theme));
		} else {
			for (const item of visibleWindow(this.filtered, this.selectedIndex, 10)) {
				const model = item.row;
				const active = item.index === this.selectedIndex;
				const selected = this.selected.get(model.key);
				const prefix = active ? accent(">") : " ";
				const box = selected ? success("[x]") : dim("[ ]");
				const order = selected ? `${this.memberNumber(model.key)}.` : "  ";
				const thinking = selected ? accent(`think:${selected.thinking ?? "default"}`) : dim("not selected");
				lines.push(frameLine(`${prefix} ${box} ${order} ${model.label}  ${thinking}`, w, this.theme));
			}
			const current = this.filtered[this.selectedIndex];
			if (current) {
				lines.push(frameLine("", w, this.theme));
				lines.push(frameLine(`${dim("model")} ${current.name}`, w, this.theme));
				lines.push(frameLine(`${dim("thinking")} ${current.thinkingLevels.join(" · ")}`, w, this.theme));
			}
		}

		if (this.message) lines.push(frameLine(warning(this.message), w, this.theme));
		lines.push(midBorder(w, this.theme));
		lines.push(frameLine(dim("type search · ↑↓ navigate · space/enter select · ←→ thinking · ^s name/save · esc back"), w, this.theme));
		lines.push(bottomBorder(w, this.theme));
		return lines;
	}

	invalidate(): void {
		this.search.invalidate();
	}

	private toggleSelected(): void {
		const model = this.filtered[this.selectedIndex];
		if (!model) return;
		if (this.selected.delete(model.key)) {
			this.message = "";
			return;
		}
		if (this.selected.size >= this.maxMembers) {
			this.message = `This task supports at most ${this.maxMembers} panel member${this.maxMembers === 1 ? "" : "s"}.`;
			return;
		}
		const thinking = model.thinkingLevels[0];
		if (!thinking) {
			this.message = `${model.label} has no Scrutiny-compatible thinking level.`;
			return;
		}
		this.selected.set(model.key, { thinking, order: this.nextOrder++ });
		this.message = "";
	}

	private cycleThinking(delta: number): void {
		const model = this.filtered[this.selectedIndex];
		if (!model) return;
		const selected = this.selected.get(model.key);
		if (!selected) {
			this.message = "Select model before changing its thinking level.";
			return;
		}
		if (selected.thinking === undefined) {
			selected.thinking = delta > 0 ? model.thinkingLevels[0] : model.thinkingLevels.at(-1);
			this.message = "";
			return;
		}
		const current = model.thinkingLevels.indexOf(selected.thinking);
		selected.thinking = model.thinkingLevels[(current + delta + model.thinkingLevels.length) % model.thinkingLevels.length]!;
		this.message = "";
	}

	private members(): PanelMember[] {
		return [...this.selected.entries()]
			.sort((left, right) => left[1].order - right[1].order)
			.map(([model, selection]) => ({
				model,
				...(selection.thinking === undefined ? {} : { thinking: selection.thinking }),
			}));
	}

	private memberNumber(key: string): number {
		return this.members().findIndex((member) => member.model === key) + 1;
	}

	private rerender(): void {
		this.tui.requestRender();
	}
}

function visibleWindow<T>(items: T[], selected: number, size: number): Array<{ row: T; index: number }> {
	const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
	return items.slice(start, start + size).map((row, offset) => ({ row, index: start + offset }));
}

async function persistPanel(
	ctx: ExtensionCommandContext,
	panel: PanelDefinition,
	overwrite: boolean,
): Promise<string | "choose-another-name" | null> {
	let replace = overwrite;
	let migrationApproved = false;
	while (true) {
		try {
			return await saveUserPanel(panel, { overwrite: replace });
		} catch (error) {
			if (error instanceof PanelNameCollisionError) {
				const confirmed = await ctx.ui.confirm(
					"Replace global scrutiny panel?",
					`Panel "${panel.name}" already exists. Replacing it changes the lineup used by every template that selects this panel. No run will start.`,
				);
				if (!confirmed) return "choose-another-name";
				replace = true;
				continue;
			}
			if (error instanceof LegacyConfigMigrationRequiredError) {
				if (!migrationApproved) {
					migrationApproved = await ctx.ui.confirm(
						"Upgrade existing Scrutiny settings?",
						"Scrutiny found an older settings format. It is still readable, but panel changes require the current format. Continue to create a private backup, preserve the effective panels, templates, lenses, defaults, and policies, then save this panel? No run will start.",
					);
					if (!migrationApproved) {
						ctx.ui.notify("Nothing changed. Your existing settings and selected lineup were not saved.", "info");
						return null;
					}
				}
				try {
					const migrated = await migrateUserConfig();
					ctx.ui.notify(`Settings upgraded safely${migrated.backup ? `; original backed up at ${migrated.backup}` : ""}. Continuing with the selected lineup.`, "info");
					continue;
				} catch (migrationError) {
					ctx.ui.notify(
						`Settings were not upgraded, so the panel cannot be saved yet. Your original settings are unchanged. Check file permissions or free space, then try again. Detail: ${errorText(migrationError)}`,
						"error",
					);
					if (await ctx.ui.confirm("Try settings upgrade again?", "Retry without reselecting the panel lineup?")) continue;
					return null;
				}
			}
			ctx.ui.notify(
				`Panel was not saved because Scrutiny could not complete an atomic settings update. Your previous settings are unchanged. Check file permissions or free space, then try again. Detail: ${errorText(error)}`,
				"error",
			);
			if (await ctx.ui.confirm("Try saving panel again?", "Retry with the same name, lineup, and thinking levels?")) continue;
			return null;
		}
	}
}

function thinkingLevelsWithCurrent(current: ThinkingLevel | undefined): ThinkingLevel[] {
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
	if (!current || levels.includes(current)) return levels;
	return [current, ...levels];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function topBorder(width: number, title: string, theme: Theme): string {
	const plain = `╭─ ${title} `;
	return theme.fg("borderAccent", truncateToWidth(`${plain}${"─".repeat(width)}`, Math.max(0, width - 1), "")) + theme.fg("borderAccent", "╮");
}

function midBorder(width: number, theme: Theme): string {
	return theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
}

function bottomBorder(width: number, theme: Theme): string {
	return theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function frameLine(content: string, width: number, theme: Theme): string {
	const innerWidth = Math.max(0, width - 4);
	const clipped = truncateToWidth(content, innerWidth, "…");
	return `${theme.fg("borderMuted", "│ ")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${theme.fg("borderMuted", " │")}`;
}
