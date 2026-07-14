import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { councilToParams, exampleConfigJson, projectConfigPath, readScrutinyConfig, userConfigPath } from "./scrutiny/config.js";
import { SCRUTINY_PACKET_PREVIEW_CANCELLED, runScrutiny } from "./scrutiny/engine.js";
import { historyText, showHistoryPicker } from "./scrutiny/history.js";
import { confirmPacketPreview } from "./scrutiny/preview.js";
import { activeProgresses, recentRuns } from "./scrutiny/registry.js";
import { showScrutinyPalette } from "./scrutiny/palette.js";
import { SCRUTINY_STOP_STATEMENT, SCRUTINY_SURFACES, SCRUTINY_SURFACE_SET, SURFACE_DOCS } from "./scrutiny/surfaces.js";
import type { ScrutinyParams, ScrutinySurface } from "./scrutiny/types.js";
import { scrutinyStatusText, renderScrutinyDock, renderScrutinyMessage } from "./scrutiny/ui.js";

function refreshScrutinyChrome(ctx: ExtensionContext, latest?: unknown): void {
	if (!ctx.hasUI) return;
	const active = activeProgresses();
	if (active.length > 0) {
		ctx.ui.setStatus("scrutiny", `scrutiny [${active.length} active]`);
		ctx.ui.setWidget("scrutiny", renderScrutinyDock(active, ctx.ui.theme), { placement: "belowEditor" });
		return;
	}
	ctx.ui.setStatus("scrutiny", latest ? scrutinyStatusText(latest) : undefined);
	ctx.ui.setWidget("scrutiny", undefined);
}

function clearScrutinyChrome(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (activeProgresses().length > 0) return refreshScrutinyChrome(ctx);
	ctx.ui.setStatus("scrutiny", undefined);
	ctx.ui.setWidget("scrutiny", undefined);
}

type ScrutinyMessage = {
	customType: "scrutiny-result";
	content: string;
	display: boolean;
	details: unknown;
};

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
		description: "Run or inspect Pi Scrutiny by explicit command (usage: /scrutiny | help | models | runs | history | panels | config | <surface>: <prompt> | @<panel>: <prompt> | ask <prompt>)",
		handler: async (args, ctx) => {
			await waitForPiIdle(ctx);
			const runAndPublish = async (params: ScrutinyParams) => {
				try {
					if (ctx.hasUI) ctx.ui.setStatus("scrutiny", "scrutiny starting");
					const { result, brief } = await runScrutiny({
						params,
						cwd: ctx.cwd,
						projectTrusted: ctx.isProjectTrusted(),
						exec: (command, execArgs, options) => pi.exec(command, execArgs, options),
						signal: ctx.signal,
						confirmPacket: ctx.hasUI ? (preview) => confirmPacketPreview(ctx, preview) : undefined,
						onProgress: (progress) => {
							refreshScrutinyChrome(ctx, progress);
						},
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
				const params = await showScrutinyPalette(ctx);
				if (params) await runAndPublish(params);
				return;
			}
			if (trimmed === "help") {
				publishScrutinyMessage(pi, { customType: "scrutiny-result", content: helpText(), display: true, details: { kind: "help" } });
				return;
			}
			if (trimmed === "models") {
				const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
				publishScrutinyMessage(pi, { customType: "scrutiny-result", content: modelsText(config), display: true, details: { kind: "models" } });
				return;
			}
			if (trimmed === "runs") {
				publishScrutinyMessage(pi, { customType: "scrutiny-result", content: runsText(), display: true, details: { kind: "runs" } });
				return;
			}
			if (trimmed === "history") {
				const content = ctx.hasUI ? await showHistoryPicker(ctx) : await historyText(ctx.cwd, "");
				if (content) publishScrutinyMessage(pi, { customType: "scrutiny-result", content, display: true, details: { kind: "history" } });
				return;
			}
			if (trimmed.startsWith("history ")) {
				const content = await historyText(ctx.cwd, trimmed.slice("history".length).trim());
				publishScrutinyMessage(pi, { customType: "scrutiny-result", content, display: true, details: { kind: "history" } });
				return;
			}
			if (trimmed === "panels" || trimmed === "councils") {
				const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
				publishScrutinyMessage(pi, { customType: "scrutiny-result", content: panelsText(config), display: true, details: { kind: "panels" } });
				return;
			}
			if (trimmed === "config" || trimmed.startsWith("config ")) {
				await handleConfigCommand(trimmed.slice("config".length).trim(), ctx, pi);
				return;
			}
			const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
			const { params: parsed, prompt } = parseInline(trimmed, config);
			if (!prompt && parsed.surface !== "verify") {
				ctx.ui.notify("usage: /scrutiny ask <prompt>  |  /scrutiny <surface>: <prompt>", "warning");
				return;
			}
			await runAndPublish({ prompt: prompt || "run objective repo checks", ...parsed });
		},
	});
}

