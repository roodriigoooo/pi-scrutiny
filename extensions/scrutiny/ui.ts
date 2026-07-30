import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { surfaceFacts } from "./normalize.js";
import type { DeliberationStrategy, PanelResponse, ScrutinyAnalysis, ScrutinyRunProgress, ScrutinyRunResult, SurfaceFacts } from "./types.js";
import { formatDuration, formatTokens, truncate } from "./util.js";

export function scrutinyStatusText(details: unknown): string {
	if (isResult(details)) {
		const ok = details.responses.filter((response) => response.status === "ok").length;
		const failed = details.failed_models.length;
		const strategy = strategyOf(details);
		return `scrutiny ${details.status} ${details.surface}${strategy ? ` ${strategy}` : ""} ${formatDuration(details.durationMs)}${details.responses.length ? ` ${ok}/${details.responses.length}` : ""}${failed ? ` ${failed} failed` : ""}`;
	}
	if (isProgress(details)) {
		const ready = details.panel.filter((item) => item.status === "ready").length;
		const elapsed = formatDuration(Math.max(0, details.updatedAt - details.startedAt));
		return `scrutiny ${details.surface}${details.strategy ? ` ${details.strategy}` : ""} ${elapsed}${details.panel.length ? ` ${ready}/${details.panel.length}` : " verify"} ${progressPhase(details)}`;
	}
	return "scrutiny";
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
	box.addChild(new Text(`${theme.fg("accent", "◆")} ${theme.bold("scrutiny")} ${theme.fg("dim", kind)} ${staticChips(kind).map((item) => chip(theme, item, item === "env override" ? "warning" : "muted")).join(" ")}`.trim(), 0, 0));
	box.addChild(new Markdown(stripFirstHeading(content), 0, 0, getMarkdownTheme()));
	return box;
}

