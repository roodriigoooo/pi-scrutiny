import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readScrutinyConfig } from "./config.js";
import { allTemplates, resolveRunPlan, strategyPlainLanguage } from "./templates.js";
import { inferSurface, SURFACE_HINTS } from "./surfaces.js";
import type { JudgeMode, ResolvedRunPlan, ScrutinyConfig, ScrutinyParams } from "./types.js";
import { formatTokens } from "./util.js";

const JUDGE_MODES: JudgeMode[] = ["auto", "off", "on"];

type PaletteState = {
	prompt: string;
	templateIndex: number;
	panelIndex: number;
	includeGitDiff?: boolean;
	judgeMode?: JudgeMode;
	verify?: boolean;
	showHelp: boolean;
};

export async function showScrutinyPalette(ctx: ExtensionCommandContext, initialPrompt = ""): Promise<ScrutinyParams | null> {
	const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
	const templates = allTemplates(config);
	const inferred = inferSurface(initialPrompt);
	const state: PaletteState = {
		prompt: initialPrompt,
		templateIndex: Math.max(0, templates.findIndex((template) => template.name === inferred)),
		panelIndex: 0,
		showHelp: false,
	};
	return ctx.ui.custom<ScrutinyParams | null>(
		(tui, theme, _kb, done) => new ScrutinyPalette(tui, theme, config, templates, state, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "74%", minWidth: 68, maxHeight: "82%", margin: 1 },
		},
	);
}

