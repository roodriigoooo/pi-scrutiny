import fs from "node:fs/promises";
import path from "node:path";
import { buildDeterministicAnalysis, detectMush, formatFailureBrief, formatScrutinyBrief, formatVerifyBrief } from "./analysis.js";
import { SURFACE_DEFAULTS, readScrutinyConfig, resolveJudge, resolvePanel, resolveTools } from "./config.js";
import { buildTaskPacket, judgePrompt, panelPrompt, panelRoles } from "./packet.js";
import { runModelTask } from "./runner.js";
import { recordRunEnd, recordRunProgress, recordRunStart } from "./registry.js";
import { writeRunResult } from "./summary.js";
import type { ScrutinyAnalysis, ScrutinyParams, ScrutinyRunProgress, ScrutinyRunResult, ScrutinySurface, PanelResponse, VerifyCheck, VerifyReport } from "./types.js";
import { createRunId, formatDuration, formatTokens, scrutinyDataDir, parseAnalysisJson, safeMkdir, truncate } from "./util.js";

type ExecLike = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

type RunScrutinyInput = {
	params: ScrutinyParams;
	cwd: string;
	exec: ExecLike;
	signal?: AbortSignal;
	onProgress?: (progress: ScrutinyRunProgress) => void;
	projectTrusted?: boolean;
};

const PANEL_EXCERPT_CHARS = 2_400;

