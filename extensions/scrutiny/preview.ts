import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DeliberationStrategy, ResolvedPanelAssignment, ScoutCandidate, ScoutReport, ScrutinySurface } from "./types.js";
import { pruneScoutCandidates } from "./scout.js";
import { formatTokens } from "./util.js";

export type PacketPreviewInput = {
	runId: string;
	surface: ScrutinySurface;
	template: string;
	panelName?: string;
	strategy?: DeliberationStrategy;
	assignments: ReadonlyArray<ResolvedPanelAssignment>;
	unassignedLenses: readonly string[];
	includeGitDiff: boolean;
	packet: string;
	scout?: ScoutReport;
	panelCount: number;
	judgeRan: boolean;
	verifyRan: boolean;
};

export async function confirmPacketPreview(ctx: ExtensionCommandContext, input: PacketPreviewInput): Promise<string | null> {
	return ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => new PacketPreview(tui, theme, input, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "76%",
				minWidth: 72,
				maxHeight: "84%",
				margin: 1,
			},
		},
	);
}

type PacketStats = {
	packetTokens: number;
	replicatedTokens: number;
	sections: string[];
	hasGit: boolean;
	candidateCount: number;
	priorCount: number;
	possibleGaps: string[];
};

class PacketPreview implements Component {
	private showPacket = false;
	private selected = 0;
	private readonly candidates: ScoutCandidate[];
	private readonly excluded = new Set<string>();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly input: PacketPreviewInput,
		private readonly done: (value: string | null) => void,
	) {
		this.candidates = input.scout?.candidates ?? [];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) return this.done(this.currentPacket());
		if (matchesKey(data, Key.escape)) return this.done(null);
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			return this.rerender();
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(Math.max(0, this.candidates.length - 1), this.selected + 1);
			return this.rerender();
		}
		if (matchesKey(data, Key.space)) {
			const candidate = this.candidates[this.selected];
			if (candidate) {
				if (this.excluded.has(candidate.id)) this.excluded.delete(candidate.id);
				else this.excluded.add(candidate.id);
				return this.rerender();
			}
		}
		if (matchesKey(data, Key.ctrl("o")) || matchesKey(data, Key.tab)) {
			this.showPacket = !this.showPacket;
			return this.rerender();
		}
	}

	render(width: number): string[] {
		const w = Math.max(60, width);
		const lines: string[] = [];
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const success = (s: string) => this.theme.fg("success", s);
		const packet = this.currentPacket();
		const stats = computeStats(packet, this.input.panelCount, this.input.surface, this.input.scout, this.excluded, this.input.includeGitDiff);
		const enabledCount = this.candidates.length - this.excluded.size;

		lines.push(topBorder(w, `${accent("scrutiny packet preview")} ${dim(this.input.runId)}`, this.theme));
		lines.push(frameLine(`${accent(`template:${this.input.template}`)} ${dim(`panel:${this.input.panelName ?? "none"} · ${this.input.strategy ?? "verify"} · pre-spend gate`)}`, w, this.theme));
		lines.push(frameLine(`${accent("budget")} packet ~${formatTokens(stats.packetTokens)} tok × ${this.input.panelCount} panel = ~${formatTokens(stats.replicatedTokens)} replicated input${this.input.judgeRan ? dim(" · map reads outputs") : dim(" · map off")}${this.input.verifyRan ? warning(" · verify after panel") : ""}`, w, this.theme));
		lines.push(frameLine(`${dim("sections")} ${stats.sections.slice(0, 7).join(" · ") || "none"}${stats.sections.length > 7 ? ` · +${stats.sections.length - 7}` : ""}`, w, this.theme));
		lines.push(midBorder(w, this.theme));

		lines.push(frameLine(`${accent("included")} scout candidates ${enabledCount}/${this.candidates.length} · prior runs ${stats.priorCount} · git ${stats.hasGit ? success("on") : dim("off")}`, w, this.theme));
		if (this.input.strategy === "roles") {
			for (const assignment of this.input.assignments) lines.push(frameLine(`${dim("assignment")} ${assignment.model} → ${assignment.lens ?? "missing lens"}`, w, this.theme));
			if (this.input.unassignedLenses.length) lines.push(frameLine(warning(`unassigned lenses: ${this.input.unassignedLenses.join(", ")}`), w, this.theme));
		}
		if (this.candidates.length === 0) {
			const note = this.input.scout?.skipped ? dim("  scout skipped: no anchors found") : dim("  no toggleable scout candidates in packet");
			lines.push(frameLine(note, w, this.theme));
		} else {
			for (const item of visibleWindow(this.candidates, this.selected, 7)) {
				const candidate = item.row;
				const selected = item.index === this.selected;
				const enabled = !this.excluded.has(candidate.id);
				const prefix = selected ? accent(">") : dim(" ");
				const box = enabled ? success("[x]") : dim("[ ]");
				const text = enabled ? candidate.title : dim(candidate.title);
				lines.push(frameLine(` ${prefix} ${box} ${text}`, w, this.theme));
			}
			if (this.candidates.length > 7) lines.push(frameLine(dim(`  ↑↓ to inspect ${this.candidates.length} candidates`), w, this.theme));
		}

		lines.push(midBorder(w, this.theme));
		if (stats.possibleGaps.length) {
			lines.push(frameLine(warning("possible gaps"), w, this.theme));
			for (const gap of stats.possibleGaps.slice(0, 5)) lines.push(frameLine(`  ${warning("!")} ${gap}`, w, this.theme));
		} else {
			lines.push(frameLine(`${success("✓")} ${dim("no obvious packet-context gaps from cheap scout")}`, w, this.theme));
		}

		if (this.showPacket) {
			lines.push(midBorder(w, this.theme));
			lines.push(frameLine(accent("packet excerpt"), w, this.theme));
			for (const line of packetExcerpt(packet).slice(0, 12)) lines.push(frameLine(dim(line), w, this.theme));
		}

		lines.push(midBorder(w, this.theme));
		lines.push(frameLine(dim("enter run exact packet · esc cancel · ↑↓ select · space toggle · tab/^o inspect"), w, this.theme));
		lines.push(bottomBorder(w, this.theme));
		return lines;
	}

	invalidate(): void {}

	private currentPacket(): string {
		if (this.excluded.size === 0 || !this.input.scout) return this.input.packet;
		return pruneScoutCandidates(this.input.packet, this.input.scout, this.excluded);
	}

	private rerender(): void {
		this.tui.requestRender();
	}
}

