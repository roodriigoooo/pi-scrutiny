import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	PanelNameCollisionError,
	PanelReferencedError,
	readScrutinyConfig,
	removeUserPanel,
	renameUserPanel,
	saveUserPanel,
	setDefaultUserPanel,
	userConfigPath,
} from "../extensions/scrutiny/config.ts";
import { showPanelManager } from "../extensions/scrutiny/manager.ts";
import { showScrutinyPalette } from "../extensions/scrutiny/palette.ts";
import { NO_AUTHENTICATED_MODELS, PANEL_SETUP_NON_INTERACTIVE, showPanelSetup, supportedThinkingLevels } from "../extensions/scrutiny/setup.ts";
import { ConfigurationError } from "../extensions/scrutiny/templates.ts";

const failures: Array<{ name: string; error: string }> = [];
let checks = 0;

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
	checks += 1;
	try {
		await run();
		process.stdout.write(`  ✓ ${name}\n`);
	} catch (error) {
		failures.push({ name, error: error instanceof Error ? error.message : String(error) });
		process.stdout.write(`  ✕ ${name}\n`);
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function stableJson(value: unknown): string {
	const canonical = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(canonical);
		if (!item || typeof item !== "object") return item;
		return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)]));
	};
	return JSON.stringify(canonical(value));
}

