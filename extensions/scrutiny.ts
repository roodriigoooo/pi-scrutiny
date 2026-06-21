import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { councilToParams, exampleConfigJson, projectConfigPath, readScrutinyConfig, userConfigPath } from "./scrutiny/config.js";
import { runScrutiny } from "./scrutiny/engine.js";
import { historyText } from "./scrutiny/history.js";
import { activeProgresses, recentRuns } from "./scrutiny/registry.js";
import { showScrutinyPalette } from "./scrutiny/palette.js";
import type { ScrutinyParams, ScrutinySurface } from "./scrutiny/types.js";
import { scrutinyStatusText, renderScrutinyCall, renderScrutinyDock, renderScrutinyMessage, renderScrutinyResult } from "./scrutiny/ui.js";

const SurfaceEnum = StringEnum(["consult", "hypotheses", "criteria", "repo-map", "risks", "verify"] as const);
const JudgeModeEnum = StringEnum(["auto", "off", "on"] as const);

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

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer("scrutiny-result", renderScrutinyMessage);

	pi.registerTool({
		name: "scrutiny_consult",
		label: "Scrutiny Consult",
		description: [
			"Run a multi-model panel deliberation surface, OR run objective repo verification. This is NOT patch scrutiny.",
			"Surfaces: consult (research synthesis), hypotheses (root-cause + distinguishing tests), criteria (acceptance spec), repo-map (context for an edit), risks (per-class risk review of a patch), verify (runs tests/typecheck/lint as the objective arbiter).",
			"The main Pi agent synthesizes and acts. Arbiter is objective repo tools + human review, never an LLM judge. Do not fuse patches.",
		].join(" "),
		promptSnippet: "Consult a multi-model panel for hypotheses, criteria, context, or risk review; or run objective verify. Do not use to fuse patches.",
		promptGuidelines: [
			"Use scrutiny_consult for deliberation that benefits from independent perspectives: hypotheses, criteria, repo-map, risks, or bounded research synthesis.",
			"Use the verify surface to run objective repo checks (tests/typecheck/lint) as the real arbiter of a change.",
			"Never use scrutiny to merge patches from multiple models into one diff. Fuse uncertainty, evidence, tests, plans, context, risks — not final code.",
			"If panelists disagree sharply, treat it as a stop signal: gather more evidence or ask the human; do not smooth disagreement into a synthesized answer.",
			"Panel deliberation can take time. Mention that input cost is replicated across panel models when proposing an expensive panel.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Focused task for the panel or the verify check description." }),
			context: Type.Optional(Type.String({ description: "Extra compact context to include in the task packet." })),
			surface: Type.Optional(SurfaceEnum),
			panel: Type.Optional(Type.Array(Type.String({ description: "Model id, e.g. openai/gpt-5.5 or moonshotai/kimi-2.7-code." }), { description: "Panel models. Defaults to PI_SCRUTINY_PANEL." })),
			judge: Type.Optional(Type.String({ description: "Trade-off explainer model. Defaults to PI_SCRUTINY_JUDGE or first panel model. Only runs for consult by default." })),
			judgeMode: Type.Optional(JudgeModeEnum),
			maxPanelModels: Type.Optional(Type.Number({ description: "Clamp panel size. Default from PI_SCRUTINY_MAX_PANEL_MODELS." })),
			includeGitDiff: Type.Optional(Type.Boolean({ description: "Include current git diff in packet. Defaults per surface." })),
			verify: Type.Optional(Type.Boolean({ description: "Run objective repo checks after the panel. Defaults per surface (on for risks/verify)." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Tools allowed to panel/judge. Default none. Prefer none." })),
		}),
		async execute(_toolCallId, params: ScrutinyParams, signal, onUpdate, ctx) {
			const { result, brief } = await runScrutiny({
				params,
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				exec: (command, args, options) => pi.exec(command, args, { ...options, signal: options?.signal ?? signal }),
				signal,
				onProgress: (progress) => {
					onUpdate?.({ content: [{ type: "text", text: scrutinyStatusText(progress) }], details: progress });
					refreshScrutinyChrome(ctx, progress);
				},
			});
			clearScrutinyChrome(ctx);
			return {
				content: [{ type: "text", text: brief }],
				details: result,
			};
		},
		renderCall: renderScrutinyCall,
		renderResult: renderScrutinyResult,
	});

	pi.registerCommand("scrutiny", {
		description: "Run or inspect Pi Scrutiny (usage: /scrutiny | help | models | runs | history | councils | config | <surface>: <prompt> | @<council>: <prompt> | ask <prompt>)",
		handler: async (args, ctx) => {
			const runAndPublish = async (params: ScrutinyParams) => {
				try {
					if (ctx.hasUI) ctx.ui.setStatus("scrutiny", "scrutiny starting");
					const { result, brief } = await runScrutiny({
						params,
						cwd: ctx.cwd,
						projectTrusted: ctx.isProjectTrusted(),
						exec: (command, execArgs, options) => pi.exec(command, execArgs, options),
						signal: ctx.signal,
						onProgress: (progress) => {
							refreshScrutinyChrome(ctx, progress);
						},
					});
					clearScrutinyChrome(ctx);
					pi.sendMessage({ customType: "scrutiny-result", content: brief, display: true, details: result });
				} catch (error) {
					clearScrutinyChrome(ctx);
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
				pi.sendMessage({ customType: "scrutiny-result", content: helpText(), display: true, details: { kind: "help" } });
				return;
			}
			if (trimmed === "models") {
				const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
				pi.sendMessage({ customType: "scrutiny-result", content: modelsText(config), display: true, details: { kind: "models" } });
				return;
			}
			if (trimmed === "runs") {
				pi.sendMessage({ customType: "scrutiny-result", content: runsText(), display: true, details: { kind: "runs" } });
				return;
			}
			if (trimmed === "history" || trimmed.startsWith("history ")) {
				const content = await historyText(ctx.cwd, trimmed.slice("history".length).trim());
				pi.sendMessage({ customType: "scrutiny-result", content, display: true, details: { kind: "history" } });
				return;
			}
			if (trimmed === "councils") {
				const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
				pi.sendMessage({ customType: "scrutiny-result", content: councilsText(config), display: true, details: { kind: "councils" } });
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

const SCRUTINY_SURFACE_SET = new Set<ScrutinySurface>(["consult", "hypotheses", "criteria", "repo-map", "risks", "verify"]);

async function handleConfigCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "show") {
		const config = readScrutinyConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		pi.sendMessage({ customType: "scrutiny-result", content: configText(config), display: true, details: { kind: "config" } });
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
		`- panel: ${config.panel.length ? config.panel.join(", ") : "not configured"}`,
		`- councils: ${config.councils.length}`,
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
		"- `consult` — bounded research/synthesis (the validated scrutiny use). trade-off explainer runs by default.",
		"- `hypotheses` — ranked root causes + confirming evidence + minimal distinguishing tests. no fix yet.",
		"- `criteria` — fused acceptance spec: edge cases, backward-compat, migration, test cases.",
		"- `repo-map` — compact context (symbols, call paths, tests, config, invariants) for an upcoming edit.",
		"- `risks` — per-class risk review of a patch (concurrency, reactive-chain, api-compat, security, perf, migration, null, flaky). runs verify.",
		"- `verify` — runs tests/typecheck/lint as the objective arbiter. no panel, no judge.",
		"",
		"flow: surfaces run inline and stream a status footer while the panel works. press esc to cancel a run.",
		"arbiter is objective repo tools + human review, never an LLM judge. do not fuse patches.",
		"",
		"```text",
		"/scrutiny                          # open palette",
		"/scrutiny models",
		"/scrutiny runs                     # recent runs this session",
		"/scrutiny history [query]          # searchable on-disk run summaries",
		"/scrutiny history open <runId|latest> [result|summary|packet|responses|verify]",
		"/scrutiny councils                 # list named council presets",
		"/scrutiny config                   # show config files + active settings",
		"/scrutiny config edit [project]    # edit ~/.pi/agent/scrutiny.json or .pi/scrutiny.json",
		"/scrutiny verify:                  # run objective checks now",
		"/scrutiny @code-duo: review this patch   # run a named council",
		"/scrutiny risks: review this webflux retry patch",
		"/scrutiny hypotheses: intermittent offset commit on kafka consumer",
		"/scrutiny ask compare these two implementation plans",
		"```",
		"",
		"Tool: `scrutiny_consult`. Preferred setup: `/scrutiny config edit`. Env vars still work (`PI_SCRUTINY_PANEL=provider/model,provider/model`).",
	].join("\n");
}

function modelsText(config: ReturnType<typeof readScrutinyConfig>): string {
	return [
		"# scrutiny models",
		"",
		`panel: ${config.panel.length ? config.panel.join(", ") : "not configured"}`,
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

function councilsText(config: ReturnType<typeof readScrutinyConfig>): string {
	const councils = config.councils;
	if (councils.length === 0) return "# scrutiny councils\n\nno councils configured. run `/scrutiny config edit` and add a `councils` object.";
	const rows = councils.map((c) => {
		const panelists = c.panelists.map((p) => `${p.model}${p.lens ? ` (${p.lens})` : ""}`).join(", ");
		return `- @${c.name} · ${c.surface} · ${panelists || "no panel"}${c.judgeMode ? ` · explainer:${c.judgeMode}` : ""}${c.verify ? " · verify:on" : ""}`;
	});
	return ["# scrutiny councils", "", ...rows, "", "use: `/scrutiny @<name>: <prompt>`"].join("\n");
}