function inferStaticKind(content: string): string {
	const first = content.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "message";
	const match = first.match(/^#\s+scrutiny\s+(\S+)/i) ?? first.match(/^#\s+pi-scrutiny/i);
	return match?.[1]?.toLowerCase() ?? "help";
}

function stripFirstHeading(content: string): string {
	return content.replace(/^#\s+[^\n]+\n?/, "").trim() || content;
}

function staticChips(kind: string): string[] {
	if (kind === "help" || kind === "pi-scrutiny") return ["6 surfaces", "templates", "no patch fusion"];
	if (kind === "models") return ["panel", "verify", "env override"];
	if (kind === "templates") return ["strategy", "policies"];
	if (kind === "panels") return ["lineups only"];
	if (kind === "runs") return ["session", "artifacts"];
	if (kind === "config") return ["global", "project", "env override"];
	return [];
}

function chip(theme: any, text: string, color: "accent" | "muted" | "success" | "warning" | "error"): string {
	return theme.fg(color, `[${text}]`);
}

function progressPhase(progress: ScrutinyRunProgress): string {
	if (progress.status === "error") return "failed";
	if (progress.status === "ok" || progress.phase === "complete") return "complete";
	if (progress.phase === "evidence-map") return "evidence map";
	if (progress.phase === "verify") {
		const active = progress.verifyChecks?.findIndex((item) => item.status === "running") ?? -1;
		const pending = progress.verifyChecks?.findIndex((item) => item.status === "pending") ?? -1;
		const index = active >= 0 ? active : pending;
		return progress.verifyChecks?.length && index >= 0 ? `verify ${index + 1}/${progress.verifyChecks.length}` : "verify";
	}
	const active = progress.panel.findIndex((item) => item.status === "running");
	const pending = progress.panel.findIndex((item) => item.status === "pending");
	const index = active >= 0 ? active : pending;
	return progress.panel.length && index >= 0 ? `panel ${index + 1}/${progress.panel.length}` : progress.panel.length ? "panel" : "starting";
}

export type ScrutinyPendingPhase = "waiting" | "starting";

export function renderScrutinyPendingDock(
	phase: ScrutinyPendingPhase,
	theme: any,
	width = 80,
	elapsedMs = 0,
): string[] {
	const detail = phase === "waiting" ? "Pi is finishing its current work" : "preparing task packet";
	return [
		fitDockLine(`${theme.bold("scrutiny")} ${theme.fg("dim", `· ${phase} · ${formatDuration(elapsedMs)}`)}`, width),
		fitDockLine(`${theme.fg("accent", "phase")} ${phase} ${theme.fg("dim", `· esc cancel · ${detail}`)}`, width),
	];
}

export function renderScrutinyDock(
	progresses: ScrutinyRunProgress[],
	theme: any,
	width = 80,
	now = Date.now(),
): string[] {
	if (!progresses.length) return [];
	const progress = progresses[0]!;
	const elapsed = formatDuration(Math.max(0, now - progress.startedAt));
	const identity = [progress.surface, progress.strategy].filter(Boolean).join(" · ");
	const finishedPanels = progress.panel.filter((item) => item.status === "ready" || item.status === "failed").length;
	const finishedChecks = progress.verifyChecks?.filter((item) => item.status !== "pending" && item.status !== "running").length ?? 0;
	const summary = progress.phase === "verify" || (!progress.panel.length && progress.verifyChecks?.length)
		? `${finishedChecks}/${progress.verifyChecks?.length ?? 0} checks finished`
		: progress.panel.length ? `${finishedPanels}/${progress.panel.length} panelists finished` : "initializing";
	const lines = [
		fitDockLine(`${theme.bold("scrutiny")} ${theme.fg("dim", `· ${identity || "run"} · ${elapsed}`)}`, width),
		fitDockLine(`${theme.fg(progress.status === "error" ? "error" : "accent", "phase")} ${progressPhase(progress)} ${theme.fg("dim", `· esc cancel · ${summary}`)}`, width),
	];
	for (const [index, item] of progress.panel.entries()) {
		lines.push(progressRow(`panel ${index + 1}/${progress.panel.length}`, panelState(item.status), `${item.model} · ${item.role}`, item.startedAt, theme, width, now));
	}
	if (progress.judge) {
		lines.push(progressRow("map", panelState(progress.judge.status), `${progress.judge.model} · ${progress.judge.role}`, progress.judge.startedAt, theme, width, now));
	}
	for (const [index, check] of (progress.verifyChecks ?? []).entries()) {
		const outcome = check.status === "pass" || check.status === "fail" || check.status === "error" ? ` · ${check.status}` : "";
		lines.push(progressRow(`check ${index + 1}/${progress.verifyChecks?.length ?? 0}`, verifyRowState(check.status), `${check.name}${outcome}`, check.startedAt, theme, width, now));
	}
	if (progress.status === "error" && progress.message) {
		lines.push(fitDockLine(`${theme.fg("error", "failure")} ${progress.message.replace(/\s+/g, " ")}`, width));
	}
	if (progresses.length > 1) lines.push(fitDockLine(theme.fg("dim", `+ ${progresses.length - 1} more active run${progresses.length === 2 ? "" : "s"}`), width));
	return lines;
}

function progressRow(
	step: string,
	state: "pending" | "running" | "ready" | "failed",
	detail: string,
	startedAt: number | undefined,
	theme: any,
	width: number,
	now: number,
): string {
	const stateColor = state === "ready"
		? "success"
		: state === "failed"
			? "error"
			: state === "running" ? "warning" : "dim";
	const duration = state === "running" && startedAt !== undefined ? ` ${formatDuration(Math.max(0, now - startedAt))}` : "";
	return fitDockLine(
		`${padPlain(step, 11)} ${theme.fg(stateColor, padPlain(`${state}${duration}`, 14))} ${theme.fg(state === "pending" ? "dim" : "toolOutput", detail)}`,
		width,
	);
}

function panelState(status: ScrutinyRunProgress["panel"][number]["status"]): "pending" | "running" | "ready" | "failed" {
	return status;
}

function verifyRowState(status: NonNullable<ScrutinyRunProgress["verifyChecks"]>[number]["status"]): "pending" | "running" | "ready" | "failed" {
	if (status === "pass") return "ready";
	if (status === "fail" || status === "error") return "failed";
	return status;
}

function padPlain(value: string, width: number): string {
	return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function fitDockLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "…");
}

function renderCompactResult(result: ScrutinyRunResult, theme: any): string {
	const ok = result.responses.filter((response) => response.status === "ok");
	const failed = result.responses.filter((response) => response.status === "error");
	const strategy = strategyOf(result);
	const lines: string[] = [];
	const color = result.status === "ok" ? "success" : "error";
	lines.push(`${theme.fg(color, result.status === "ok" ? "◆" : "✕")} ${theme.bold("scrutiny")} ${theme.fg("accent", result.surface)}${theme.fg("dim", strategy ? ` ${strategy}` : "")} ${theme.fg("muted", formatDuration(result.durationMs))}`);
	if (result.template) lines.push(`  ${theme.fg("dim", `template:${result.template}${result.panelName ? ` · panel:${result.panelName}` : ""}`)}`);
	if (result.status === "error" && result.error) lines.push(`  ${theme.fg("error", truncate(result.error, 180).replace(/\n/g, " "))}`);
	if (result.responses.length) {
		const judge = result.judge ? ` ${result.judge.status === "ok" ? theme.fg("success", "map") : theme.fg("warning", "map:failed")}` : "";
		lines.push(`  ${theme.fg("success", `${ok.length}/${result.responses.length} ready`)}${failed.length ? ` ${theme.fg("warning", `${failed.length} failed`)}` : ""}${judge}`);
	}
	for (const response of result.responses) lines.push(panelLine(response, theme));
	if (result.analysis?.disagreement_signal) lines.push(`  ${theme.fg("error", "⚠ disagreement")} ${theme.fg("dim", "stop signal")}`);
	else if (strategy === "replicate" && result.analysis?.contradictions?.length) lines.push(`  ${theme.fg("warning", "contradiction")} ${truncate(result.analysis.contradictions[0]?.topic ?? "", 100).replace(/\n/g, " ")}`);
	else if (result.analysis?.coverage?.length) lines.push(`  ${theme.fg("accent", "coverage")} ${truncate(result.analysis.coverage[0] ?? "", 100).replace(/\n/g, " ")}`);
	const facts = result.normalized ? surfaceFacts(result.normalized) : undefined;
	if (facts) lines.push(surfaceFactLine(facts, theme));
	if (result.verify) lines.push(`  ${theme.fg(result.verify.failed ? "error" : "success", "verify")} ${result.verify.passed} pass ${result.verify.failed} fail ${result.verify.skipped} skip`);
	if (result.packetPath) lines.push(`  ${theme.fg("dim", "ctrl+o expand")}`);
	return lines.join("\n");
}

function panelLine(response: PanelResponse, theme: any): string {
	const usage = response.usage.input || response.usage.output ? ` ${formatTokens(response.usage.input)}↑ ${formatTokens(response.usage.output)}↓` : "";
	const cost = response.usage.cost ? ` $${response.usage.cost.toFixed(4)}` : "";
	return `  ${response.status === "ok" ? theme.fg("success", "●") : theme.fg("error", "×")} ${theme.fg("toolOutput", response.model)} ${theme.fg("dim", response.role)} ${theme.fg("muted", formatDuration(response.durationMs))}${theme.fg("dim", usage)}${theme.fg("dim", cost)}`;
}

function renderExpandedMarkdown(result: ScrutinyRunResult): string {
	const strategy = strategyOf(result);
	const lines = [`# Scrutiny ${result.status}`, `surface: ${result.surface}  `];
	if (result.template) lines.push(`template: ${result.template}  `);
	if (result.panelName) lines.push(`panel: ${result.panelName}  `);
	if (strategy) lines.push(`strategy: ${strategy}  `);
	if (result.assignments?.length) lines.push(`assignments: ${result.assignments.map((item) => `${item.model}${item.lens ? ` → ${item.lens}` : ""}`).join(", ")}  `);
	if (result.unassignedLenses?.length) lines.push(`unassigned lenses: ${result.unassignedLenses.join(", ")}  `);
	lines.push(`duration: ${formatDuration(result.durationMs)}  `);
	if (result.packetPath) lines.push(`result: \`${result.packetPath.replace(/packet\.md$/, "result.json")}\``, `packet: \`${result.packetPath}\``);
	lines.push("");
	if (result.analysis) {
		lines.push("## Evidence map");
		pushList(lines, "Consensus", result.analysis.consensus);
		pushList(lines, "Risks", result.analysis.risks);
		pushList(lines, "Coverage", result.analysis.coverage);
		pushList(lines, "Blind spots", result.analysis.blind_spots);
		if (strategy === "replicate") pushContradictions(lines, result.analysis.contradictions);
		if (result.analysis.confidence) lines.push(`confidence: ${result.analysis.confidence}`);
		lines.push("");
	}
	const facts = result.normalized ? surfaceFacts(result.normalized) : undefined;
	if (facts) {
		lines.push("## Surface facts");
		if (facts.rootCauses?.length) pushList(lines, "Root causes", facts.rootCauses);
		if (facts.findings?.length) pushList(lines, "Findings", facts.findings);
		if (facts.criteria?.length) pushList(lines, "Criteria", facts.criteria);
		if (facts.positions?.length) pushList(lines, "Positions", facts.positions);
		lines.push("");
	}
	lines.push("## Panel outputs");
	for (const response of result.responses) {
		lines.push(`### ${response.model} (${response.role})`, response.status === "error" ? `error: ${response.error ?? "unknown"}` : response.content, "");
	}
	if (result.judge) lines.push("## Trade-off explainer raw output", result.judge.status === "ok" ? result.judge.content : result.judge.error ?? "trade-off explainer failed");
	if (result.verify) lines.push("## Verify (objective arbiter)", `${result.verify.passed} passed · ${result.verify.failed} failed · ${result.verify.skipped} skipped · ${formatDuration(result.verify.durationMs)}`);
	return lines.join("\n");
}

function surfaceFactLine(facts: SurfaceFacts, theme: any): string {
	if (facts.rootCauses?.length) return `  ${theme.fg("accent", "root cause")} ${truncate(facts.rootCauses[0] ?? "", 100).replace(/\n/g, " ")}`;
	if (facts.findings?.length) return `  ${theme.fg("warning", "risk")} ${truncate(facts.findings[0] ?? "", 100).replace(/\n/g, " ")}`;
	if (facts.symbols?.length) return `  ${theme.fg("accent", "symbols")} ${facts.symbols.slice(0, 3).join(", ")}`;
	if (facts.criteria?.length) return `  ${theme.fg("accent", "criterion")} ${truncate(facts.criteria[0] ?? "", 100).replace(/\n/g, " ")}`;
	if (facts.recommendation) return `  ${theme.fg("accent", "rec")} ${truncate(facts.recommendation, 100).replace(/\n/g, " ")}`;
	return "";
}

function pushList(lines: string[], title: string, items: string[] | undefined): void {
	if (!items?.length) return;
	lines.push(`### ${title}`, ...items.map((item) => `- ${item}`));
}

function pushContradictions(lines: string[], items: ScrutinyAnalysis["contradictions"]): void {
	if (!Array.isArray(items) || !items.length) return;
	lines.push("### Contradictions");
	for (const item of items) {
		lines.push(`- ${item.topic}`);
		for (const stance of item.stances) lines.push(`  - ${stance.model}: ${stance.stance}`);
	}
}

/** Old result artifacts used panel_mode; all current runtime paths use strategy. */
function strategyOf(result: ScrutinyRunResult): DeliberationStrategy | undefined {
	if (result.strategy) return result.strategy;
	return (result as ScrutinyRunResult & { panel_mode?: DeliberationStrategy }).panel_mode;
}

function isProgress(value: unknown): value is ScrutinyRunProgress {
	return Boolean(value && typeof value === "object" && (value as any).runId && Array.isArray((value as any).panel) && (value as any).status === "running");
}

function isResult(value: unknown): value is ScrutinyRunResult {
	return Boolean(value && typeof value === "object" && (value as any).runId && Array.isArray((value as any).responses) && ((value as any).status === "ok" || (value as any).status === "error"));
}
