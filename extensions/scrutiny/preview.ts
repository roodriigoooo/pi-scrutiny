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
	scout?: string;
	scoutCandidates: string[];
	priorCount: number;
	possibleGaps: string[];
};

type CandidateBlock = {
	id: number;
	title: string;
	lines: string[];
	start: number;
	end: number;
};

class PacketPreview implements Component {
	private showPacket = false;
	private selected = 0;
	private readonly candidates: CandidateBlock[];
	private readonly disabled = new Set<number>();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly input: PacketPreviewInput,
		private readonly done: (value: string | null) => void,
	) {
		this.candidates = extractCandidateBlocks(input.packet);
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
				if (this.disabled.has(candidate.id)) this.disabled.delete(candidate.id);
				else this.disabled.add(candidate.id);
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
		const stats = analyzePacket(packet, this.input.panelCount);
		const enabledCount = this.candidates.length - this.disabled.size;

		lines.push(topBorder(w, `${accent("scrutiny packet preview")} ${dim(this.input.runId)}`, this.theme));
		lines.push(frameLine(`${accent(this.input.surface)} ${dim("pre-spend gate · exact packet built, panel not started")}`, w, this.theme));
		lines.push(frameLine(`${accent("budget")} packet ~${formatTokens(stats.packetTokens)} tok × ${this.input.panelCount} panel = ~${formatTokens(stats.replicatedTokens)} replicated input${this.input.judgeRan ? dim(" · map reads outputs") : dim(" · map off")}${this.input.verifyRan ? warning(" · verify after panel") : ""}`, w, this.theme));
		lines.push(frameLine(`${dim("sections")} ${stats.sections.slice(0, 7).join(" · ") || "none"}${stats.sections.length > 7 ? ` · +${stats.sections.length - 7}` : ""}`, w, this.theme));
		lines.push(midBorder(w, this.theme));

		lines.push(frameLine(`${accent("included")} scout candidates ${enabledCount}/${this.candidates.length} · prior runs ${stats.priorCount} · git ${stats.hasGit ? success("on") : dim("off")}`, w, this.theme));
		if (this.candidates.length === 0) {
			lines.push(frameLine(dim("  no toggleable scout candidates in packet"), w, this.theme));
		} else {
			for (const item of visibleWindow(this.candidates, this.selected, 7)) {
				const candidate = item.row;
				const selected = item.index === this.selected;
				const enabled = !this.disabled.has(candidate.id);
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
		if (this.disabled.size === 0) return this.input.packet;
		return applyCandidatePruning(this.input.packet, this.candidates, this.disabled);
	}

	private rerender(): void {
		this.tui.requestRender();
	}
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
	else if (/preview pruning: all scout candidates hidden/i.test(scout)) possibleGaps.push("all scout candidates pruned before panel run");
	if (scout && scoutCandidates.length > 10) possibleGaps.push("many scout candidates; consider narrower scope if result feels noisy");
	if (scout && !/test file|tests?\//i.test(scout)) possibleGaps.push("no obvious tests surfaced by scout");
	if (scout && !/doc\/config path|README|CONTEXT|docs\//i.test(scout)) possibleGaps.push("no docs/config/project-frame snippets surfaced yet");
	if (!hasGit) possibleGaps.push("git diff not included for this surface/run");
	return { packetTokens, replicatedTokens: packetTokens * Math.max(1, panelCount), sections, hasGit, scout, scoutCandidates, priorCount, possibleGaps };
}

function extractCandidateBlocks(packet: string): CandidateBlock[] {
	const lines = packet.split(/\r?\n/);
	const scoutStart = lines.findIndex((line) => line.trim() === "## Context scout");
	if (scoutStart < 0) return [];
	const scoutEnd = lines.findIndex((line, index) => index > scoutStart && /^##\s+/.test(line));
	const end = scoutEnd < 0 ? lines.length : scoutEnd;
	const candidates: CandidateBlock[] = [];
	for (let i = scoutStart + 1; i < end; i++) {
		if (!lines[i].trim().startsWith("- ")) continue;
		let blockEnd = i + 1;
		while (blockEnd < end && !lines[blockEnd].trim().startsWith("- ") && !/^#{2,3}\s+/.test(lines[blockEnd])) blockEnd++;
		const blockLines = lines.slice(i, blockEnd);
		candidates.push({
			id: i,
			title: truncate(blockLines.join(" ").replace(/^-\s+/, "").replace(/\s+/g, " "), 180),
			lines: blockLines,
			start: i,
			end: blockEnd,
		});
	}
	return candidates;
}

function applyCandidatePruning(packet: string, candidates: CandidateBlock[], disabled: Set<number>): string {
	const lines = packet.split(/\r?\n/);
	const remove = new Set<number>();
	for (const candidate of candidates) {
		if (!disabled.has(candidate.id)) continue;
		for (let i = candidate.start; i < candidate.end; i++) remove.add(i);
	}
	const output: string[] = [];
	let noteInserted = false;
	for (let i = 0; i < lines.length; i++) {
		if (remove.has(i)) continue;
		output.push(lines[i]);
		if (!noteInserted && lines[i].trim() === "### Candidate context") {
			const hidden = disabled.size;
			const all = hidden >= candidates.length;
			output.push(all ? `preview pruning: all scout candidates hidden before panel run.` : `preview pruning: ${hidden} scout candidate(s) hidden before panel run.`);
			noteInserted = true;
		}
	}
	return output.join("\n");
}

function visibleWindow<T>(items: T[], selected: number, size: number): Array<{ row: T; index: number }> {
	const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
	return items.slice(start, start + size).map((row, offset) => ({ row, index: start + offset }));
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
		.filter((line) => /^#|^surface:|^cwd:|^anchors:|^files:|^symbols:|^terms:|^preview pruning:|^- /.test(line.trim()))
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