export async function runScrutiny(input: RunScrutinyInput): Promise<{ result: ScrutinyRunResult; brief: string }> {
	const startedAt = Date.now();
	const runId = createRunId();
	const config = readScrutinyConfig({ cwd: input.cwd, projectTrusted: input.projectTrusted });
	const surface: ScrutinySurface = resolveSurface(input.params);
	const panelMembers = surface === "verify" ? [] : resolvePanel(input.params, config);
	const tools = resolveTools(input.params, config);
	const judgeModel = resolveJudge(input.params, config, panelMembers);
	const runJudgeByPolicy = shouldRunJudge(surface, input.params.judgeMode);
	const runVerifyByPolicy = shouldRunVerify(surface, input.params.verify);
	const runDir = path.join(scrutinyDataDir(input.cwd), runId);
	const packetPath = path.join(runDir, "packet.md");

	if (process.env.PI_SCRUTINY_DEPTH) {
		const result = emptyError({ runId, surface, startedAt, error: "nested scrutiny invocation blocked", failure_reason: "recursion_capped" });
		safeMkdir(runDir);
		await writeRunResult({ cwd: input.cwd, runDir, result, prompt: input.params.prompt });
		return { result, brief: "Scrutiny blocked: nested invocation." };
	}

	safeMkdir(runDir);

	if (surface === "verify") {
		return runVerifyOnly({ runId, surface, cwd: input.cwd, exec: input.exec, config, runDir, startedAt, signal: input.signal, onProgress: input.onProgress, params: input.params });
	}

	if (panelMembers.length === 0) {
		const result = emptyError({ runId, surface, startedAt, error: "No panel models configured. Set PI_SCRUTINY_PANEL or pass panel.", failure_reason: "missing_panel" });
		await writeRunResult({ cwd: input.cwd, runDir, result, prompt: input.params.prompt });
		return { result, brief: result.error ?? "Scrutiny failed." };
	}

	recordRunStart({ runId, surface, status: "running", startedAt, runDir });

	const packet = await buildTaskPacket({ params: input.params, surface, cwd: input.cwd, config, exec: input.exec, signal: input.signal });
	await fs.writeFile(packetPath, packet, { encoding: "utf8", mode: 0o600 });

	const panel = panelRoles(panelMembers, surface);
	let progress: ScrutinyRunProgress = {
		runId,
		surface,
		packetPath,
		panel: panel.map((item) => ({ model: item.model, role: item.role, thinking: item.thinking, status: "pending" })),
		judge: runJudgeByPolicy && judgeModel ? { model: judgeModel, role: "trade-off explainer", status: "pending" } : undefined,
		startedAt,
		updatedAt: Date.now(),
		status: "running",
		message: replicatedBudgetLine(packet, panel.length, runJudgeByPolicy),
	};
	emit(input, progress);

	const responses = await Promise.all(
		panel.map(async (item, index) => {
			progress = updatePanel(progress, index, { status: "running", startedAt: Date.now() });
			emit(input, progress);
			const response = await runModelTask({
				model: item.model,
				role: item.role,
				prompt: panelPrompt({ packet, role: item.role, surface }),
				cwd: input.cwd,
				tools,
				timeoutMs: config.panelTimeoutMs,
				outputCharLimit: config.maxPanelOutputChars,
				thinkingLevel: item.thinking,
				signal: input.signal,
			});
			progress = updatePanel(progress, index, { status: response.status === "ok" ? "ready" : "failed", endedAt: Date.now() });
			progress.message = panelProgressLine(responsesSoFar(progress));
			emit(input, progress);
			return response;
		}),
	);

	await fs.writeFile(path.join(runDir, "responses.json"), JSON.stringify(responses, null, 2), { encoding: "utf8", mode: 0o600 });
	const okResponses = responses.filter((response) => response.status === "ok" && response.content.trim());
	const failedModels = responses.filter((response) => response.status === "error").map((response) => ({ model: response.model, error: response.error ?? "unknown error" }));

	if (okResponses.length === 0) {
		const endedAt = Date.now();
		const result: ScrutinyRunResult = {
			runId,
			surface,
			status: "error",
			failure_reason: "all_panels_failed",
			error: "all panel models failed",
			packetPath,
			packet,
			responses,
			failed_models: failedModels,
			startedAt,
			endedAt,
			durationMs: endedAt - startedAt,
		};
		await writeRunResult({ cwd: input.cwd, runDir, result, prompt: input.params.prompt });
		progress = { ...progress, status: "error", updatedAt: endedAt, message: "all panel models failed" };
		emit(input, progress);
		recordRunEnd(runId, { status: "error", endedAt, error: "all panel models failed" });
		return { result, brief: formatFailureBrief({ surface, runId, runDir, responses, failedModels, reason: "all panel models failed" }) };
	}

	const mush = detectMush(okResponses);
	if (mush) {
		const endedAt = Date.now();
		const result: ScrutinyRunResult = {
			runId,
			surface,
			status: "error",
			failure_reason: "all_panels_failed",
			error: `panel outputs unusable: ${mush}`,
			packetPath,
			packet,
			responses,
			failed_models: failedModels,
			startedAt,
			endedAt,
			durationMs: endedAt - startedAt,
		};
		await writeRunResult({ cwd: input.cwd, runDir, result, prompt: input.params.prompt });
		progress = { ...progress, status: "error", updatedAt: endedAt, message: `panel outputs unusable: ${mush}` };
		emit(input, progress);
		recordRunEnd(runId, { status: "error", endedAt, error: `panel outputs unusable: ${mush}` });
		return { result, brief: formatFailureBrief({ surface, runId, runDir, responses, failedModels, reason: `panel outputs unusable: ${mush}` }) };
	}

	let judge: PanelResponse | undefined;
	let analysis: ScrutinyAnalysis | undefined = buildDeterministicAnalysis(responses);
	const runJudge = runJudgeByPolicy && Boolean(judgeModel);

	if (runJudge && judgeModel) {
		progress = { ...progress, judge: { model: judgeModel, role: "trade-off explainer", status: "running", startedAt: Date.now() }, updatedAt: Date.now(), message: "trade-off explainer comparing panel evidence" };
		emit(input, progress);
		judge = await runModelTask({
			model: judgeModel,
			role: "trade-off explainer",
			prompt: judgePrompt({ packet, responses: okResponses.map((response) => ({ model: response.model, role: response.role, content: response.content })) }),
			cwd: input.cwd,
			tools,
			timeoutMs: config.judgeTimeoutMs,
			outputCharLimit: config.maxJudgeOutputChars,
			thinkingLevel: "off",
			signal: input.signal,
		});
		const judgeAnalysis = judge.status === "ok" ? parseAnalysisJson(judge.content) : undefined;
		if (judgeAnalysis) analysis = mergeAnalysis(analysis, judgeAnalysis);
		progress = { ...progress, judge: { model: judgeModel, role: "trade-off explainer", status: judgeAnalysis ? "ready" : "failed", endedAt: Date.now() }, updatedAt: Date.now(), message: judgeAnalysis ? "trade-off explainer ready" : "trade-off explainer failed; deterministic evidence map kept" };
		emit(input, progress);
	}

	let verify: VerifyReport | undefined;
	if (runVerifyByPolicy) {
		progress = { ...progress, message: "running objective verify checks", updatedAt: Date.now() };
		emit(input, progress);
		verify = await runVerify({ cwd: input.cwd, exec: input.exec, config, signal: input.signal });
		await fs.writeFile(path.join(runDir, "verify.json"), JSON.stringify(verify, null, 2), { encoding: "utf8", mode: 0o600 });
		progress = { ...progress, message: `verify: ${verify.passed} pass · ${verify.failed} fail · ${verify.skipped} skipped`, updatedAt: Date.now() };
		emit(input, progress);
	}

	const endedAt = Date.now();
	const result: ScrutinyRunResult = {
		runId,
		surface,
		status: "ok",
		failure_reason: judge && judge.status !== "ok" ? "judge_failed" : undefined,
		packetPath,
		packet,
		responses,
		failed_models: failedModels,
		judge,
		analysis,
		verify,
		startedAt,
		endedAt,
		durationMs: endedAt - startedAt,
	};
	await writeRunResult({ cwd: input.cwd, runDir, result, prompt: input.params.prompt });
	progress = { ...progress, status: "ok", updatedAt: endedAt, message: `done in ${formatDuration(result.durationMs)}` };
	emit(input, progress);
	recordRunEnd(runId, { status: "ok", endedAt });

	const brief = formatScrutinyBrief({
		surface,
		analysis,
		responses,
		failedModels,
		judgeRan: runJudge,
		verify,
		llmPanelExcerptChars: PANEL_EXCERPT_CHARS,
		budgetLine: budgetLine(packet, responses, runJudge),
	});
	return { result, brief };
}