function parseInline(trimmed: string, config: ReturnType<typeof readScrutinyConfig>): { params: Partial<ScrutinyParams>; prompt: string } {
	const colonIdx = trimmed.indexOf(":");
	if (colonIdx > 0) {
		const head = trimmed.slice(0, colonIdx).trim();
		const rest = trimmed.slice(colonIdx + 1).trim();
		if (head.startsWith("@")) {
			const council = config.councils.find((item) => item.name === head.slice(1));
			if (council) return { params: councilToParams(council, rest), prompt: rest };
		}
		if (head && SCRUTINY_SURFACE_SET.has(head as ScrutinySurface)) {
			return { params: { surface: head as ScrutinySurface }, prompt: rest };
		}
	}
	const prompt = trimmed.startsWith("ask ") ? trimmed.slice(4).trim() : trimmed;
	return { params: {}, prompt };
}

async function handleConfigCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "show") {
		const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		publishScrutinyMessage(pi, { customType: "scrutiny-result", content: configText(config), display: true, details: { kind: "config" } });
		return;
	}
	if (trimmed === "edit" || trimmed === "edit global" || trimmed === "edit user") {
		await editConfigFile("global", ctx);
		return;
	}
	if (trimmed === "edit project") {
		await editConfigFile("project", ctx);
		return;
	}
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

function configText(config: ReturnType<typeof readScrutinyConfig>): string {
	const sourceRows = config.configSources.map((source) => {
		const where = source.path ? ` — ${source.path}` : "";
		const reason = source.reason ? ` (${source.reason})` : "";
		return `- ${source.scope}: ${source.status}${reason}${where}`;
	});
	return [
		"# scrutiny config",
		"",
		"config files load in this order: global → trusted project → env overrides.",
		"",
		"## sources",
		...(sourceRows.length ? sourceRows : ["- env: no PI_SCRUTINY_* overrides"]),
		"",
		"## active",
		`- panel: ${config.panel.length ? config.panel.map(formatPanelMember).join(", ") : "not configured"}`,
		`- saved panels: ${config.councils.length}`,
		`- trade-off explainer: ${config.judge ?? "first panel model"}`,
		`- max panel: ${config.maxPanelModels}`,
		`- tools: ${config.tools.length ? config.tools.join(", ") : "none"}`,
		`- verify checks: ${config.verifyChecks.map((c) => c.name).join(", ") || "none"}`,
		"",
		"## edit",
		"- `/scrutiny config edit` edits global `~/.pi/agent/scrutiny.json`.",
		"- `/scrutiny config edit project` edits project `.pi/scrutiny.json` (trusted projects only).",
		"- env vars still override files for shell-specific experiments.",
	].join("\n");
}

