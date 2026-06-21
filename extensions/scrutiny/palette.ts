import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SCRUTINY_SURFACES, SURFACE_DEFAULTS, readEnvConfig } from "./config.js";
import { panelRoles } from "./packet.js";
import type { ScrutinyParams, ScrutinySurface } from "./types.js";
import { formatTokens } from "./util.js";

const JUDGE_MODES: Array<NonNullable<ScrutinyParams["judgeMode"]>> = ["auto", "off", "on"];

type SurfaceHint = { produces: string; flow: string };

const SURFACE_HINTS: Record<ScrutinySurface, SurfaceHint> = {
	consult: { produces: "produces a synthesized analysis (research/synthesis)", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	hypotheses: { produces: "produces ranked root causes + distinguishing tests, not a fix", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	criteria: { produces: "produces an acceptance spec to implement against, not a patch", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	"repo-map": { produces: "produces a compact repo map for an upcoming edit, not an answer", flow: "↳ runs inline; streams status while the panel works; esc cancels" },
	risks: { produces: "produces per-class risk findings + suggested checks, not a merged patch", flow: "↳ runs inline; panel then verify; esc cancels" },
	verify: { produces: "produces objective pass/fail (tests, typecheck, lint). the arbiter", flow: "↳ runs inline; blocks until checks finish; esc cancels" },
};

type PaletteState = {
	prompt: string;
	surface: ScrutinySurface;
	surfaceLocked: boolean;
	judgeMode: NonNullable<ScrutinyParams["judgeMode"]>;
	includeGitDiff: boolean;
	verify: boolean;
	panelCount: number;
	showHelp: boolean;
};

export async function showScrutinyPalette(ctx: ExtensionCommandContext, initialPrompt = ""): Promise<ScrutinyParams | null> {
	const config = readEnvConfig();
	const maxPanel = Math.max(0, Math.min(config.panel.length, config.maxPanelModels));
	const initialSurface = inferPaletteSurface(initialPrompt);
	const state: PaletteState = {
		prompt: initialPrompt,
		surface: initialSurface,
		surfaceLocked: Boolean(initialPrompt),
		judgeMode: SURFACE_DEFAULTS[initialSurface].judgeMode,
		includeGitDiff: SURFACE_DEFAULTS[initialSurface].includeGitDiff,
		verify: SURFACE_DEFAULTS[initialSurface].verify,
		panelCount: initialSurface === "verify" ? 0 : Math.min(SURFACE_DEFAULTS[initialSurface].panelCount, Math.max(1, maxPanel)),
		showHelp: false,
	};

	return ctx.ui.custom<ScrutinyParams | null>(
		(tui, theme, _kb, done) => new ScrutinyPalette(tui, theme, config.panel.slice(0, config.maxPanelModels), state, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "74%",
				minWidth: 68,
				maxHeight: "82%",
				margin: 1,
			},
		},
	);
}

class ScrutinyPalette implements Component, Focusable {
	focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly panelModels: string[],
		private readonly state: PaletteState,
		private readonly done: (value: ScrutinyParams | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			const prompt = this.state.prompt.trim();
			if (!prompt) return;
			if (this.state.surface !== "verify" && this.state.panelCount === 0) return;
			this.done({
				prompt,
				surface: this.state.surface,
				judgeMode: this.state.judgeMode,
				panel: this.state.surface === "verify" ? undefined : this.panelModels.slice(0, this.state.panelCount),
				includeGitDiff: this.state.includeGitDiff,
				verify: this.state.verify,
			});
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
			this.cycleSurface(1);
			return this.rerender();
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) {
			this.cycleSurface(-1);
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("j")) && this.state.surface !== "verify") {
			this.cycleJudge();
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("g"))) {
			this.state.includeGitDiff = !this.state.includeGitDiff;
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("p")) && this.state.surface !== "verify") {
			this.cyclePanelCount();
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("v")) && this.state.surface !== "verify") {
			this.state.verify = !this.state.verify;
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.state.prompt = "";
			this.state.surfaceLocked = false;
			this.state.surface = "consult";
			this.applySurfaceDefaults();
			return this.rerender();
		}
		if (matchesKey(data, Key.ctrl("w"))) {
			this.state.prompt = this.state.prompt.replace(/\s*\S+\s*$/, "");
			this.syncInferredSurface();
			return this.rerender();
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.state.prompt = this.state.prompt.slice(0, -1);
			this.syncInferredSurface();
			return this.rerender();
		}
		if (data === "?") {
			this.state.showHelp = !this.state.showHelp;
			return this.rerender();
		}
		if (isPrintable(data)) {
			this.state.prompt += data.replace(/[\r\n\t]/g, " ");
			this.syncInferredSurface();
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
		const title = `${accent("pi-scrutiny")} ${dim("telescope")}`;
		const hint = SURFACE_HINTS[this.state.surface];

		lines.push(topBorder(w, title, this.theme));
		lines.push(frameLine(this.inputLine(w - 4), w, this.theme));
		lines.push(frameLine(this.chipLine(), w, this.theme));
		lines.push(frameLine(`${accent("▸")} ${dim(hint.produces)}`, w, this.theme));
		lines.push(frameLine(`${accent("↳")} ${dim(hint.flow)}`, w, this.theme));
		lines.push(midBorder(w, this.theme));

		if (this.state.surface === "verify") {
			lines.push(frameLine(`${ok("◆")} ${dim("objective arbiter · no panel · no judge")}`, w, this.theme));
			const config = readEnvConfig();
			lines.push(frameLine(`${dim("checks:")} ${accent(config.verifyChecks.map((c) => c.name).join(", ") || "none")}`, w, this.theme));
		} else {
			lines.push(frameLine(`${accent("lenses")} ${dim("independent panel, not a vote; do not fuse patches")}`, w, this.theme));
			const roles = panelRoles(this.panelModels.slice(0, this.state.panelCount), this.state.surface);
			if (roles.length === 0) {
				lines.push(frameLine(`${this.theme.fg("error", "×")} panel missing ${dim("set PI_SCRUTINY_PANEL=provider/model,provider/model")}`, w, this.theme));
			} else {
				for (const [index, item] of roles.entries()) {
					const icon = index === 0 ? ok("●") : accent("●");
					lines.push(frameLine(` ${icon} ${padRight(shortModel(item.model), 24)} ${dim(item.role)}`, w, this.theme));
				}
			}
		}

		lines.push(frameLine("", w, this.theme));
		lines.push(frameLine(this.budgetLine(), w, this.theme));

		if (this.state.showHelp) {
			lines.push(midBorder(w, this.theme));
			for (const line of [
				"enter run · esc cancel",
				"tab/↓ surface · shift-tab/↑ previous surface",
				"ctrl+j explainer · ctrl+g git diff · ctrl+p panel size · ctrl+v verify",
				"ctrl+u clear · ctrl+w delete word · ? hide help",
			]) lines.push(frameLine(dim(line), w, this.theme));
		} else {
			lines.push(midBorder(w, this.theme));
			lines.push(frameLine(dim("enter run · esc cancel · tab surface · ^j explainer · ^g git · ^p panel · ^v verify · ? help"), w, this.theme));
		}
		lines.push(bottomBorder(w, this.theme));
		return lines;
	}

	invalidate(): void {}

	private inputLine(width: number): string {
		const label = this.theme.fg("muted", "task › ");
		const empty = this.theme.fg("dim", "describe problem for panel...");
		const prompt = this.state.prompt ? this.state.prompt : empty;
		const cursor = this.focused ? `${CURSOR_MARKER}${this.theme.bg("selectedBg", " ")}` : "";
		return truncateToWidth(`${label}${prompt}${cursor}`, width);
	}

	private chipLine(): string {
		const chips = [chip(this.theme, this.state.surface, this.state.surfaceLocked ? "accent" : "muted")];
		if (this.state.surface !== "verify") {
			chips.push(chip(this.theme, `panel ${this.state.panelCount}/${this.panelModels.length}`, this.state.panelCount ? "success" : "error"));
			chips.push(chip(this.theme, `explainer:${this.state.judgeMode}`, this.state.judgeMode === "on" ? "warning" : "muted"));
		}
		chips.push(chip(this.theme, `git:${this.state.includeGitDiff ? "on" : "off"}`, this.state.includeGitDiff ? "warning" : "muted"));
		if (this.state.surface !== "verify") chips.push(chip(this.theme, `verify:${this.state.verify ? "on" : "off"}`, this.state.verify ? "warning" : "muted"));
		chips.push(chip(this.theme, this.estimateChip(), "accent"));
		return chips.join(" ");
	}

	private budgetLine(): string {
		const packetTokens = this.estimatedPacketTokens();
		const panelCount = this.state.surface === "verify" ? 0 : this.state.panelCount;
		const replicated = packetTokens * Math.max(1, panelCount);
		const prefix = this.theme.fg("accent", "budget");
		const git = this.state.includeGitDiff ? " · git diff estimate included" : "";
		if (this.state.surface === "verify") return `${prefix} objective checks only · no panel tokens${git}`;
		return `${prefix} packet ~${formatTokens(packetTokens)} tok × ${panelCount} = ~${formatTokens(replicated)} replicated input${git}`;
	}

	private estimateChip(): string {
		const packetTokens = this.estimatedPacketTokens();
		const panelCount = this.state.surface === "verify" ? 0 : this.state.panelCount;
		return this.state.surface === "verify" ? "0 panel" : `~${formatTokens(packetTokens)}×${panelCount} tok`;
	}

	private estimatedPacketTokens(): number {
		const baseChars = this.state.prompt.length + 1_800 + (this.state.includeGitDiff ? 6_000 : 0);
		return Math.max(1, Math.ceil(baseChars / 4));
	}

	private cycleSurface(delta: number): void {
		const index = SCRUTINY_SURFACES.indexOf(this.state.surface);
		this.state.surface = SCRUTINY_SURFACES[(index + delta + SCRUTINY_SURFACES.length) % SCRUTINY_SURFACES.length]!;
		this.state.surfaceLocked = true;
		this.applySurfaceDefaults();
	}

	private applySurfaceDefaults(): void {
		const defaults = SURFACE_DEFAULTS[this.state.surface];
		this.state.judgeMode = defaults.judgeMode;
		this.state.includeGitDiff = defaults.includeGitDiff;
		this.state.verify = defaults.verify;
		if (this.state.surface === "verify") {
			this.state.panelCount = 0;
		} else {
			const maxPanel = Math.max(1, this.panelModels.length);
			this.state.panelCount = Math.min(defaults.panelCount, maxPanel);
		}
	}

	private cycleJudge(): void {
		const index = JUDGE_MODES.indexOf(this.state.judgeMode);
		this.state.judgeMode = JUDGE_MODES[(index + 1) % JUDGE_MODES.length]!;
	}

	private cyclePanelCount(): void {
		if (this.panelModels.length === 0) return;
		this.state.panelCount = (this.state.panelCount % this.panelModels.length) + 1;
	}

	private syncInferredSurface(): void {
		if (!this.state.surfaceLocked) {
			const inferred = inferPaletteSurface(this.state.prompt);
			if (inferred !== this.state.surface) {
				this.state.surface = inferred;
				this.applySurfaceDefaults();
			}
		}
	}

	private rerender(): void {
		this.tui.requestRender();
	}
}

function inferPaletteSurface(prompt: string): ScrutinySurface {
	const text = prompt.toLowerCase();
	if (/\b(verify|typecheck|lint|run tests|test suite|does it pass|check the build|ci)\b/.test(text)) return "verify";
	if (/\b(risk|review the patch|review this change|concurrency|race|reactive|idempoten|circuit.?breaker|security review)\b/.test(text)) return "risks";
	if (/\b(root cause|why does|debug|intermittent|flaky|bug in|what is causing)\b/.test(text)) return "hypotheses";
	if (/\b(acceptance criter|edge case|backward.?compat|migrat|spec for|definition of done)\b/.test(text)) return "criteria";
	if (/\b(repo map|where is|call path|callers of|symbols|trace|how does .* work|navigate the code)\b/.test(text)) return "repo-map";
	return "consult";
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
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${theme.fg("borderMuted", "│ ")}${clipped}${padding}${theme.fg("borderMuted", " │")}`;
}

function padRight(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function shortModel(model: string): string {
	const parts = model.split("/");
	return parts.at(-1) ?? model;
}

function isPrintable(data: string): boolean {
	return data.length > 0 && !/^\x1b/.test(data) && [...data].every((char) => char >= " " || char === "\n" || char === "\t");
}
