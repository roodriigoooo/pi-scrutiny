import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { surfaceFacts } from "./normalize.js";
import { SURFACE_DEFAULTS } from "./surfaces.js";
import type { PanelMode, ScrutinyRunProgress, ScrutinyRunResult, PanelResponse, SurfaceFacts } from "./types.js";
import { formatDuration, formatTokens, truncate } from "./util.js";

export function scrutinyStatusText(details: unknown): string {
	if (isResult(details)) {
		const ok = details.responses.filter((response) => response.status === "ok").length;
		const failed = details.failed_models.length;
		const mode = details.panel_mode ? ` ${details.panel_mode}` : "";
		const panel = details.responses.length ? ` ${ok}/${details.responses.length}` : "";
		return `scrutiny ${details.status} ${details.surface}${mode} ${formatDuration(details.durationMs)}${panel}${failed ? ` ${failed} failed` : ""}`;
	}
	if (isProgress(details)) {
		const ready = details.panel.filter((item) => item.status === "ready").length;
		const elapsed = formatDuration(Math.max(0, details.updatedAt - details.startedAt));
		const mode = details.panel_mode ? ` ${details.panel_mode}` : "";
		const panel = details.panel.length ? ` ${ready}/${details.panel.length}` : " verify";
		return `scrutiny ${details.surface}${mode} ${elapsed}${panel} ${progressPhase(details)}`;
	}
	return "scrutiny";
}

export function renderScrutinyResult(result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any, context?: any) {
	const details = result.details;
	if (isProgress(details)) return new Text(renderProgress(details, theme), 0, 0);
	if (!isResult(details)) return new Text(result.content?.[0]?.text ?? "scrutiny", 0, 0);

	if (options.expanded) {
		const markdown = renderExpandedMarkdown(details);
		return new Markdown(markdown, 0, 0, getMarkdownTheme());
	}

	const box = new Box(1, 0, (s: string) => theme.bg(details.status === "ok" ? "toolSuccessBg" : "toolErrorBg", s));
	box.addChild(new Text(renderCompactResult(details, theme), 0, 0));
	return box;
}

export function renderScrutinyCall(args: any, theme: any) {
	const surface = args?.surface ?? "consult";
	const panel = Array.isArray(args?.panel) && args.panel.length ? args.panel : undefined;
	const judgeMode = args?.judgeMode ?? "auto";
	const title = theme.fg("toolTitle", theme.bold("scrutiny_consult"));
	const bits = [chip(theme, surface, "accent"), modeChip(theme, surface), chip(theme, panel ? `${panel.length} models` : "env panel", panel ? "success" : "muted"), chip(theme, `map:${judgeMode}`, judgeMode === "on" ? "warning" : "muted")];
	return new Text(`${title} ${bits.join(" ")}`, 0, 0);
}

export function renderScrutinyMessage(message: any, { expanded }: { expanded?: boolean }, theme: any) {
	const details = message.details;
	if (!isResult(details)) return renderStaticMessage(message, theme);
	if (expanded) return new Markdown(renderExpandedMarkdown(details), 0, 0, getMarkdownTheme());
	const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
	box.addChild(new Text(renderCompactResult(details, theme), 0, 0));
	return box;
}

function renderStaticMessage(message: any, theme: any) {
	const content = String(message.content ?? "scrutiny");
	const kind = typeof message.details?.kind === "string" ? message.details.kind : inferStaticKind(content);
	const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
	const chips = staticChips(kind).map((item) => chip(theme, item, item === "env override" ? "warning" : "muted"));
	box.addChild(new Text(`${theme.fg("accent", "◆")} ${theme.bold("scrutiny")} ${theme.fg("dim", kind)} ${chips.join(" ")}`.trim(), 0, 0));
	box.addChild(new Markdown(stripFirstHeading(content), 0, 0, getMarkdownTheme()));
	return box;
}

