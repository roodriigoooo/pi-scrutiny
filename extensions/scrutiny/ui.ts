import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { ScrutinyRunProgress, ScrutinyRunResult, PanelResponse } from "./types.js";
import { formatDuration, formatTokens, truncate } from "./util.js";

export function scrutinyStatusText(details: unknown): string {
	if (isResult(details)) {
		const ok = details.responses.filter((response) => response.status === "ok").length;
		const failed = details.failed_models.length;
		const judge = details.judge ? (details.judge.status === "ok" ? "map:on" : "map:failed") : "map:off";
		const panel = details.responses.length ? ` [panel ${ok}/${details.responses.length}]` : " [no panel]";
		return `scrutiny [${details.status}] [${details.surface}] ${formatDuration(details.durationMs)}${panel}${failed ? ` [fail ${failed}]` : ""} [${judge}]`;
	}
	if (isProgress(details)) {
		const ready = details.panel.filter((item) => item.status === "ready").length;
		const failed = details.panel.filter((item) => item.status === "failed").length;
		const running = details.panel.filter((item) => item.status === "running").length;
		const elapsed = formatDuration(Math.max(0, details.updatedAt - details.startedAt));
		const phase = progressPhase(details);
		const panel = details.panel.length ? ` [panel ${ready}/${details.panel.length}]` : " [verify]";
		return `scrutiny [${details.surface}] ${elapsed}${panel}${running ? ` [thinking ${running}]` : ""}${failed ? ` [fail ${failed}]` : ""} [${phase}]`;
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
	const bits = [chip(theme, surface, "accent"), chip(theme, panel ? `${panel.length} panel` : "env panel", panel ? "success" : "muted"), chip(theme, `map:${judgeMode}`, judgeMode === "on" ? "warning" : "muted")];
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

function progressPhase(progress: ScrutinyRunProgress): string {
	if (progress.judge?.status === "running") return "map";
	if (/verify/i.test(progress.message ?? "")) return "verify";
	if (/done/i.test(progress.message ?? "")) return "done";
	if (/failed|unusable|error/i.test(progress.message ?? "")) return "attention";
	return progress.panel.length ? "panel" : "checks";
}

export function renderScrutinyDock(progresses: ScrutinyRunProgress[], theme: any): string[] {
	if (progresses.length === 0) return [];
	const lines = [`${theme.fg("accent", "◆")} ${theme.bold("scrutiny dock")} ${chip(theme, `${progresses.length} active`, "accent")} ${chip(theme, "esc cancels foreground run", "muted")}`];
	for (const progress of progresses.slice(0, 4)) {
		const ready = progress.panel.filter((item) => item.status === "ready").length;
		const failed = progress.panel.filter((item) => item.status === "failed").length;
		const running = progress.panel.filter((item) => item.status === "running").length;
		const elapsed = formatDuration(Math.max(0, progress.updatedAt - progress.startedAt));
		const chips = [chip(theme, progress.surface, "accent"), chip(theme, elapsed, "muted"), progress.panel.length ? chip(theme, `panel ${ready}/${progress.panel.length}`, ready === progress.panel.length ? "success" : "warning") : chip(theme, "verify", "warning")];
		if (running) chips.push(chip(theme, `thinking ${running}`, "warning"));
		if (failed) chips.push(chip(theme, `fail ${failed}`, "error"));
		chips.push(chip(theme, progressPhase(progress), "muted"));
		lines.push(`  ${theme.fg("warning", "◐")} ${chips.join(" ")} ${theme.fg("dim", shortRunId(progress.runId))}`);
	}
	if (progresses.length > 4) lines.push(`  ${theme.fg("dim", `+${progresses.length - 4} more active`)}`);
	return lines;
}

function renderProgress(progress: ScrutinyRunProgress, theme: any): string {
	const ready = progress.panel.filter((item) => item.status === "ready").length;
	const failed = progress.panel.filter((item) => item.status === "failed").length;
	const running = progress.panel.filter((item) => item.status === "running").length;
	const elapsed = formatDuration(Math.max(0, progress.updatedAt - progress.startedAt));
	const chips = [chip(theme, progress.surface, "accent"), chip(theme, elapsed, "muted"), progress.panel.length ? chip(theme, `panel ${ready}/${progress.panel.length}`, ready === progress.panel.length ? "success" : "warning") : chip(theme, "verify", "warning")];
	if (running) chips.push(chip(theme, `thinking ${running}`, "warning"));
	if (failed) chips.push(chip(theme, `fail ${failed}`, "error"));
	chips.push(chip(theme, progressPhase(progress), "muted"));
	const lines: string[] = [];
	lines.push(`${theme.fg("accent", "◐")} ${theme.bold("scrutiny")} ${chips.join(" ")}`);
	for (const item of progress.panel) {
		lines.push(`  ${statusIcon(item.status, theme)} ${theme.fg("toolOutput", item.model)} ${theme.fg("dim", item.role)}`);
	}
	if (progress.judge) lines.push(`  ${statusIcon(progress.judge.status, theme)} ${theme.fg("toolOutput", progress.judge.model)} ${theme.fg("dim", progress.judge.role)}`);
	return lines.join("\n");
}

function renderCompactResult(result: ScrutinyRunResult, theme: any): string {
	const ok = result.responses.filter((response) => response.status === "ok");
	const failed = result.responses.filter((response) => response.status === "error");
	const lines: string[] = [];
	const color = result.status === "ok" ? "success" : "error";
	lines.push(`${theme.fg(color, result.status === "ok" ? "◆" : "✕")} ${theme.bold("scrutiny")} ${theme.fg("dim", result.surface)} ${theme.fg("muted", `· ${formatDuration(result.durationMs)}`)}`);
	if (result.status === "error" && result.error) {
		lines.push(`  ${theme.fg("error", truncate(result.error, 180).replace(/\n/g, " "))}`);
	}
	if (result.responses.length === 0 && !result.verify) {
		lines.push(`  ${theme.fg("warning", "no panel models configured")}`);
	} else if (result.responses.length > 0) {
		lines.push(`  ${theme.fg("success", `${ok.length}/${result.responses.length} panel ready`)}${failed.length ? theme.fg("warning", ` · ${failed.length} failed`) : ""}${result.judge ? ` · ${result.judge.status === "ok" ? theme.fg("success", "evidence map ready") : theme.fg("warning", "evidence map failed")}` : theme.fg("dim", " · evidence map skipped")}`);
	}
	for (const response of result.responses) lines.push(panelLine(response, theme));
	if (result.analysis?.disagreement_signal) lines.push(`  ${theme.fg("error", "⚠ disagreement")} ${theme.fg("dim", "stop signal — gather evidence or ask human, do not smooth")}`);
	if (result.analysis?.contradictions?.length) lines.push(`  ${theme.fg("warning", "contradiction")} ${truncate(result.analysis.contradictions[0]?.topic ?? "", 120).replace(/\n/g, " ")}`);
	if (result.analysis?.consensus?.length) lines.push(`  ${theme.fg("accent", "shared")} ${truncate(result.analysis.consensus[0] ?? "", 140).replace(/\n/g, " ")}`);
	if (result.analysis?.risks?.length) lines.push(`  ${theme.fg("warning", "risk")} ${truncate(result.analysis.risks[0] ?? "", 140).replace(/\n/g, " ")}`);
	if (result.verify) lines.push(`  ${theme.fg(result.verify.failed ? "error" : "success", "verify")} ${result.verify.passed} pass · ${result.verify.failed} fail · ${result.verify.skipped} skip`);
	if (result.packetPath) {
		lines.push(`  ${theme.fg("dim", `ctrl+o expand · result ${artifactPath(result.packetPath, "result.json")}`)}`);
		lines.push(`  ${theme.fg("dim", `packet ${result.packetPath}`)}`);
	}
	return lines.join("\n");
}

function shortRunId(runId: string): string {
	return runId.split("_").at(-1) ?? runId;
}

function artifactPath(packetPath: string, file: string): string {
	return packetPath.replace(/packet\.md$/, file);
}

function panelLine(response: PanelResponse, theme: any): string {
	const usage = response.usage.input || response.usage.output ? ` ↑${formatTokens(response.usage.input)} ↓${formatTokens(response.usage.output)}` : "";
	const cost = response.usage.cost ? ` $${response.usage.cost.toFixed(4)}` : "";
	return `  ${response.status === "ok" ? theme.fg("success", "●") : theme.fg("error", "×")} ${theme.fg("toolOutput", response.model)} ${theme.fg("dim", `${response.role} · ${formatDuration(response.durationMs)}${usage}${cost}`)}`;
}

function renderExpandedMarkdown(result: ScrutinyRunResult): string {
	const lines: string[] = [];
	lines.push(`# Scrutiny ${result.status}`);
	lines.push(`surface: ${result.surface}  `);
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
		pushList(lines, "Blind spots", result.analysis.blind_spots);
		if (result.analysis.unique_insights?.length) {
			lines.push("### Unique insights");
			for (const item of result.analysis.unique_insights) lines.push(`- **${item.model}**: ${item.insight}`);
		}
		if (result.analysis.contradictions?.length) {
			lines.push("### Contradictions");
			for (const item of result.analysis.contradictions) {
				lines.push(`- ${item.topic}`);
				for (const stance of item.stances) lines.push(`  - **${stance.model}**: ${stance.stance}`);
			}
		}
		if (result.analysis.confidence) lines.push(`confidence: ${result.analysis.confidence}`);
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
