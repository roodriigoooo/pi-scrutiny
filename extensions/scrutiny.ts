import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exampleConfigJson, projectConfigPath, readScrutinyConfig, userConfigPath } from "./scrutiny/config.js";
import { SCRUTINY_PACKET_PREVIEW_CANCELLED, runScrutiny } from "./scrutiny/engine.js";
import { historyText, showHistoryPicker } from "./scrutiny/history.js";
import { showScrutinyPalette } from "./scrutiny/palette.js";
import { confirmPacketPreview } from "./scrutiny/preview.js";
import { PANEL_SETUP_NON_INTERACTIVE, showPanelSetup } from "./scrutiny/setup.js";
import { activeProgresses, recentRuns } from "./scrutiny/registry.js";
import { inferSurface, SCRUTINY_STOP_STATEMENT, SCRUTINY_SURFACES, SCRUTINY_SURFACE_SET, SURFACE_DOCS } from "./scrutiny/surfaces.js";
import { allTemplates, MissingPanelError, resolveRunPlan } from "./scrutiny/templates.js";
import type { ScrutinyConfig, ScrutinyParams, ScrutinySurface } from "./scrutiny/types.js";
import { scrutinyStatusText, renderScrutinyDock, renderScrutinyMessage } from "./scrutiny/ui.js";

function refreshScrutinyChrome(ctx: ExtensionContext, latest?: unknown): void {
	if (!ctx.hasUI) return;
	const active = activeProgresses();
	if (active.length) {
		ctx.ui.setStatus("scrutiny", `scrutiny [${active.length} active]`);
		ctx.ui.setWidget("scrutiny", renderScrutinyDock(active, ctx.ui.theme), { placement: "belowEditor" });
		return;
	}
	ctx.ui.setStatus("scrutiny", latest ? scrutinyStatusText(latest) : undefined);
	ctx.ui.setWidget("scrutiny", undefined);
}

function clearScrutinyChrome(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (activeProgresses().length) return refreshScrutinyChrome(ctx);
	ctx.ui.setStatus("scrutiny", undefined);
	ctx.ui.setWidget("scrutiny", undefined);
}

type ScrutinyMessage = { customType: "scrutiny-result"; content: string; display: boolean; details: unknown };

function publishScrutinyMessage(pi: ExtensionAPI, message: ScrutinyMessage): void {
	pi.sendMessage(message, { triggerTurn: false });
}

