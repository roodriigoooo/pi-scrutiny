import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ScrutinySurface } from "./types.js";
import { formatTokens, truncate } from "./util.js";

export type PacketPreviewInput = {
	runId: string;
	surface: ScrutinySurface;
	packet: string;
	panelCount: number;
	judgeRan: boolean;
	verifyRan: boolean;
};

export async function confirmPacketPreview(ctx: ExtensionCommandContext, input: PacketPreviewInput): Promise<boolean> {
	return ctx.ui.custom<boolean>(
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
	scout?: string;
	scoutCandidates: string[];
	priorCount: number;
	possibleGaps: string[];
};

class PacketPreview implements Component {
	private showPacket = false;
	private readonly stats: PacketStats;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly input: PacketPreviewInput,
		private readonly done: (value: boolean) => void,
	) {
		this.stats = analyzePacket(input.packet, input.panelCount);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) return this.done(true);
		if (matchesKey(data, Key.escape)) return this.done(false);
		if (matchesKey(data, Key.ctrl("o")) || matchesKey(data, Key.tab)) {
			this.showPacket = !this.showPacket;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const w = Math.max(60, width);
		const lines: string[] = [];
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const success = (s: string) => this.theme.fg("success", s);
		const stats = this.stats;

		lines.push(topBorder(w, `${accent("scrutiny packet preview")} ${dim(this.input.runId)}`, this.theme));
		lines.push(frameLine(`${accent(this.input.surface)} ${dim("pre-spend gate · exact packet built, panel not started")}`, w, this.theme));
		lines.push(frameLine(`${accent("budget")} packet ~${formatTokens(stats.packetTokens)} tok × ${this.input.panelCount} panel = ~${formatTokens(stats.replicatedTokens)} replicated input${this.input.judgeRan ? dim(" · map reads outputs") : dim(" · map off")}${this.input.verifyRan ? warning(" · verify after panel") : ""}`, w, this.theme));
		lines.push(frameLine(`${dim("sections")} ${stats.sections.slice(0, 7).join(" · ") || "none"}${stats.sections.length > 7 ? ` · +${stats.sections.length - 7}` : ""}`, w, this.theme));
		lines.push(midBorder(w, this.theme));

		lines.push(frameLine(`${accent("included")} scout candidates ${stats.scoutCandidates.length} · prior runs ${stats.priorCount} · git ${stats.hasGit ? success("on") : dim("off")}`, w, this.theme));
		for (const candidate of stats.scoutCandidates.slice(0, 6)) lines.push(frameLine(`  ${dim("•")} ${candidate}`, w, this.theme));
		if (stats.scoutCandidates.length > 6) lines.push(frameLine(dim(`  +${stats.scoutCandidates.length - 6} more candidates`), w, this.theme));
		if (stats.scoutCandidates.length === 0) lines.push(frameLine(dim("  no scout candidates in packet"), w, this.theme));

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
			for (const line of packetExcerpt(this.input.packet).slice(0, 12)) lines.push(frameLine(dim(line), w, this.theme));
		}

		lines.push(midBorder(w, this.theme));
		lines.push(frameLine(dim("enter run · esc cancel · tab/^o inspect packet excerpt"), w, this.theme));
		lines.push(bottomBorder(w, this.theme));
		return lines;
	}

	invalidate(): void {}
}

function analyzePacket(packet: string, panelCount: number): PacketStats {
	const packetTokens = Math.ceil(packet.length / 4);
	const sections = [...packet.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
	const hasGit = /^## Git working tree$/m.test(packet);
	const scout = section(packet, "Context scout");
	const scoutCandidates = scout ? scout.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => truncate(line.replace(/^-\s+/, ""), 180)) : [];
	const priorCount = scoutCandidates.filter((line) => /\[prior;/.test(line)).length;
	const possibleGaps: string[] = [];
	if (!scout) possibleGaps.push("no context scout section found");
	else if (/skipped: no .*anchor/i.test(scout)) possibleGaps.push("no anchors found; packet may be too abstract");
	else if (/no local candidates found/i.test(scout)) possibleGaps.push("anchors found, but no local candidates matched");
	if (scout && scoutCandidates.length > 10) possibleGaps.push("many scout candidates; consider narrower scope if result feels noisy");
	if (scout && !/test file|tests?\//i.test(scout)) possibleGaps.push("no obvious tests surfaced by scout");
	if (scout && !/doc\/config path|README|CONTEXT|docs\//i.test(scout)) possibleGaps.push("no docs/config/project-frame snippets surfaced yet");
	if (!hasGit) possibleGaps.push("git diff not included for this surface/run");
	return { packetTokens, replicatedTokens: packetTokens * Math.max(1, panelCount), sections, hasGit, scout, scoutCandidates, priorCount, possibleGaps };
}

function section(packet: string, heading: string): string | undefined {
	const lines = packet.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
	if (start < 0) return undefined;
	const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
	return lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
}

function packetExcerpt(packet: string): string[] {
	return packet
		.split(/\r?\n/)
		.filter((line) => /^#|^surface:|^cwd:|^anchors:|^files:|^symbols:|^terms:|^- /.test(line.trim()))
		.map((line) => truncate(line, 220));
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