function inferStaticKind(content: string): string {
	const first = content.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "message";
	const match = first.match(/^#\s+scrutiny\s+(\S+)/i) ?? first.match(/^#\s+pi-scrutiny/i);
	if (!match) return "message";
	return match[1]?.toLowerCase() ?? "help";
}

function stripFirstHeading(content: string): string {
	return content.replace(/^#\s+[^\n]+\n?/, "").trim() || content;
}

function staticChips(kind: string): string[] {
	switch (kind) {
		case "help":
		case "pi-scrutiny":
			return ["6 surfaces", "inline", "no patch fusion"];
		case "models":
			return ["panel", "verify", "env override"];
		case "runs":
			return ["session", "artifacts"];
		case "councils":
			return ["presets", "lenses"];
		case "config":
			return ["global", "project", "env override"];
		default:
			return [];
	}
}

function chip(theme: any, text: string, color: "accent" | "muted" | "success" | "warning" | "error"): string {
	return theme.fg(color, `[${text}]`);
}

function modeChip(theme: any, surface: string): string {
	const mode = (SURFACE_DEFAULTS as Partial<Record<string, { panelMode?: PanelMode }>>)[surface]?.panelMode;
	return mode ? chip(theme, mode, mode === "replicate" ? "accent" : "muted") : chip(theme, "no panel", "muted");
}

function progressPhase(progress: ScrutinyRunProgress): string {
	if (progress.judge?.status === "running") return "map";
	if (/verify/i.test(progress.message ?? "")) return "verify";
	if (/done/i.test(progress.message ?? "")) return "done";
	if (/failed|unusable|error/i.test(progress.message ?? "")) return "attention";
	return progress.panel.length ? "panel" : "checks";
}

export function renderScrutinyDock(progresses: ScrutinyRunProgress[], theme: any): string[] {
	if (progresses.length === 0) return [];
	const lines = [`${theme.fg("accent", "◆")} ${theme.bold("scrutiny")} ${theme.fg("dim", "esc to cancel")}`];
	for (const progress of progresses.slice(0, 1)) {
		const ready = progress.panel.filter((item) => item.status === "ready").length;
		const running = progress.panel.filter((item) => item.status === "running").length;
		const elapsed = formatDuration(Math.max(0, progress.updatedAt - progress.startedAt));
		const mode = progress.panel_mode ? ` ${progress.panel_mode}` : "";
		const status = progress.panel.length ? `${ready}/${progress.panel.length}` : "verify";
		const icon = running ? theme.fg("warning", "◐") : theme.fg("accent", "◆");
		lines.push(`  ${icon} ${theme.fg("accent", progress.surface)}${theme.fg("dim", mode)} ${theme.fg("muted", elapsed)} ${theme.fg("dim", status)} ${theme.fg("muted", progressPhase(progress))}`);
		const current = progress.panel.find((item) => item.status === "running");
		if (current) lines.push(`    ${theme.fg("warning", "→")} ${theme.fg("toolOutput", current.model)} ${theme.fg("dim", current.role)}`);
	}
	return lines;
}

function renderProgress(progress: ScrutinyRunProgress, theme: any): string {
	const ready = progress.panel.filter((item) => item.status === "ready").length;
	const elapsed = formatDuration(Math.max(0, progress.updatedAt - progress.startedAt));
	const mode = progress.panel_mode ? ` ${progress.panel_mode}` : "";
	const status = progress.panel.length ? `${ready}/${progress.panel.length}` : "verify";
	const lines: string[] = [];
	lines.push(`${theme.fg("accent", "◐")} ${theme.bold("scrutiny")} ${theme.fg("accent", progress.surface)}${theme.fg("dim", mode)} ${theme.fg("muted", elapsed)} ${theme.fg("dim", status)} ${theme.fg("muted", progressPhase(progress))}`);
	for (const item of progress.panel) {
		const dur = item.endedAt ? formatDuration(item.endedAt - (item.startedAt ?? progress.startedAt)) : "";
		lines.push(`  ${statusIcon(item.status, theme)} ${theme.fg("toolOutput", item.model)} ${theme.fg("dim", item.role)}${dur ? ` ${theme.fg("muted", dur)}` : ""}`);
	}
	if (progress.judge) lines.push(`  ${statusIcon(progress.judge.status, theme)} ${theme.fg("toolOutput", progress.judge.model)} ${theme.fg("dim", progress.judge.role)}`);
	return lines.join("\n");
}

function renderCompactResult(result: ScrutinyRunResult, theme: any): string {
	const ok = result.responses.filter((response) => response.status === "ok");
	const failed = result.responses.filter((response) => response.status === "error");
	const lines: string[] = [];
	const color = result.status === "ok" ? "success" : "error";
	const mode = result.panel_mode ? ` ${result.panel_mode}` : "";
	lines.push(`${theme.fg(color, result.status === "ok" ? "◆" : "✕")} ${theme.bold("scrutiny")} ${theme.fg("accent", result.surface)}${theme.fg("dim", mode)} ${theme.fg("muted", formatDuration(result.durationMs))}`);
	if (result.status === "error" && result.error) {
		lines.push(`  ${theme.fg("error", truncate(result.error, 180).replace(/\n/g, " "))}`);
	}
	if (result.responses.length > 0) {
		const judgeBit = result.judge ? ` ${result.judge.status === "ok" ? theme.fg("success", "map") : theme.fg("warning", "map:failed")}` : "";
		lines.push(`  ${theme.fg("success", `${ok.length}/${result.responses.length} ready`)}${failed.length ? ` ${theme.fg("warning", `${failed.length} failed`)}` : ""}${judgeBit}`);
	}
	for (const response of result.responses) lines.push(panelLine(response, theme));
	if (result.analysis?.disagreement_signal) lines.push(`  ${theme.fg("error", "⚠ disagreement")} ${theme.fg("dim", "stop signal")}`);
	else if (result.panel_mode !== "roles" && result.analysis?.contradictions?.length) lines.push(`  ${theme.fg("warning", "contradiction")} ${truncate(result.analysis.contradictions[0]?.topic ?? "", 100).replace(/\n/g, " ")}`);
	else if (result.analysis?.coverage?.length) lines.push(`  ${theme.fg("accent", "coverage")} ${truncate(result.analysis.coverage[0] ?? "", 100).replace(/\n/g, " ")}`);
	else if (result.analysis?.consensus?.length) lines.push(`  ${theme.fg("accent", "shared")} ${truncate(result.analysis.consensus[0] ?? "", 100).replace(/\n/g, " ")}`);
	const factLine = surfaceFactLine(result.normalized ? surfaceFacts(result.normalized) : undefined, theme);
	if (factLine) lines.push(factLine);
	if (result.verify) lines.push(`  ${theme.fg(result.verify.failed ? "error" : "success", "verify")} ${result.verify.passed} pass ${result.verify.failed} fail ${result.verify.skipped} skip`);
	if (result.packetPath) lines.push(`  ${theme.fg("dim", "ctrl+o expand")}`);
	return lines.join("\n");
}

function artifactPath(packetPath: string, file: string): string {
	return packetPath.replace(/packet\.md$/, file);
}

function surfaceFactLine(facts: SurfaceFacts | undefined, theme: any): string | undefined {
	if (!facts) return undefined;
	if (facts.rootCauses?.length) return `  ${theme.fg("accent", "root cause")} ${truncate(facts.rootCauses[0] ?? "", 100).replace(/\n/g, " ")}`;
	if (facts.findings?.length) return `  ${theme.fg("warning", "risk")} ${truncate(facts.findings[0] ?? "", 100).replace(/\n/g, " ")}`;
	if (facts.symbols?.length) return `  ${theme.fg("accent", "symbols")} ${facts.symbols.slice(0, 3).join(", ")}`;
	if (facts.criteria?.length) return `  ${theme.fg("accent", "criterion")} ${truncate(facts.criteria[0] ?? "", 100).replace(/\n/g, " ")}`;
	if (facts.recommendation) return `  ${theme.fg("accent", "rec")} ${truncate(facts.recommendation, 100).replace(/\n/g, " ")}`;
	if (facts.positions?.length) return `  ${theme.fg("accent", "position")} ${truncate(facts.positions[0] ?? "", 100).replace(/\n/g, " ")}`;
	return undefined;
}

function panelLine(response: PanelResponse, theme: any): string {
	const dur = formatDuration(response.durationMs);
	const usage = response.usage.input || response.usage.output ? ` ${formatTokens(response.usage.input)}↑ ${formatTokens(response.usage.output)}↓` : "";
	const cost = response.usage.cost ? ` $${response.usage.cost.toFixed(4)}` : "";
	return `  ${response.status === "ok" ? theme.fg("success", "●") : theme.fg("error", "×")} ${theme.fg("toolOutput", response.model)} ${theme.fg("dim", response.role)} ${theme.fg("muted", dur)}${theme.fg("dim", usage)}${theme.fg("dim", cost)}`;
}

function renderExpandedMarkdown(result: ScrutinyRunResult): string {
	const lines: string[] = [];
	lines.push(`# Scrutiny ${result.status}`);
	lines.push(`surface: ${result.surface}  `);
	if (result.panel_mode) lines.push(`panel mode: ${result.panel_mode}  `);
	lines.push(`duration: ${formatDuration(result.durationMs)}  `);
	if (result.packetPath) {
		lines.push(`result: \`${artifactPath(result.packetPath, "result.json")}\``);
		lines.push(`packet: \`${result.packetPath}\``);
	}
	lines.push("");
	if (result.analysis) {
		lines.push("## Evidence map");
		pushList(lines, "Consensus", result.analysis.consensus);
		pushList(lines, "Risks", result.analysis.risks);
		pushList(lines, "Coverage", result.analysis.coverage);
		pushList(lines, "Blind spots", result.analysis.blind_spots);
		if (result.analysis.unique_insights?.length) {
			lines.push("### Unique insights");
			for (const item of result.analysis.unique_insights) lines.push(`- **${item.model}**: ${item.insight}`);
		}
		if (result.panel_mode !== "roles" && result.analysis.contradictions?.length) {
			lines.push("### Contradictions");
			for (const item of result.analysis.contradictions) {
				lines.push(`- ${item.topic}`);
				for (const stance of item.stances) lines.push(`  - **${stance.model}**: ${stance.stance}`);
			}
		}
		if (result.analysis.confidence) lines.push(`confidence: ${result.analysis.confidence}`);
		lines.push("");
	}
	const stats = contextStats(result);
	if (stats.hasContext) {
		lines.push("## Context footprint");
		lines.push(`scout candidates: ${stats.candidates}  `);
		lines.push(`related memory: ${stats.memory}  `);
		lines.push(`missing-context signals: ${stats.gaps}`);
		lines.push("");
	}
	const facts = result.normalized ? surfaceFacts(result.normalized) : undefined;
	if (facts) {
		lines.push("## Surface facts");
		if (facts.rootCauses?.length) pushList(lines, "Root causes", facts.rootCauses);
		if (facts.distinguishingTests?.length) pushList(lines, "Distinguishing tests", facts.distinguishingTests);
		if (facts.findings?.length) pushList(lines, "Findings", facts.findings);
		if (facts.suggestedChecks?.length) pushList(lines, "Suggested checks", facts.suggestedChecks);
		if (facts.symbols?.length) pushList(lines, "Symbols", facts.symbols);
		if (facts.files?.length) pushList(lines, "Files", facts.files);
		if (facts.criteria?.length) pushList(lines, "Criteria", facts.criteria);
		if (facts.testCases?.length) pushList(lines, "Test cases", facts.testCases);
		if (facts.positions?.length) pushList(lines, "Positions", facts.positions);
		if (facts.recommendation) lines.push(`recommendation: ${facts.recommendation}`);
		lines.push("");
	}
	lines.push("## Panel outputs");
	for (const response of result.responses) {
		lines.push(`### ${response.model} (${response.role})`);
		if (response.status === "error") lines.push(`error: ${response.error ?? "unknown"}`);
		else lines.push(response.content);
		lines.push("");
	}
	if (result.judge) {
		lines.push("## Trade-off explainer raw output");
		lines.push(result.judge.status === "ok" ? result.judge.content : result.judge.error ?? "trade-off explainer failed");
	}
	if (result.verify) {
		lines.push("## Verify (objective arbiter)");
		lines.push(`${result.verify.passed} passed · ${result.verify.failed} failed · ${result.verify.skipped} skipped · ${formatDuration(result.verify.durationMs)}`);
		if (result.verify.diffStat) lines.push("```", result.verify.diffStat.trim(), "```");
		for (const check of result.verify.checks) {
			const icon = check.status === "pass" ? "✓" : check.status === "fail" ? "✕" : check.status === "error" ? "!" : "–";
			lines.push(`- ${icon} ${check.name} (${check.status})`);
		}
	}
	return lines.join("\n");
}

function contextStats(result: ScrutinyRunResult): { hasContext: boolean; candidates: number; memory: number; gaps: number } {
	const scout = result.scout;
	const missing = missingContextSignals(result);
	return {
		hasContext: Boolean(scout) || missing > 0,
		candidates: scout?.candidates.length ?? 0,
		memory: scout?.priorCount ?? 0,
		gaps: (scout?.gaps.length ?? 0) + missing,
	};
}

function missingContextSignals(result: ScrutinyRunResult): number {
	const lines = [
		...(result.analysis?.blind_spots ?? []),
		...result.responses.flatMap((response) => response.content.split(/\r?\n/)),
	]
		.map((line) => line.trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
		.filter((line) => line.length >= 20 && line.length <= 500)
		.filter((line) => !/^Deterministic analysis does not infer/i.test(line))
		.filter((line) => /\b(missing|not shown|not in (the )?packet|insufficient|unknown|cannot determine|can't determine|need(?:s)? to inspect|must inspect|would need|need more evidence|not enough evidence)\b/i.test(line));
	return new Set(lines.map((line) => truncate(line, 240))).size;
}

function pushList(lines: string[], title: string, items: string[] | undefined): void {
	if (!items?.length) return;
	lines.push(`### ${title}`);
	for (const item of items) lines.push(`- ${item}`);
}

function statusIcon(status: string, theme: any): string {
	if (status === "ready") return theme.fg("success", "●");
	if (status === "running") return theme.fg("warning", "◐");
	if (status === "failed") return theme.fg("error", "×");
	return theme.fg("dim", "○");
}

function isProgress(value: unknown): value is ScrutinyRunProgress {
	return Boolean(value && typeof value === "object" && (value as any).runId && Array.isArray((value as any).panel) && (value as any).status === "running");
}

function isResult(value: unknown): value is ScrutinyRunResult {
	return Boolean(value && typeof value === "object" && (value as any).runId && Array.isArray((value as any).responses) && ((value as any).status === "ok" || (value as any).status === "error"));
}