async function waitForPiIdle(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.isIdle()) return;
	if (ctx.hasUI) ctx.ui.setStatus("scrutiny", "scrutiny waiting for Pi");
	try {
		await ctx.waitForIdle();
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("scrutiny", undefined);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer("scrutiny-result", renderScrutinyMessage);
	pi.registerCommand("scrutiny", {
		description: "Run, set up, or inspect Pi Scrutiny by explicit command (usage: /scrutiny | setup | help | models | runs | history | panels | templates | config | <surface>: <prompt> | @<template>: <prompt> | ask <prompt>)",
		handler: async (args, ctx) => {
			await waitForPiIdle(ctx);
			const runAndPublish = async (params: ScrutinyParams) => {
				if (ctx.mode !== "tui") {
					const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
					if (requiresPanelSetup(params, config)) {
						publishScrutinyMessage(pi, { customType: "scrutiny-result", content: PANEL_SETUP_NON_INTERACTIVE, display: true, details: { kind: "setup" } });
						return;
					}
				}
				try {
					if (ctx.hasUI) ctx.ui.setStatus("scrutiny", "scrutiny starting");
					const { result, brief } = await runScrutiny({
						params,
						cwd: ctx.cwd,
						projectTrusted: ctx.isProjectTrusted(),
						exec: (command, execArgs, options) => pi.exec(command, execArgs, options),
						signal: ctx.signal,
						confirmPacket: ctx.hasUI ? (preview) => confirmPacketPreview(ctx, preview) : undefined,
						onProgress: (progress) => refreshScrutinyChrome(ctx, progress),
					});
					clearScrutinyChrome(ctx);
					publishScrutinyMessage(pi, { customType: "scrutiny-result", content: brief, display: true, details: result });
				} catch (error) {
					clearScrutinyChrome(ctx);
					if (error instanceof Error && error.message === SCRUTINY_PACKET_PREVIEW_CANCELLED) {
						ctx.ui.notify("scrutiny cancelled before panel spend", "info");
						return;
					}
					ctx.ui.notify(`scrutiny failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			};

			const trimmed = args.trim();
			if (!trimmed || trimmed === "ui" || trimmed === "palette") {
				if (ctx.mode !== "tui") {
					const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
					const content = config.panels.length ? "Scrutiny palette requires Pi TUI. Use an inline command such as `/scrutiny consult: <prompt>`." : PANEL_SETUP_NON_INTERACTIVE;
					return publishScrutinyMessage(pi, { customType: "scrutiny-result", content, display: true, details: { kind: "setup" } });
				}
				const params = await showScrutinyPalette(ctx);
				if (params) await runAndPublish(params);
				return;
			}
			if (trimmed === "setup") {
				if (ctx.mode !== "tui") return publishScrutinyMessage(pi, { customType: "scrutiny-result", content: PANEL_SETUP_NON_INTERACTIVE, display: true, details: { kind: "setup" } });
				await showPanelSetup(ctx);
				return;
			}
			if (trimmed === "help") return publishScrutinyMessage(pi, { customType: "scrutiny-result", content: helpText(), display: true, details: { kind: "help" } });
			if (trimmed === "models") {
				const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
				return publishScrutinyMessage(pi, { customType: "scrutiny-result", content: modelsText(config), display: true, details: { kind: "models" } });
			}
			if (trimmed === "runs") return publishScrutinyMessage(pi, { customType: "scrutiny-result", content: runsText(), display: true, details: { kind: "runs" } });
			if (trimmed === "history") {
				const content = ctx.hasUI ? await showHistoryPicker(ctx) : await historyText(ctx.cwd, "");
				if (content) publishScrutinyMessage(pi, { customType: "scrutiny-result", content, display: true, details: { kind: "history" } });
				return;
			}
			if (trimmed.startsWith("history ")) {
				const content = await historyText(ctx.cwd, trimmed.slice("history".length).trim());
				return publishScrutinyMessage(pi, { customType: "scrutiny-result", content, display: true, details: { kind: "history" } });
			}
			if (trimmed === "panels") {
				const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
				return publishScrutinyMessage(pi, { customType: "scrutiny-result", content: panelsText(config), display: true, details: { kind: "panels" } });
			}
			if (trimmed === "templates") {
				const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
				return publishScrutinyMessage(pi, { customType: "scrutiny-result", content: templatesText(config), display: true, details: { kind: "templates" } });
			}
			if (trimmed === "config" || trimmed.startsWith("config ")) {
				await handleConfigCommand(trimmed.slice("config".length).trim(), ctx, pi);
				return;
			}
			const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
			const parsed = parseInline(trimmed, config);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			if (!parsed.prompt && parsed.params.template !== "verify") {
				ctx.ui.notify("usage: /scrutiny ask <prompt>  |  /scrutiny <surface>: <prompt>  |  /scrutiny @<template>: <prompt>", "warning");
				return;
			}
			await runAndPublish({ prompt: parsed.prompt || "run objective repo checks", ...parsed.params });
		},
	});
}

function parseInline(trimmed: string, config: ScrutinyConfig): { params: Partial<ScrutinyParams>; prompt: string; error?: string } {
	const colonIdx = trimmed.indexOf(":");
	if (colonIdx > 0) {
		const head = trimmed.slice(0, colonIdx).trim();
		const prompt = trimmed.slice(colonIdx + 1).trim();
		if (head.startsWith("@")) {
			const template = allTemplates(config).find((item) => item.name === head.slice(1));
			if (!template) return { params: {}, prompt, error: `Unknown template "${head.slice(1)}". Run /scrutiny templates to list available templates.` };
			return { params: { template: template.name }, prompt };
		}
		if (head && SCRUTINY_SURFACE_SET.has(head as ScrutinySurface)) return { params: { template: head }, prompt };
	}
	const prompt = trimmed.startsWith("ask ") ? trimmed.slice(4).trim() : trimmed;
	return { params: {}, prompt };
}

async function handleConfigCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "show") {
		const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		return publishScrutinyMessage(pi, { customType: "scrutiny-result", content: configText(config), display: true, details: { kind: "config" } });
	}
	if (trimmed === "edit" || trimmed === "edit global" || trimmed === "edit user") return editConfigFile("global", ctx);
	if (trimmed === "edit project") return editConfigFile("project", ctx);
	ctx.ui.notify("usage: /scrutiny config | /scrutiny config edit [project]", "warning");
}

async function editConfigFile(scope: "global" | "project", ctx: ExtensionCommandContext): Promise<void> {
	if (scope === "project" && !ctx.isProjectTrusted()) {
		ctx.ui.notify("project config skipped: project not trusted", "warning");
		return;
	}
	const file = scope === "project" ? projectConfigPath(ctx.cwd) : userConfigPath();
	const existing = await readFile(file, "utf8").catch(() => exampleConfigJson());
	const edited = await ctx.ui.editor(`Edit ${scope} scrutiny config`, existing);
	if (edited === undefined) return;
	try {
		JSON.parse(edited);
	} catch (error) {
		ctx.ui.notify(`scrutiny config not saved: invalid JSON (${error instanceof Error ? error.message : String(error)})`, "error");
		return;
	}
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${edited.trim()}\n`, { encoding: "utf8", mode: 0o600 });
	ctx.ui.notify(`saved ${file}. next scrutiny run will use it.`, "info");
}

function configText(config: ScrutinyConfig): string {
	const sources = config.configSources.map((source) => `- ${source.scope}: ${source.status}${source.reason ? ` (${source.reason})` : ""}${source.path ? ` — ${source.path}` : ""}`);
	return [
		"# scrutiny config",
		"",
		"config files load in this order: global → trusted project → env overrides.",
		"",
		"## sources",
		...(sources.length ? sources : ["- env: no PI_SCRUTINY_* overrides"]),
		"",
		"## active",
		`- default panel: ${config.defaultPanel ?? "not configured"}`,
		`- panels: ${config.panels.length}`,
		`- templates: ${allTemplates(config).length} (${config.templates.length} user-defined)`,
		`- trade-off explainer: ${config.judge ?? "first selected panel model"}`,
		`- tools: ${config.tools.length ? config.tools.join(", ") : "none"}`,
		`- verify checks: ${config.verifyChecks.map((check) => check.name).join(", ") || "none"}`,
		...(config.diagnostics.length ? ["", "## migration", ...config.diagnostics.map((message) => `- ${message.split("\n")[0]}`)] : []),
		...(config.configurationErrors.length ? ["", "## errors", ...config.configurationErrors.map((message) => `- ${message}`)] : []),
		"",
		"## setup",
		"- `/scrutiny setup` builds a reusable global panel from authenticated Pi models.",
		"- `/scrutiny config edit` edits global `~/.pi/agent/scrutiny.json` (advanced).",
		"- `/scrutiny config edit project` edits project `.pi/scrutiny.json` (trusted projects only).",
	].join("\n");
}

function helpText(): string {
	return [
		"# pi-scrutiny",
		"",
		"multi-model deliberation and objective repo verification. panels are who runs; templates are how a run executes.",
		"",
		"surfaces:",
		...SCRUTINY_SURFACES.map((surface) => `- \`${surface}\` — ${SURFACE_DOCS[surface].mode}. ${SURFACE_DOCS[surface].description}`),
		"",
		"activation: Scrutiny starts only when you invoke /scrutiny or confirm through its palette. Natural-language requests do not start a run.",
		"first use: /scrutiny setup saves an authenticated-model lineup globally; setup itself causes no spend and never starts a run.",
		"before panel spend: human reviews and confirms exact packet in TUI.",
		"strategy: replicate means byte-identical prompts and disagreement signal; roles means explicit lenses and coverage/gaps signal.",
		"completion: result displays and persists. Pi remains idle; no automatic agent turn, synthesis, diagnostics, edits, or implementation begin.",
		SCRUTINY_STOP_STATEMENT,
		"",
		"```text",
		"/scrutiny",
		"/scrutiny setup",
		"/scrutiny models",
		"/scrutiny panels",
		"/scrutiny templates",
		"/scrutiny runs",
		"/scrutiny history",
		"/scrutiny config edit [project]",
		"/scrutiny verify:",
		"/scrutiny @release-risk: review this patch",
		"/scrutiny risks: review this webflux retry patch",
		"/scrutiny hypotheses: intermittent offset commit on kafka consumer",
		"/scrutiny ask compare these two implementation plans",
		"```",
	].join("\n");
}

function modelsText(config: ScrutinyConfig): string {
	const defaultPanel = config.defaultPanel ? config.panels.find((panel) => panel.name === config.defaultPanel) : undefined;
	return [
		"# scrutiny models",
		"",
		`default panel: ${defaultPanel ? defaultPanel.members.map(formatPanelMember).join(", ") : "not configured"}`,
		`trade-off explainer: ${config.judge ?? "first selected panel model"}`,
		`tools: ${config.tools.length ? config.tools.join(", ") : "none"}`,
		`verify checks: ${config.verifyChecks.map((check) => check.name).join(", ") || "none"}`,
		"",
		"Run `/scrutiny setup` to build a reusable global panel. `/scrutiny config edit` remains the advanced editor; `PI_SCRUTINY_*` env vars still override files.",
	].join("\n");
}

function runsText(): string {
	const runs = recentRuns();
	if (!runs.length) return "# scrutiny runs\n\nno runs yet in this session.";
	return ["# scrutiny runs", "", ...runs.map((run) => `- ${run.runId} · ${run.surface} · ${run.status}${run.endedAt ? ` · ${new Date(run.endedAt).toLocaleTimeString()}` : ""}\n  ${run.runDir ?? "(no artifacts)"}`), "", "artifacts (packet/responses/verify/result.json) live under each run dir."].join("\n");
}

function panelsText(config: ScrutinyConfig): string {
	if (!config.panels.length) return "# scrutiny panels\n\nno panels configured. Run `/scrutiny setup` to choose authenticated models, or `/scrutiny config edit` for advanced configuration.";
	return [
		"# scrutiny panels",
		"",
		...config.panels.map((panel) => `- ${panel.name}${panel.name === config.defaultPanel ? " (default)" : ""} · ${panel.members.map(formatPanelMember).join(", ")}`),
		"",
		"Panels contain model lineups only. Use `/scrutiny templates` to inspect execution strategy and policy.",
	].join("\n");
}

function templatesText(config: ScrutinyConfig): string {
	return [
		"# scrutiny templates",
		"",
		...allTemplates(config).map((template) => {
			if (template.surface === "verify") return `- @${template.name} · verify · objective checks`;
			return `- @${template.name} · ${template.surface} · ${template.strategy} · panel:${template.panel ?? config.defaultPanel ?? "select one"}${template.lenses ? ` · lenses:${template.lenses.join(", ")}` : ""}`;
		}),
		"",
		"use: `/scrutiny @<template>: <prompt>`",
	].join("\n");
}

function requiresPanelSetup(params: ScrutinyParams, config: ScrutinyConfig): boolean {
	try {
		resolveRunPlan({
			templateName: params.template ?? params.surface ?? inferSurface(params.prompt),
			panelName: params.panel,
			includeGitDiff: params.includeGitDiff,
			judgeMode: params.judgeMode,
			verify: params.verify,
		}, config);
		return false;
	} catch (error) {
		return error instanceof MissingPanelError;
	}
}

function formatPanelMember(member: { model: string; thinking?: string }): string {
	return `${member.model}${member.thinking ? ` think:${member.thinking}` : ""}`;
}