async function runVerifyOnly(input: {
	runId: string;
	surface: ScrutinySurface;
	cwd: string;
	exec: ExecLike;
	config: import("./types.js").ScrutinyConfig;
	runDir: string;
	startedAt: number;
	signal?: AbortSignal;
	onProgress?: (progress: ScrutinyRunProgress) => void;
	params: ScrutinyParams;
}): Promise<{ result: ScrutinyRunResult; brief: string }> {
	const { runId, surface, cwd, exec, config, runDir, startedAt, signal, onProgress, params } = input;
	recordRunStart({ runId, surface, status: "running", startedAt, runDir });
	let progress: ScrutinyRunProgress = {
		runId,
		surface,
		panel: [],
		startedAt,
		updatedAt: Date.now(),
		status: "running",
		message: "running objective verify checks",
	};
	emit({ onProgress }, progress);
	const verify = await runVerify({ cwd, exec, config, signal });
	await fs.writeFile(path.join(runDir, "verify.json"), JSON.stringify(verify, null, 2), { encoding: "utf8", mode: 0o600 });
	const endedAt = Date.now();
	const result: ScrutinyRunResult = {
		runId,
		surface,
		status: "ok",
		packet: "",
		responses: [],
		failed_models: [],
		verify,
		startedAt,
		endedAt,
		durationMs: endedAt - startedAt,
	};
	await writeRunResult({ cwd, runDir, result, prompt: params.prompt });
	progress = { ...progress, status: "ok", updatedAt: endedAt, message: `verify: ${verify.passed} pass · ${verify.failed} fail · ${verify.skipped} skipped` };
	emit({ onProgress }, progress);
	recordRunEnd(runId, { status: "ok", endedAt });
	const brief = formatVerifyBrief({ verify, budgetLine: verifyBudgetLine(verify) });
	return { result, brief };
}

async function runVerify(input: { cwd: string; exec: ExecLike; config: import("./types.js").ScrutinyConfig; signal?: AbortSignal }): Promise<VerifyReport> {
	const startedAt = Date.now();
	const checks: VerifyCheck[] = [];
	for (const spec of input.config.verifyChecks) {
		const checkStart = Date.now();
		try {
			const result = await input.exec(spec.command, spec.args ?? [], { timeout: spec.timeoutMs ?? input.config.verifyTimeoutMs, signal: input.signal });
			const durationMs = Date.now() - checkStart;
			const code = result.code ?? 0;
			const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
			if (code === 0) checks.push({ name: spec.name, command: `${spec.command} ${(spec.args ?? []).join(" ")}`.trim(), status: "pass", exitCode: code, output: truncate(output, 4_000), durationMs });
			else checks.push({ name: spec.name, command: `${spec.command} ${(spec.args ?? []).join(" ")}`.trim(), status: "fail", exitCode: code, output: truncate(output, 4_000), durationMs });
		} catch (error) {
			const durationMs = Date.now() - checkStart;
			checks.push({ name: spec.name, command: `${spec.command} ${(spec.args ?? []).join(" ")}`.trim(), status: "error", output: error instanceof Error ? error.message : String(error), durationMs });
		}
	}
	let diffStat: string | undefined;
	try {
		const stat = await input.exec("git", ["diff", "--stat"], { timeout: 5_000, signal: input.signal });
		if (stat.code === 0 && stat.stdout?.trim()) diffStat = truncate(stat.stdout.trim(), 2_000);
	} catch {
		// diff optional
	}
	const passed = checks.filter((c) => c.status === "pass").length;
	const failed = checks.filter((c) => c.status === "fail" || c.status === "error").length;
	const skipped = checks.filter((c) => c.status === "skipped").length;
	return { checks, diffStat, passed, failed, skipped, durationMs: Date.now() - startedAt };
}

function resolveSurface(params: ScrutinyParams): ScrutinySurface {
	if (params.surface) return params.surface;
	return inferSurface(params.prompt);
}

