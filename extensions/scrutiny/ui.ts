import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { ScrutinyRunProgress, ScrutinyRunResult, PanelResponse } from "./types.js";
import { formatDuration, formatTokens, truncate } from "./util.js";

export function scrutinyStatusText(details: unknown): string {
	if (isResult(details)) {
		const ok = details.responses.filter((response) => response.status === "ok").length;
		const failed = details.failed_models.length;
		const judge = details.judge ? (details.judge.status === "ok" ? "judge ready" : "judge failed") : "judge skipped";
		return `scrutiny ${details.status} · ${ok}/${details.responses.length} panel${details.responses.length === 1 ? "" : "s"} ready${failed ? ` · ${failed} failed` : ""} · ${judge} · ${formatDuration(details.durationMs)}`;
	}
	if (isProgress(details)) {
		const ready = details.panel.filter((item) => item.status === "ready").length;
		const failed = details.panel.filter((item) => item.status === "failed").length;
		const running = details.panel.filter((item) => item.status === "running").length;
		const elapsed = formatDuration(Math.max(0, details.updatedAt - details.startedAt));
		const phase = details.judge?.status === "running" ? " · explainer thinking" : details.message ? ` · ${details.message}` : "";
		return `scrutiny ${details.surface} · ${elapsed} · ${ready}/${details.panel.length} ready${running ? ` · ${running} thinking` : ""}${failed ? ` · ${failed} failed` : ""}${phase}`;
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
	const bits = [theme.fg("accent", surface), panel ? `${panel.length} panel` : "env panel", `judge:${judgeMode}`];
	return new Text(`${title} ${theme.fg("dim", bits.join(" · "))}`, 0, 0);
}

export function renderScrutinyMessage(message: any, { expanded }: { expanded?: boolean }, theme: any) {
	const details = message.details;
	if (!isResult(details)) return new Text(String(message.content ?? "scrutiny"), 0, 0);
	if (expanded) return new Markdown(renderExpandedMarkdown(details), 0, 0, getMarkdownTheme());
	const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
	box.addChild(new Text(renderCompactResult(details, theme), 0, 0));
	return box;
}

function renderProgress(progress: ScrutinyRunProgress, theme: any): string {
	const lines: string[] = [];
	lines.push(`${theme.fg("accent", "◆")} ${theme.bold("scrutiny")} ${theme.fg("dim", progress.surface)} ${theme.fg("muted", progress.message ?? "running")}`);
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
		lines.push(`  ${theme.fg("success", `${ok.length}/${result.responses.length} panel ready`)}${failed.length ? theme.fg("warning", ` · ${failed.length} failed`) : ""}${result.judge ? ` · ${result.judge.status === "ok" ? theme.fg("success", "explainer ready") : theme.fg("warning", "explainer failed")}` : theme.fg("dim", " · explainer skipped")}`);
	}
	for (const response of result.responses) lines.push(panelLine(response, theme));
	if (result.analysis?.disagreement_signal) lines.push(`  ${theme.fg("error", "⚠ disagreement")} ${theme.fg("dim", "stop signal — gather evidence or ask human, do not smooth")}`);
	if (result.analysis?.contradictions?.length) lines.push(`  ${theme.fg("warning", "contradiction")} ${truncate(result.analysis.contradictions[0]?.topic ?? "", 120).replace(/\n/g, " ")}`);
	if (result.analysis?.consensus?.length) lines.push(`  ${theme.fg("accent", "shared")} ${truncate(result.analysis.consensus[0] ?? "", 140).replace(/\n/g, " ")}`);
	if (result.analysis?.risks?.length) lines.push(`  ${theme.fg("warning", "risk")} ${truncate(result.analysis.risks[0] ?? "", 140).replace(/\n/g, " ")}`);
	if (result.verify) lines.push(`  ${theme.fg(result.verify.failed ? "error" : "success", "verify")} ${result.verify.passed} pass · ${result.verify.failed} fail · ${result.verify.skipped} skip`);
	if (result.packetPath) lines.push(`  ${theme.fg("dim", result.packetPath)}`);
	return lines.join("\n");
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
	if (result.packetPath) lines.push(`packet: \`${result.packetPath}\``);
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