function computeStats(packet: string, panelCount: number, surface: ScrutinySurface, scout: ScoutReport | undefined, excluded: ReadonlySet<string>, includeGitDiff: boolean): PacketStats {
	const packetTokens = Math.ceil(packet.length / 4);
	const sections = [...packet.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
	const hasGit = /^## Git working tree$/m.test(packet);
	const candidateCount = scout?.candidates.length ?? 0;
	const priorCount = scout?.priorCount ?? 0;
	const possibleGaps: string[] = [];
	if (scout?.skipped) {
		possibleGaps.push(scout.skipReason ?? "scout skipped: no anchors found");
	} else if (scout) {
		for (const gap of scout.gaps) possibleGaps.push(gap.message);
		if (scout.candidates.length > 0 && excluded.size >= scout.candidates.length) possibleGaps.push("all scout candidates pruned before panel run");
	} else if (surface !== "verify") {
		possibleGaps.push("no context scout section found");
	}
	if (!hasGit && includeGitDiff) possibleGaps.push("git diff not included for this run");
	return { packetTokens, replicatedTokens: packetTokens * Math.max(1, panelCount), sections, hasGit, candidateCount, priorCount, possibleGaps };
}

function visibleWindow<T>(items: T[], selected: number, size: number): Array<{ row: T; index: number }> {
	const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
	return items.slice(start, start + size).map((row, offset) => ({ row, index: start + offset }));
}

function packetExcerpt(packet: string): string[] {
	return packet
		.split(/\r?\n/)
		.filter((line) => /^#|^surface:|^cwd:|^anchors:|^files:|^symbols:|^terms:|^preview pruning:|^- /.test(line.trim()))
		.map((line) => {
			const trimmed = line.length > 220 ? `${line.slice(0, 220)}…` : line;
			return trimmed;
		});
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