class ScrutinyPalette implements Component, Focusable {
	focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly config: ScrutinyConfig,
		private readonly templates: ScrutinyConfig["templates"],
		private readonly state: PaletteState,
		private readonly done: (value: ScrutinyParams | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			const prompt = this.state.prompt.trim();
			const template = this.activeTemplate();
			const plan = this.plan();
			if (!prompt || !template || !plan) return;
			this.done({
				prompt,
				template: template.name,
				...(plan.panel ? { panel: plan.panel.name } : {}),
				...(this.state.judgeMode === undefined ? {} : { judgeMode: this.state.judgeMode }),
				...(this.state.includeGitDiff === undefined ? {} : { includeGitDiff: this.state.includeGitDiff }),
				...(this.state.verify === undefined ? {} : { verify: this.state.verify }),
			});
			return;
		}
		if (matchesKey(data, Key.escape)) return this.done(null);
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) return this.cycleTemplate(1);
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) return this.cycleTemplate(-1);
		if (matchesKey(data, Key.ctrl("p"))) return this.cyclePanel();
		if (matchesKey(data, Key.ctrl("j"))) return this.cycleJudge();
		if (matchesKey(data, Key.ctrl("g"))) return this.toggleGit();
		if (matchesKey(data, Key.ctrl("v"))) return this.toggleVerify();
		if (matchesKey(data, Key.ctrl("u"))) {
			this.state.prompt = "";
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("w"))) {
			this.state.prompt = this.state.prompt.replace(/\s*\S+\s*$/, "");
			return this.rerender();
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.state.prompt = this.state.prompt.slice(0, -1);
			return this.rerender();
		}
		if (data === "?") {
			this.state.showHelp = !this.state.showHelp;
			return this.rerender();
		}
		if (isPrintable(data)) {
			this.state.prompt += data.replace(/[\r\n\t]/g, " ");
			return this.rerender();
		}
	}

	render(width: number): string[] {
		const w = Math.max(50, width);
		const lines: string[] = [];
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const warn = (s: string) => this.theme.fg("warning", s);
		const ok = (s: string) => this.theme.fg("success", s);
		const template = this.activeTemplate();
		const plan = this.plan();
		const surface = template?.surface ?? "consult";
		const hint = SURFACE_HINTS[surface];

		lines.push(topBorder(w, `${accent("pi-scrutiny")} ${dim("telescope")}`, this.theme));
		lines.push(frameLine(this.inputLine(w - 4), w, this.theme));
		lines.push(frameLine(this.chipLine(plan), w, this.theme));
		lines.push(frameLine(`${accent("▸")} ${dim(hint.produces)}`, w, this.theme));
		lines.push(frameLine(`${accent("↳")} ${dim(hint.flow)}`, w, this.theme));
		lines.push(midBorder(w, this.theme));

		if (!template) {
			lines.push(frameLine(this.theme.fg("error", "× no templates are available"), w, this.theme));
		} else if (!plan) {
			lines.push(frameLine(this.theme.fg("error", `× ${this.planError() ?? "incompatible template/panel"}`), w, this.theme));
		} else if (!plan.panel) {
			lines.push(frameLine(`${ok("◆")} ${dim("objective arbiter · no panel · no judge")}`, w, this.theme));
			lines.push(frameLine(`${dim("checks:")} ${accent(this.verifyCheckNames())}`, w, this.theme));
		} else {
			lines.push(frameLine(`${accent("strategy")} ${dim(strategyPlainLanguage(plan.strategy))}`, w, this.theme));
			for (const [index, assignment] of plan.assignments.entries()) {
				const icon = index === 0 ? ok("●") : accent("●");
				const role = plan.strategy === "replicate" ? "same prompt" : assignment.lens ?? "missing lens";
				const thinking = assignment.thinking ? ` ${this.theme.fg("muted", `think:${assignment.thinking}`)}` : "";
				lines.push(frameLine(` ${icon} ${padRight(shortModel(assignment.model), 24)} ${dim(role)}${thinking}`, w, this.theme));
			}
			if (plan.unassignedLenses.length) lines.push(frameLine(warn(`! ${plan.unassignedLenses.length} unassigned lens${plan.unassignedLenses.length === 1 ? "" : "es"}: ${plan.unassignedLenses.join(", ")}`), w, this.theme));
		}

		if (this.config.diagnostics.length) {
			lines.push(frameLine(warn(`migration: ${this.config.diagnostics[0]!.split("\n")[0]}`), w, this.theme));
		}
		lines.push(frameLine("", w, this.theme));
		lines.push(frameLine(this.budgetLine(plan), w, this.theme));
		lines.push(midBorder(w, this.theme));
		const help = this.state.showHelp
			? [
				"enter review packet · esc cancel",
				"tab/↓ template · shift-tab/↑ previous template · ctrl+p panel",
				"ctrl+j evidence map · ctrl+g git diff · ctrl+v verify",
				"template and panel selections are independent",
			]
			: ["enter review packet · esc cancel · tab template · ^p panel · ^j map · ^g git · ^v verify · ? help"];
		for (const line of help) lines.push(frameLine(dim(line), w, this.theme));
		lines.push(bottomBorder(w, this.theme));
		return lines;
	}

	invalidate(): void {}

	private activeTemplate(): ScrutinyConfig["templates"][number] | undefined {
		return this.templates[this.state.templateIndex];
	}

	private selectedPanelName(): string | undefined {
		return this.config.panels[this.state.panelIndex]?.name;
	}

	private plan(): ResolvedRunPlan | undefined {
		const template = this.activeTemplate();
		if (!template) return undefined;
		try {
			return resolveRunPlan({
				templateName: template.name,
				panelName: this.selectedPanelName(),
				includeGitDiff: this.state.includeGitDiff,
				judgeMode: this.state.judgeMode,
				verify: this.state.verify,
			}, this.config);
		} catch {
			return undefined;
		}
	}

	private planError(): string | undefined {
		const template = this.activeTemplate();
		if (!template) return undefined;
		try {
			resolveRunPlan({
				templateName: template.name,
				panelName: this.selectedPanelName(),
				includeGitDiff: this.state.includeGitDiff,
				judgeMode: this.state.judgeMode,
				verify: this.state.verify,
			}, this.config);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	private inputLine(width: number): string {
		const label = this.theme.fg("muted", "task › ");
		const empty = this.theme.fg("dim", "describe problem for template...");
		const prompt = this.state.prompt || empty;
		const cursor = this.focused ? `${CURSOR_MARKER}${this.theme.bg("selectedBg", " ")}` : "";
		return truncateToWidth(`${label}${prompt}${cursor}`, width);
	}

	private chipLine(plan: ResolvedRunPlan | undefined): string {
		const template = this.activeTemplate();
		const chips = [chip(this.theme, `template:${template?.name ?? "none"}`, "accent")];
		if (plan?.panel) chips.push(chip(this.theme, `panel:${plan.panel.name}`, "success"));
		else if (template?.surface !== "verify") chips.push(chip(this.theme, `panel:${this.selectedPanelName() ?? "none"}`, "error"));
		if (plan?.strategy) chips.push(chip(this.theme, plan.strategy, plan.strategy === "replicate" ? "accent" : "muted"));
		if (plan) {
			chips.push(chip(this.theme, `map:${plan.policies.judgeMode}`, plan.policies.judgeMode === "off" ? "muted" : "warning"));
			chips.push(chip(this.theme, `git:${plan.policies.includeGitDiff ? "on" : "off"}`, plan.policies.includeGitDiff ? "warning" : "muted"));
			if (plan.strategy) chips.push(chip(this.theme, `verify:${plan.policies.verify ? "on" : "off"}`, plan.policies.verify ? "warning" : "muted"));
			if (plan.unassignedLenses.length) chips.push(chip(this.theme, `unassigned:${plan.unassignedLenses.length}`, "warning"));
			chips.push(chip(this.theme, this.estimateChip(plan), "accent"));
		}
		return chips.join(" ");
	}

	private budgetLine(plan: ResolvedRunPlan | undefined): string {
		if (!plan) return this.theme.fg("error", "budget unavailable until template and panel are compatible");
		if (!plan.strategy) return `${this.theme.fg("accent", "budget")} objective checks only · no panel tokens`;
		const packetTokens = this.estimatedPacketTokens(plan.policies.includeGitDiff);
		return `${this.theme.fg("accent", "budget")} packet ~${formatTokens(packetTokens)} tok × ${plan.assignments.length} = ~${formatTokens(packetTokens * plan.assignments.length)} replicated input${plan.policies.includeGitDiff ? " · git diff estimate included" : ""}`;
	}

	private estimateChip(plan: ResolvedRunPlan): string {
		if (!plan.strategy) return "0 panel";
		return `~${formatTokens(this.estimatedPacketTokens(plan.policies.includeGitDiff))}×${plan.assignments.length} tok`;
	}

	private estimatedPacketTokens(includeGitDiff: boolean): number {
		return Math.max(1, Math.ceil((this.state.prompt.length + 1_800 + (includeGitDiff ? 6_000 : 0)) / 4));
	}

	private verifyCheckNames(): string {
		return this.config.verifyChecks.map((check) => check.name).join(", ") || "none";
	}

	private cycleTemplate(delta: number): void {
		if (this.templates.length) this.state.templateIndex = (this.state.templateIndex + delta + this.templates.length) % this.templates.length;
		this.rerender();
	}

	private cyclePanel(): void {
		if (this.config.panels.length) this.state.panelIndex = (this.state.panelIndex + 1) % this.config.panels.length;
		this.rerender();
	}

	private cycleJudge(): void {
		const current = this.plan()?.policies.judgeMode ?? "off";
		this.state.judgeMode = JUDGE_MODES[(JUDGE_MODES.indexOf(current) + 1) % JUDGE_MODES.length]!;
		this.rerender();
	}

	private toggleGit(): void {
		this.state.includeGitDiff = !(this.plan()?.policies.includeGitDiff ?? false);
		this.rerender();
	}

	private toggleVerify(): void {
		const plan = this.plan();
		if (!plan?.strategy) return;
		this.state.verify = !plan.policies.verify;
		this.rerender();
	}

	private rerender(): void {
		this.tui.requestRender();
	}
}

function chip(theme: Theme, text: string, color: "accent" | "muted" | "success" | "warning" | "error"): string {
	return theme.fg(color, `[${text}]`);
}

function topBorder(width: number, title: string, theme: Theme): string {
	const plain = `╭─ ${title} `;
	return theme.fg("borderAccent", truncateToWidth(`${plain}${"─".repeat(width)}`, width - 1, "")) + theme.fg("borderAccent", "╮");
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

function padRight(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function shortModel(model: string): string {
	return model.split("/").at(-1) ?? model;
}

function isPrintable(data: string): boolean {
	return data.length > 0 && !/^\x1b/.test(data) && [...data].every((char) => char >= " " || char === "\n" || char === "\t");
}