async function rejects(run: () => Promise<unknown>, errorType: new (...args: any[]) => Error): Promise<void> {
	try {
		await run();
	} catch (error) {
		assert(error instanceof errorType, `expected ${errorType.name}, got ${error instanceof Error ? error.constructor.name : String(error)}`);
		return;
	}
	throw new Error(`expected ${errorType.name} to be thrown`);
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const tui = { requestRender() {} };
const KEY = {
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	space: " ",
	right: "\x1b[C",
	ctrlG: "\x1b[103;5u",
	ctrlJ: "\x1b[106;5u",
	ctrlS: "\x1b[115;5u",
	ctrlV: "\x1b[118;5u",
};

const model = {
	provider: "provider-a",
	id: "model-one",
	name: "Model One",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh" },
};

function makeContext(input: {
	cwd: string;
	mode?: "tui" | "rpc" | "json" | "print";
	models?: unknown[];
	ui?: Record<string, unknown>;
	onRegistryAccess?: () => void;
}): ExtensionCommandContext {
	const baseUi = {
		theme,
		custom: async () => { throw new Error("unexpected custom UI"); },
		select: async () => undefined,
		input: async () => undefined,
		confirm: async () => false,
		notify: () => undefined,
	};
	return {
		mode: input.mode ?? "tui",
		hasUI: (input.mode ?? "tui") === "tui" || input.mode === "rpc",
		cwd: input.cwd,
		ui: { ...baseUi, ...input.ui },
		modelRegistry: {
			refresh: () => input.onRegistryAccess?.(),
			getAvailable: () => {
				input.onRegistryAccess?.();
				return input.models ?? [];
			},
		},
		isProjectTrusted: () => false,
		isIdle: () => true,
		waitForIdle: async () => undefined,
	} as unknown as ExtensionCommandContext;
}

async function withAgentDir(run: (paths: { root: string; agent: string; cwd: string }) => Promise<void> | void): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrutiny-setup-"));
	const agent = path.join(root, "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		await run({ root, agent, cwd });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	process.stdout.write("scrutiny setup and panel management · 14 checks\n");
	const scrutinyEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_SCRUTINY_")));
	for (const key of Object.keys(scrutinyEnv)) delete process.env[key];

	try {
		await check("global panel save is v2, private, reloadable, and collision-safe", () => withAgentDir(async ({ cwd }) => {
			const panel = { name: "balanced", members: [{ model: "provider-a/model-one", thinking: "low" as const }] };
			const file = await saveUserPanel(panel);
			const document = JSON.parse(fs.readFileSync(file, "utf8"));
			assert(document.schemaVersion === 2, "schemaVersion not saved");
			assert(document.defaultPanel === "balanced", "first panel not made default");
			assert(document.panels.balanced.members[0].model === "provider-a/model-one", "v2 panel member missing");
			assert(!("lens" in document.panels.balanced.members[0]), "setup saved bundled panel schema");
			assert((fs.statSync(file).mode & 0o777) === 0o600, "global config permissions are not 0600");
			const reloaded = readScrutinyConfig({ cwd, projectTrusted: false });
			assert(reloaded.defaultPanel === "balanced" && reloaded.panels[0]?.members[0]?.thinking === "low", "saved panel did not reload");
			await rejects(() => saveUserPanel(panel), PanelNameCollisionError);
			await saveUserPanel({ name: "balanced", members: [{ model: "provider-b/model-two", thinking: "off" }] }, { overwrite: true });
			assert(readScrutinyConfig({ cwd }).panels[0]?.members[0]?.model === "provider-b/model-two", "confirmed overwrite path failed");
		}));

		await check("setup explicitly migrates legacy settings with a lossless backup before saving", () => withAgentDir(async ({ agent, cwd }) => {
			fs.mkdirSync(agent, { recursive: true });
			const legacy = `${JSON.stringify({
				panel: [{ model: "provider-old/default", thinking: "low" }],
				panels: {
					"old-risk": {
						surface: "risks",
						members: [
							{ model: "provider-old/api", lens: "api compatibility", thinking: "medium" },
							{ model: "provider-old/failure", lens: "failure semantics", thinking: "off" },
						],
						judgeMode: "off",
						includeGitDiff: false,
						verify: true,
					},
				},
				judge: "provider-old/judge",
				maxPanelModels: 4,
				verifyChecks: [{ name: "custom-check", command: "npm", args: ["run", "custom"], timeoutMs: 9000 }],
			}, null, 2)}\n`;
			fs.writeFileSync(userConfigPath(), legacy, { mode: 0o600 });
			const before = readScrutinyConfig({ cwd });
			const notifications: string[] = [];
			let migrationConfirmations = 0;
			const ctx = makeContext({
				cwd,
				models: [model],
				ui: {
					custom: async (factory: any) => {
						let result: unknown;
						const component = await factory(tui, theme, {}, (value: unknown) => { result = value; });
						component.handleInput(KEY.space);
						component.handleInput(KEY.ctrlS);
						return result;
					},
					input: async () => "new-panel",
					confirm: async (title: string) => {
						if (title.includes("Upgrade")) migrationConfirmations += 1;
						return true;
					},
					notify: (message: string) => notifications.push(message),
				},
			});
			const result = await showPanelSetup(ctx);
			assert(result?.panelName === "new-panel", "panel was not saved after migration");
			assert(migrationConfirmations === 1, "legacy migration was not explicit");
			const migrated = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
			assert(migrated.schemaVersion === 2, "legacy file was not migrated");
			const backups = fs.readdirSync(agent).filter((name) => name.startsWith("scrutiny.json.legacy-backup-"));
			assert(backups.length === 1, "private legacy backup was not created");
			assert(fs.readFileSync(path.join(agent, backups[0]!), "utf8") === legacy, "legacy backup is not byte-for-byte");
			assert((fs.statSync(path.join(agent, backups[0]!)).mode & 0o777) === 0o600, "legacy backup permissions are not private");
			const after = readScrutinyConfig({ cwd });
			assert(after.defaultPanel === before.defaultPanel, "effective default changed during migration");
			assert(JSON.stringify(after.panels.filter((panel) => panel.name !== "new-panel")) === JSON.stringify(before.panels), "existing effective panels changed");
			assert(stableJson(after.templates) === stableJson(before.templates), "effective templates, lenses, or policies changed");
			assert(after.judge === before.judge && JSON.stringify(after.verifyChecks) === JSON.stringify(before.verifyChecks), "effective global policies changed");
			assert(notifications.some((message) => message.includes("original backed up") && message.includes("Continuing with the selected lineup")), "migration outcome and next action were not explained");
		}));

		await check("panel mutations preserve references, defaults, collisions, and deletion safety", () => withAgentDir(async ({ agent, cwd }) => {
			fs.mkdirSync(agent, { recursive: true });
			fs.writeFileSync(userConfigPath(), `${JSON.stringify({
				schemaVersion: 2,
				defaultPanel: "alpha",
				panels: {
					alpha: { members: [{ model: "provider/a", thinking: "low" }] },
					beta: { members: [{ model: "provider/b", thinking: "off" }] },
				},
				templates: {
					"release-risk": {
						surface: "risks",
						strategy: "roles",
						panel: "alpha",
						lenses: ["api compatibility"],
						judgeMode: "off",
						includeGitDiff: true,
						verify: true,
					},
				},
			}, null, 2)}\n`, { mode: 0o600 });
			await rejects(() => renameUserPanel("alpha", "gamma"), PanelReferencedError);
			await rejects(() => renameUserPanel("alpha", "beta", { updateTemplateReferences: true }), PanelNameCollisionError);
			await renameUserPanel("alpha", "gamma", { updateTemplateReferences: true });
			let document = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
			assert(document.defaultPanel === "gamma", "default did not follow renamed panel");
			assert(document.templates["release-risk"].panel === "gamma", "template reference did not follow renamed panel");
			assert(!document.panels.alpha && document.panels.gamma, "panel rename was not atomic");
			await setDefaultUserPanel("beta");
			assert(readScrutinyConfig({ cwd }).defaultPanel === "beta", "default panel change failed");
			await rejects(() => removeUserPanel("gamma"), PanelReferencedError);
			await removeUserPanel("gamma", { removeReferencedTemplates: true });
			document = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
			assert(!document.panels.gamma && !document.templates["release-risk"], "confirmed referenced deletion left broken config");
			await removeUserPanel("beta");
			document = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
			assert(Object.keys(document.panels).length === 0 && !("defaultPanel" in document), "removing final default left a broken reference");
		}));

		await check("canceling the panel manager leaves the config byte-for-byte unchanged", () => withAgentDir(async ({ cwd }) => {
			await saveUserPanel({ name: "balanced", members: [{ model: "provider/a", thinking: "off" }] });
			const before = fs.readFileSync(userConfigPath(), "utf8");
			const ctx = makeContext({ cwd, ui: { select: async () => undefined } });
			await showPanelManager(ctx);
			assert(fs.readFileSync(userConfigPath(), "utf8") === before, "cancelled manager rewrote config");
		}));

		await check("panel manager changes the default through an explicit no-spend TUI action", () => withAgentDir(async ({ cwd }) => {
			await saveUserPanel({ name: "alpha", members: [{ model: "provider/a", thinking: "off" }] });
			await saveUserPanel({ name: "beta", members: [{ model: "provider/b", thinking: "low" }] });
			let selects = 0;
			let confirmations = 0;
			const ctx = makeContext({
				cwd,
				ui: {
					select: async (_title: string, options: string[]) => {
						selects += 1;
						if (selects === 1) return options.find((option) => option.includes("beta"));
						if (selects === 2) return "Set as default";
						return undefined;
					},
					confirm: async () => {
						confirmations += 1;
						return true;
					},
				},
			});
			await showPanelManager(ctx);
			assert(confirmations === 1, "default consequence was not confirmed");
			assert(readScrutinyConfig({ cwd }).defaultPanel === "beta", "manager did not change the default");
		}));

		await check("atomic write failure preserves the previous config", () => withAgentDir(async ({ agent, cwd }) => {
			await saveUserPanel({ name: "alpha", members: [{ model: "provider/a", thinking: "off" }] });
			await saveUserPanel({ name: "beta", members: [{ model: "provider/b", thinking: "low" }] });
			const before = fs.readFileSync(userConfigPath(), "utf8");
			fs.chmodSync(agent, 0o500);
			try {
				await rejects(() => setDefaultUserPanel("beta"), ConfigurationError);
			} finally {
				fs.chmodSync(agent, 0o700);
			}
			assert(fs.readFileSync(userConfigPath(), "utf8") === before, "failed atomic write changed prior config");
			assert(readScrutinyConfig({ cwd }).defaultPanel === "alpha", "failed write changed effective default");
		}));

		await check("recoverable save failure retries without losing lineup or thinking selection", () => withAgentDir(async ({ agent, cwd }) => {
			fs.mkdirSync(agent, { recursive: true });
			let retries = 0;
			const ctx = makeContext({
				cwd,
				models: [model],
				ui: {
					custom: async (factory: any) => {
						let result: unknown;
						const component = await factory(tui, theme, {}, (value: unknown) => { result = value; });
						component.handleInput(KEY.space);
						component.handleInput(KEY.right);
						component.handleInput(KEY.ctrlS);
						fs.chmodSync(agent, 0o500);
						return result;
					},
					input: async () => "retry-panel",
					confirm: async (title: string) => {
						if (!title.includes("Try saving")) return false;
						retries += 1;
						fs.chmodSync(agent, 0o700);
						return true;
					},
				},
			});
			try {
				const result = await showPanelSetup(ctx);
				assert(result?.panelName === "retry-panel" && retries === 1, "recoverable failure did not retry");
				const panel = readScrutinyConfig({ cwd }).panels.find((item) => item.name === "retry-panel");
				assert(panel?.members[0]?.model === "provider-a/model-one" && panel.members[0].thinking === "minimal", "retry lost selected lineup or thinking");
			} finally {
				fs.chmodSync(agent, 0o700);
			}
		}));

		await check("picker thinking controls follow model capabilities", () => {
			assert(supportedThinkingLevels({ reasoning: false }).join(",") === "off", "non-reasoning model should expose off only");
			const levels = supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null, low: null, xhigh: "max" } });
			assert(!levels.includes("off") && !levels.includes("low"), "unsupported levels were exposed");
			assert(levels.includes("minimal") && levels.includes("xhigh"), "supported levels were hidden");
		});

		await check("editing preserves unavailable members and an implicit thinking default", () => withAgentDir(async ({ cwd }) => {
			const initial = {
				name: "mixed",
				members: [
					{ model: "provider-a/model-one" },
					{ model: "provider-old/unavailable", thinking: "high" as const },
				],
			};
			await saveUserPanel(initial);
			let rendered = "";
			const ctx = makeContext({
				cwd,
				models: [],
				ui: {
					custom: async (factory: any) => {
						let result: unknown;
						const component = await factory(tui, theme, {}, (value: unknown) => { result = value; });
						rendered = component.render(110).join("\n");
						component.handleInput(KEY.ctrlS);
						return result;
					},
				},
			});
			const result = await showPanelSetup(ctx, { initialPanel: initial });
			assert(result?.panelName === "mixed", "edit did not save");
			assert(rendered.includes("2/4") && rendered.includes("think:default") && rendered.includes("provider-old/unavailable"), "existing lineup was not preselected legibly");
			const document = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
			assert(!("thinking" in document.panels.mixed.members[0]), "implicit thinking default was silently changed");
			assert(document.panels.mixed.members[1].thinking === "high", "unavailable member thinking was lost");
		}));

		await check("unconfigured palette preserves task, template, and toggles across setup", () => withAgentDir(async ({ cwd }) => {
			let customCalls = 0;
			let afterSetup = "";
			const notifications: string[] = [];
			const ctx = makeContext({
				cwd,
				models: [model],
				ui: {
					input: async () => "balanced",
					notify: (message: string) => notifications.push(message),
					custom: async (factory: any) => {
						customCalls += 1;
						let completed = false;
						let result: unknown;
						const component = await factory(tui, theme, {}, (value: unknown) => {
							completed = true;
							result = value;
						});
						if (customCalls === 1) {
							component.handleInput(KEY.tab);
							component.handleInput(KEY.ctrlJ);
							component.handleInput(KEY.ctrlJ);
							component.handleInput(KEY.ctrlG);
							component.handleInput(KEY.ctrlV);
							component.handleInput(KEY.enter);
						} else if (customCalls === 2) {
							const beforeSelection = component.render(100).join("\n");
							assert(beforeSelection.includes("0/") && beforeSelection.includes("[ ]") && beforeSelection.includes("not selected") && !beforeSelection.includes("[x]"), "setup silently selected a model");
							component.handleInput(KEY.space);
							component.handleInput(KEY.right);
							component.handleInput(KEY.ctrlS);
						} else if (customCalls === 3) {
							afterSetup = component.render(110).join("\n");
							component.handleInput(KEY.escape);
						}
						assert(completed, `custom UI call ${customCalls} did not complete`);
						return result;
					},
				},
			});

			const selected = await showScrutinyPalette(ctx, "preserve this exact task");
			assert(selected === null, "palette should have been cancelled after returning from setup");
			assert(customCalls === 3, "setup did not return to palette before any run");
			assert(afterSetup.includes("preserve this exact task"), "task prompt was lost");
			assert(afterSetup.includes("template:hypotheses"), "template selection was lost");
			assert(afterSetup.includes("panel:balanced"), "saved panel was not selected after reload");
			assert(afterSetup.includes("map:auto") && afterSetup.includes("git:off") && afterSetup.includes("verify:on"), "palette toggles were lost");
			assert(notifications.some((message) => message.includes("Review task packet before running")), "save did not reinforce final review gate");
			const document = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
			assert(document.panels.balanced.members[0].thinking === "minimal", "per-member thinking choice was not saved");
		}));

		await check("declined name collision preserves existing panel and accepts another name", () => withAgentDir(async ({ cwd }) => {
			await saveUserPanel({ name: "balanced", members: [{ model: "provider-old/model", thinking: "off" }] });
			const names = ["balanced", "alternate"];
			let confirmations = 0;
			const ctx = makeContext({
				cwd,
				models: [model],
				ui: {
					custom: async (factory: any) => {
						let completed = false;
						let result: unknown;
						const component = await factory(tui, theme, {}, (value: unknown) => {
							completed = true;
							result = value;
						});
						component.handleInput(KEY.space);
						component.handleInput(KEY.ctrlS);
						assert(completed, "picker did not complete");
						return result;
					},
					input: async () => names.shift(),
					confirm: async () => {
						confirmations += 1;
						return false;
					},
				},
			});
			const result = await showPanelSetup(ctx);
			assert(result?.panelName === "alternate", "setup did not ask for another name after collision decline");
			assert(confirmations === 1, "name collision was not explicitly confirmed");
			const config = readScrutinyConfig({ cwd });
			assert(config.panels.find((panel) => panel.name === "balanced")?.members[0]?.model === "provider-old/model", "declined collision overwrote panel");
			assert(config.panels.some((panel) => panel.name === "alternate"), "alternate panel was not saved");
		}));

		await check("no authenticated models gives login guidance without opening picker", () => withAgentDir(async ({ cwd }) => {
			let customCalls = 0;
			const notifications: string[] = [];
			const ctx = makeContext({
				cwd,
				models: [],
				ui: {
					custom: async () => {
						customCalls += 1;
						return null;
					},
					notify: (message: string) => notifications.push(message),
				},
			});
			assert(await showPanelSetup(ctx) === null, "empty setup should stop");
			assert(customCalls === 0, "empty model picker was opened");
			assert(notifications.includes(NO_AUTHENTICATED_MODELS), "provider login/model guidance missing");
		}));

		await check("verify palette remains runnable without panel or authenticated models", () => withAgentDir(async ({ cwd }) => {
			let customCalls = 0;
			let rendered = "";
			const ctx = makeContext({
				cwd,
				onRegistryAccess: () => { throw new Error("verify touched model registry"); },
				ui: {
					custom: async (factory: any) => {
						customCalls += 1;
						let completed = false;
						let result: unknown;
						const component = await factory(tui, theme, {}, (value: unknown) => {
							completed = true;
							result = value;
						});
						rendered = component.render(100).join("\n");
						component.handleInput(KEY.enter);
						assert(completed, "verify palette did not complete");
						return result;
					},
				},
			});
			const selected = await showScrutinyPalette(ctx, "verify repository checks");
			assert(selected?.template === "verify", "verify did not resolve without panel");
			assert(!selected.panel, "verify unexpectedly selected panel");
			assert(customCalls === 1 && rendered.includes("objective arbiter · no panel · no judge"), "verify entered setup flow");
		}));

		await check("non-interactive setup exits before registry or custom UI", () => withAgentDir(async ({ cwd }) => {
			let registryCalls = 0;
			let customCalls = 0;
			const notifications: string[] = [];
			const ctx = makeContext({
				cwd,
				mode: "json",
				onRegistryAccess: () => { registryCalls += 1; },
				ui: {
					custom: async () => {
						customCalls += 1;
						return null;
					},
					notify: (message: string) => notifications.push(message),
				},
			});
			assert(await showPanelSetup(ctx) === null, "non-interactive setup should stop");
			assert(registryCalls === 0 && customCalls === 0, "non-interactive setup attempted UI/model discovery");
			assert(notifications.includes(PANEL_SETUP_NON_INTERACTIVE), "concise non-interactive setup instruction missing");
		}));
	} finally {
		for (const key of Object.keys(process.env).filter((key) => key.startsWith("PI_SCRUTINY_"))) delete process.env[key];
		Object.assign(process.env, scrutinyEnv);
	}

	const pass = checks - failures.length;
	process.stdout.write(`\nsuite: setup · ${pass}/${checks} pass · ${failures.length} fail\n`);
	if (failures.length) {
		process.stdout.write("\nfailures:\n");
		for (const failure of failures) process.stdout.write(`- ${failure.name}: ${failure.error}\n`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(`suite: setup · fail · ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
