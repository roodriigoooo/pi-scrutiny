import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PanelNameCollisionError, readScrutinyConfig, saveUserPanel } from "./config.js";
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
	thinking: ThinkingLevel;
	order: number;
};

export type PanelSetupResult = {
	panelName: string;
	file: string;
};

export async function showPanelSetup(
	ctx: ExtensionCommandContext,
	options: { config?: ScrutinyConfig; maxMembers?: number } = {},
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
	if (!available.length) {
		ctx.ui.notify(NO_AUTHENTICATED_MODELS, "warning");
		return null;
	}

	const config = options.config ?? readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
	const maxMembers = Math.max(1, Math.min(options.maxMembers ?? config.maxPanelModels, config.maxPanelModels));
	const choices = available
		.map(toSetupModel)
		.sort((left, right) => left.label.localeCompare(right.label));
	const members = await ctx.ui.custom<PanelMember[] | null>(
		(tui, theme, _kb, done) => new PanelSetupPicker(tui, theme, choices, maxMembers, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "74%", minWidth: 68, maxHeight: "84%", margin: 1 },
		},
	);
	if (!members?.length) return null;

	while (true) {
		const entered = await ctx.ui.input("Name global scrutiny panel", "e.g. balanced");
		if (entered === undefined) return null;
		const panelName = entered.trim();
		if (!panelName) {
			ctx.ui.notify("Panel name must not be empty.", "warning");
			continue;
		}
		const panel: PanelDefinition = { name: panelName, members };
		try {
			const file = await saveUserPanel(panel);
			ctx.ui.notify(`Saved global panel "${panelName}" to ${file}. Review task packet before running.`, "info");
			return { panelName, file };
		} catch (error) {
			if (error instanceof PanelNameCollisionError) {
				const replace = await ctx.ui.confirm(
					"Replace global scrutiny panel?",
					`Panel "${panelName}" already exists in ~/.pi/agent/scrutiny.json. Replace its model lineup?`,
				);
				if (!replace) continue;
				try {
					const file = await saveUserPanel(panel, { overwrite: true });
					ctx.ui.notify(`Replaced global panel "${panelName}" in ${file}. Review task packet before running.`, "info");
					return { panelName, file };
				} catch (saveError) {
					ctx.ui.notify(`Panel not saved: ${saveError instanceof Error ? saveError.message : String(saveError)}`, "error");
					return null;
				}
			}
			ctx.ui.notify(`Panel not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
			return null;
		}
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
	) {
		this.tui = tui;
		this.theme = theme;
		this.models = models;
		this.maxMembers = maxMembers;
		this.done = done;
		this.filtered = models;
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
				const thinking = selected ? accent(`think:${selected.thinking}`) : dim("not selected");
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
		const current = model.thinkingLevels.indexOf(selected.thinking);
		selected.thinking = model.thinkingLevels[(current + delta + model.thinkingLevels.length) % model.thinkingLevels.length]!;
		this.message = "";
	}

	private members(): PanelMember[] {
		return [...this.selected.entries()]
			.sort((left, right) => left[1].order - right[1].order)
			.map(([model, selection]) => ({ model, thinking: selection.thinking }));
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