export function inferSurface(prompt: string): ScrutinySurface {
	const text = prompt.toLowerCase();
	if (/\b(verify|typecheck|lint|run tests|test suite|does it pass|check the build|ci)\b/.test(text)) return "verify";
	if (/\b(risk|review the patch|review this change|concurrency|race|reactive|idempoten|circuit.?breaker|security review)\b/.test(text)) return "risks";
	if (/\b(root cause|why does|debug|intermittent|flaky|bug in|what is causing)\b/.test(text)) return "hypotheses";
	if (/\b(acceptance criter|edge case|backward.?compat|migrat|spec for|definition of done)\b/.test(text)) return "criteria";
	if (/\b(repo map|where is|call path|callers of|symbols|trace|how does .* work|navigate the code)\b/.test(text)) return "repo-map";
	return "consult";
}

function shouldRunJudge(surface: ScrutinySurface, judgeMode: ScrutinyParams["judgeMode"]): boolean {
	if (surface === "verify") return false;
	const resolved = judgeMode ?? SURFACE_DEFAULTS[surface].judgeMode;
	if (resolved === "off") return false;
	if (resolved === "on") return true;
	return surface === "consult";
}

function shouldRunVerify(surface: ScrutinySurface, verifyParam: ScrutinyParams["verify"]): boolean {
	if (surface === "verify") return true;
	if (verifyParam !== undefined) return verifyParam;
	return SURFACE_DEFAULTS[surface].verify;
}

function mergeAnalysis(deterministic: ScrutinyAnalysis, judge: ScrutinyAnalysis): ScrutinyAnalysis {
	return {
		consensus: judge.consensus ?? deterministic.consensus,
		contradictions: judge.contradictions?.length ? judge.contradictions : deterministic.contradictions,
		unique_insights: judge.unique_insights ?? deterministic.unique_insights,
		risks: judge.risks?.length ? judge.risks : deterministic.risks,
		blind_spots: judge.blind_spots ?? deterministic.blind_spots,
		confidence: judge.confidence ?? deterministic.confidence,
		disagreement_signal: judge.disagreement_signal ?? deterministic.disagreement_signal,
	};
}

function emit(input: { onProgress?: (progress: ScrutinyRunProgress) => void }, progress: ScrutinyRunProgress): void {
	const updated = { ...progress, updatedAt: Date.now() };
	recordRunProgress(updated);
	input.onProgress?.(updated);
}

function updatePanel(progress: ScrutinyRunProgress, index: number, patch: Partial<ScrutinyRunProgress["panel"][number]>): ScrutinyRunProgress {
	return {
		...progress,
		updatedAt: Date.now(),
		panel: progress.panel.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
	};
}

function responsesSoFar(progress: ScrutinyRunProgress): { ready: number; failed: number; total: number } {
	return {
		ready: progress.panel.filter((item) => item.status === "ready").length,
		failed: progress.panel.filter((item) => item.status === "failed").length,
		total: progress.panel.length,
	};
}

function panelProgressLine(progress: { ready: number; failed: number; total: number }): string {
	const active = progress.total - progress.ready - progress.failed;
	return `${progress.ready}/${progress.total} ready${progress.failed ? `, ${progress.failed} failed` : ""}${active ? `, ${active} running` : ""}`;
}

function replicatedBudgetLine(packet: string, panelCount: number, judgeRan: boolean): string {
	const packetTokens = Math.ceil(packet.length / 4);
	const replicated = packetTokens * panelCount;
	return `budget: packet ~${formatTokens(packetTokens)} tokens × ${panelCount} panelists = ~${formatTokens(replicated)} replicated input tokens${judgeRan ? "; trade-off explainer also reads panel outputs" : "; trade-off explainer skipped"}`;
}

function budgetLine(packet: string, responses: PanelResponse[], judgeRan: boolean): string {
	const base = replicatedBudgetLine(packet, responses.length, judgeRan);
	const input = responses.reduce((sum, response) => sum + response.usage.input, 0);
	const output = responses.reduce((sum, response) => sum + response.usage.output, 0);
	const cost = responses.reduce((sum, response) => sum + response.usage.cost, 0);
	const actual = input || output || cost ? `actual panel usage: ↑${formatTokens(input)} ↓${formatTokens(output)}${cost ? ` $${cost.toFixed(4)}` : ""}` : "actual panel usage unavailable";
	return `${base}\n${actual}`;
}

function verifyBudgetLine(verify: VerifyReport): string {
	return `budget: ${verify.checks.length} objective checks · no panel · no judge · ${formatDuration(verify.durationMs)}`;
}

function emptyError(input: { runId: string; surface: ScrutinySurface; startedAt: number; error: string; failure_reason: ScrutinyRunResult["failure_reason"] }): ScrutinyRunResult {
	const endedAt = Date.now();
	return {
		runId: input.runId,
		surface: input.surface,
		status: "error",
		failure_reason: input.failure_reason,
		error: input.error,
		packet: "",
		responses: [],
		failed_models: [],
		startedAt: input.startedAt,
		endedAt,
		durationMs: endedAt - input.startedAt,
	};
}