function helpText(): string {
	return [
		"# pi-scrutiny",
		"",
		"multi-model panel for deliberation, plus objective repo verification. not patch scrutiny.",
		"",
		"surfaces:",
		...SCRUTINY_SURFACES.map((surface) => `- \`${surface}\` — ${SURFACE_DOCS[surface].mode}. ${SURFACE_DOCS[surface].description}`),
		"",
		"activation: Scrutiny starts only when you invoke /scrutiny or confirm through its palette. Natural-language requests do not start a run.",
		"there is no model-callable Scrutiny tool. Writing \"Use Scrutiny...\" in ordinary prose does not invoke it.",
		"before panel spend: human reviews and confirms exact packet in TUI.",
		"flow: surfaces run inline and stream a status footer while the panel works. press esc to cancel a run.",
		"mode: replicate means same prompt and disagreement signal; roles means lenses and coverage/gaps signal.",
		"panelists run sequentially. one scrutiny run at a time.",
		"arbiter is objective repo tools + human review, never an LLM judge. do not fuse patches.",
		"completion: result displays and persists. Pi remains idle; result stays in context for a later human prompt.",
		"no synthesis, diagnostics, edits, or implementation begin automatically.",
		SCRUTINY_STOP_STATEMENT,
		"",
		"```text",
		"/scrutiny                          # open palette",
		"/scrutiny models",
		"/scrutiny runs                     # recent runs this session",
		"/scrutiny history                  # interactive run history search",
		"/scrutiny history list [query]     # text history for scripts",
		"/scrutiny history open <runId|latest> [result|summary|surface|packet|responses|verify]",
		"/scrutiny history delete <runId|latest> [--yes]  # preview without --yes; removes run dir + rebuilds index",
		"/scrutiny history clear [--yes]              # preview without --yes; removes every run dir",
		"/scrutiny panels                   # list saved panel presets",
		"/scrutiny config                   # show config files + active settings",
		"/scrutiny config edit [project]    # edit ~/.pi/agent/scrutiny.json or .pi/scrutiny.json",
		"/scrutiny verify:                  # run objective checks now",
		"/scrutiny @code-duo: review this patch   # run a saved panel",
		"/scrutiny risks: review this webflux retry patch",
		"/scrutiny hypotheses: intermittent offset commit on kafka consumer",
		"/scrutiny ask compare these two implementation plans",
		"```",
		"",
		"Preferred setup: `/scrutiny config edit`. Env vars still work (`PI_SCRUTINY_PANEL=provider/model,provider/model`).",
	].join("\n");
}

function modelsText(config: ReturnType<typeof readScrutinyConfig>): string {
	return [
		"# scrutiny models",
		"",
		`panel: ${config.panel.length ? config.panel.map(formatPanelMember).join(", ") : "not configured"}`,
		`trade-off explainer: ${config.judge ?? "first panel model"}`,
		`max panel: ${config.maxPanelModels}`,
		`tools: ${config.tools.length ? config.tools.join(", ") : "none"}`,
		`verify checks: ${config.verifyChecks.map((c) => c.name).join(", ") || "none"}`,
		"",
		"Run `/scrutiny config edit` for persistent setup. `PI_SCRUTINY_*` env vars still override files.",
	].join("\n");
}

function runsText(): string {
	const runs = recentRuns();
	if (runs.length === 0) return "# scrutiny runs\n\nno runs yet in this session.";
	const rows = runs.map((r) => {
		const time = new Date(r.startedAt).toLocaleTimeString();
		const ended = r.endedAt ? ` · ${new Date(r.endedAt).toLocaleTimeString()}` : "";
		const err = r.error ? ` · ${r.error}` : "";
		return `- ${r.runId} · ${r.surface} · ${r.status}${ended}${err} · ${time}\n  ${r.runDir ?? "(no artifacts)"}`;
	});
	return ["# scrutiny runs", "", ...rows, "", "artifacts (packet/responses/verify/result.json) live under each run dir."].join("\n");
}

function panelsText(config: ReturnType<typeof readScrutinyConfig>): string {
	const panels = config.councils;
	if (panels.length === 0) return "# scrutiny saved panels\n\nno saved panels configured. run `/scrutiny config edit` and add a `panels` object.";
	const rows = panels.map((c) => {
		const members = c.panelists.map(formatPanelMember).join(", ");
		return `- @${c.name} · ${c.surface} · ${members || "no members"}${c.judgeMode ? ` · map:${c.judgeMode}` : ""}${c.verify ? " · verify:on" : ""}`;
	});
	return ["# scrutiny saved panels", "", ...rows, "", "use: `/scrutiny @<name>: <prompt>`"].join("\n");
}

function formatPanelMember(member: { model: string; lens?: string; thinking?: string }): string {
	return `${member.model}${member.lens ? ` (${member.lens})` : ""}${member.thinking ? ` think:${member.thinking}` : ""}`;
}
