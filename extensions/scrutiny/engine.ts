import fs from "node:fs/promises";
import path from "node:path";
import { buildDeterministicAnalysis, detectMush, formatFailureBrief, formatScrutinyBrief, formatVerifyBrief } from "./analysis.js";
import { readScrutinyConfig, resolveJudge, resolveTools } from "./config.js";
import { runDir as resolveRunDir } from "./artifacts.js";
import { buildTaskPacket, judgePrompt, panelPrompt, resolvedPanelists } from "./packet.js";
import { runModelTask } from "./runner.js";
import { recordRunEnd, recordRunProgress, recordRunStart } from "./registry.js";
import { writeRunResult } from "./summary.js";
import { MissingPanelError, resolveRunPlan } from "./templates.js";
import { inferSurface } from "./surfaces.js";
import type {
	ResolvedDeliberationRunPlan,
	ResolvedRunPlan,
	ScrutinyAnalysis,
	ScrutinyParams,
	ScrutinyRunProgress,
	ScrutinyRunResult,
	ScrutinySurface,
	ScoutReport,
	PanelResponse,
	VerifyReport,
} from "./types.js";
import { createRunId, formatDuration, formatTokens, parseAnalysisJson, safeMkdir } from "./util.js";
import { classifyVerifyRun, runVerifyChecks, verifyProgressMessage } from "./verify.js";
import { normalizeSurface } from "./normalize.js";

type ExecLike = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>;

export const SCRUTINY_PACKET_PREVIEW_CANCELLED = "SCRUTINY_PACKET_PREVIEW_CANCELLED";

type RunScrutinyInput = {
	params: ScrutinyParams;
	cwd: string;
	exec: ExecLike;
	signal?: AbortSignal;
	onProgress?: (progress: ScrutinyRunProgress) => void;
	projectTrusted?: boolean;
	confirmPacket?: (input: {
		runId: string;
		surface: ScrutinySurface;
		template: string;
		panelName?: string;
		strategy?: ResolvedRunPlan["strategy"];
		assignments: ReadonlyArray<{ model: string; lens?: string }>;
		unassignedLenses: readonly string[];
		includeGitDiff: boolean;
		packet: string;
		scout?: ScoutReport;
		panelCount: number;
		judgeRan: boolean;
		verifyRan: boolean;
	}) => Promise<string | null>;
};

const PANEL_EXCERPT_CHARS = 2_400;
const PROGRESS_HEARTBEAT_MS = 1_000;

let activeRunId: string | undefined;

function acquireRunLock(runId: string): boolean {
	if (activeRunId && activeRunId !== runId) return false;
	activeRunId = runId;
	return true;
}

function releaseRunLock(runId: string): void {
	if (activeRunId === runId) activeRunId = undefined;
}

export async function runScrutiny(input: RunScrutinyInput): Promise<{ result: ScrutinyRunResult; brief: string }> {
	const startedAt = Date.now();
	const runId = createRunId();
	const config = readScrutinyConfig({ cwd: input.cwd, projectTrusted: input.projectTrusted });
	const requestedSurface = input.params.surface ?? inferSurface(input.params.prompt);
	const templateName = input.params.template ?? requestedSurface;
	let plan: ResolvedRunPlan;
	try {
		plan = resolveRunPlan({
			templateName,
			panelName: input.params.panel,
			includeGitDiff: input.params.includeGitDiff,
			judgeMode: input.params.judgeMode,
			verify: input.params.verify,
		}, config);
	} catch (error) {
		const failureReason = error instanceof MissingPanelError ? "missing_panel" : "invalid_configuration";
		const result = emptyError({
			runId,
			surface: requestedSurface,
			startedAt,
			error: error instanceof Error ? error.message : String(error),
			failure_reason: failureReason,
		});
		const runDir = resolveRunDir(input.cwd, runId);
		safeMkdir(runDir);
		await writeRunResult({ cwd: input.cwd, runDir, result, prompt: input.params.prompt });
		return { result, brief: result.error ?? "Scrutiny failed." };
	}

	const surface = plan.template.surface;
	const runDir = resolveRunDir(input.cwd, runId);
	if (!acquireRunLock(runId)) {
		const result = emptyError({ runId, surface, startedAt, error: "A scrutiny run is already in progress. Wait for it to finish before starting another.", failure_reason: "unexpected_error" }, plan);
		safeMkdir(runDir);
		await writeRunResult({ cwd: input.cwd, runDir, result, prompt: input.params.prompt });
		return { result, brief: result.error ?? "Scrutiny failed." };
	}

	if (process.env.PI_SCRUTINY_DEPTH) {
		const result = emptyError({ runId, surface, startedAt, error: "nested scrutiny invocation blocked", failure_reason: "recursion_capped" }, plan);
		safeMkdir(runDir);
		await writeRunResult({ cwd: input.cwd, runDir, result, prompt: input.params.prompt });
		releaseRunLock(runId);
		return { result, brief: "Scrutiny blocked: nested invocation." };
	}

	safeMkdir(runDir);
	if (isVerifyPlan(plan)) {
		const out = await runVerifyOnly({ runId, cwd: input.cwd, exec: input.exec, config, runDir, startedAt, signal: input.signal, onProgress: input.onProgress, params: input.params, plan });
		releaseRunLock(runId);
		return out;
	}

	return runDeliberation({ input, runId, startedAt, config, runDir, plan })
		.finally(() => releaseRunLock(runId));
}

async function runDeliberation(input: {
	input: RunScrutinyInput;
	runId: string;
	startedAt: number;
	config: import("./types.js").ScrutinyConfig;
	runDir: string;
	plan: ResolvedDeliberationRunPlan;
}): Promise<{ result: ScrutinyRunResult; brief: string }> {
	const { plan, runId, startedAt, config, runDir } = input;
	const surface = plan.template.surface;
	const packetPath = path.join(runDir, "packet.md");
	const tools = resolveTools(input.input.params, config);
	const judgeModel = resolveJudge(input.input.params, config, plan.panel);
	const runJudge = plan.policies.judgeMode !== "off" && Boolean(judgeModel);
	const runVerify = plan.policies.verify;

	recordRunStart({ runId, surface, status: "running", startedAt, runDir });
	const built = await buildTaskPacket({ params: input.input.params, plan, cwd: input.input.cwd, config, exec: input.input.exec, signal: input.input.signal });
	let packet = built.packet;
	const scout = built.scout;
	if (input.input.confirmPacket) {
		const confirmedPacket = await input.input.confirmPacket({
			runId,
			surface,
			template: plan.template.name,
			panelName: plan.panel.name,
			strategy: plan.strategy,
			assignments: plan.assignments,
			unassignedLenses: plan.unassignedLenses,
			includeGitDiff: plan.policies.includeGitDiff,
			packet,
			scout,
			panelCount: plan.assignments.length,
			judgeRan: runJudge,
			verifyRan: runVerify,
		});
		if (!confirmedPacket) {
			await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
			throw new Error(SCRUTINY_PACKET_PREVIEW_CANCELLED);
		}
		packet = confirmedPacket;
	}
	await fs.writeFile(packetPath, packet, { encoding: "utf8", mode: 0o600 });

	const panel = resolvedPanelists(plan);
	let progress: ScrutinyRunProgress = {
		runId,
		surface,
		template: plan.template.name,
		panelName: plan.panel.name,
		strategy: plan.strategy,
		assignments: [...plan.assignments],
		unassignedLenses: [...plan.unassignedLenses],
		packetPath,
		panel: panel.map((item) => ({ model: item.model, role: item.role, thinking: item.thinking, status: "pending" })),
		judge: runJudge && judgeModel ? { model: judgeModel, role: "trade-off explainer", status: "pending" } : undefined,
		startedAt,
		updatedAt: Date.now(),
		status: "running",
		message: replicatedBudgetLine(packet, panel.length, runJudge),
	};
	emit(input.input, progress);

	const replicatePrompt = plan.strategy === "replicate"
		? panelPrompt({ packet, surface, strategy: "replicate" })
		: undefined;
	const responses: PanelResponse[] = [];
	for (let index = 0; index < panel.length; index++) {
		const item = panel[index]!;
		progress = updatePanel(progress, index, { status: "running", startedAt: Date.now() });
		progress.message = `${item.role} · ${index + 1}/${panel.length}`;
		emit(input.input, progress);
		const prompt = replicatePrompt ?? panelPrompt({ packet, surface, strategy: "roles", lens: plan.assignments[index]!.lens });
		const response = await withProgressHeartbeat(
			() => runModelTask({
				model: item.model,
				role: item.role,
				prompt,
				cwd: input.input.cwd,
				tools,
				timeoutMs: config.panelTimeoutMs,
				outputCharLimit: config.maxPanelOutputChars,
				thinkingLevel: item.thinking,
				signal: input.input.signal,
			}),
			() => emit(input.input, progress),
		);
		responses.push(response);
		progress = updatePanel(progress, index, { status: response.status === "ok" ? "ready" : "failed", endedAt: Date.now() });
		progress.message = panelProgressLine(responsesSoFar(progress));
		emit(input.input, progress);
	}

	await fs.writeFile(path.join(runDir, "responses.json"), JSON.stringify(responses, null, 2), { encoding: "utf8", mode: 0o600 });
	const okResponses = responses.filter((response) => response.status === "ok" && response.content.trim());
	const failedModels = responses.filter((response) => response.status === "error").map((response) => ({ model: response.model, error: response.error ?? "unknown error" }));

	if (okResponses.length === 0) return finishPanelFailure({ ...input, surface, packetPath, packet, scout, responses, failedModels, progress, message: "all panel models failed" });
	const mush = detectMush(okResponses);
	if (mush) return finishPanelFailure({ ...input, surface, packetPath, packet, scout, responses, failedModels, progress, message: `panel outputs unusable: ${mush}` });

	let judge: PanelResponse | undefined;
	let analysis: ScrutinyAnalysis = buildDeterministicAnalysis({
		responses,
		strategy: plan.strategy,
		declaredLenses: plan.template.lenses,
		unassignedLenses: plan.unassignedLenses,
	});
	if (runJudge && judgeModel) {
		progress = { ...progress, judge: { model: judgeModel, role: "trade-off explainer", status: "running", startedAt: Date.now() }, updatedAt: Date.now(), message: "trade-off explainer comparing panel evidence" };
		emit(input.input, progress);
		judge = await withProgressHeartbeat(
			() => runModelTask({
				model: judgeModel,
				role: "trade-off explainer",
				prompt: judgePrompt({ packet, strategy: plan.strategy, responses: okResponses.map((response) => ({ model: response.model, role: response.role, content: response.content })) }),
				cwd: input.input.cwd,
				tools,
				timeoutMs: config.judgeTimeoutMs,
				outputCharLimit: config.maxJudgeOutputChars,
				thinkingLevel: "off",
				signal: input.input.signal,
			}),
			() => emit(input.input, progress),
		);
		const judgeAnalysis = judge.status === "ok" ? parseAnalysisJson(judge.content) : undefined;
		if (judgeAnalysis) analysis = mergeAnalysis(analysis, judgeAnalysis, plan.strategy);
		progress = { ...progress, judge: { model: judgeModel, role: "trade-off explainer", status: judgeAnalysis ? "ready" : "failed", endedAt: Date.now() }, updatedAt: Date.now(), message: judgeAnalysis ? "trade-off explainer ready" : "trade-off explainer failed; deterministic evidence map kept" };
		emit(input.input, progress);
	}

	let verify: VerifyReport | undefined;
	if (runVerify) {
		progress = { ...progress, message: "running objective verify checks", updatedAt: Date.now() };
		emit(input.input, progress);
		verify = await withProgressHeartbeat(
			() => runVerifyChecks({
				cwd: input.input.cwd,
				exec: input.input.exec,
				config,
				signal: input.input.signal,
				onCheckProgress: (event) => {
					progress = { ...progress, message: verifyProgressMessage(event), updatedAt: Date.now() };
					emit(input.input, progress);
				},
			}),
			() => emit(input.input, progress),
		);
		await fs.writeFile(path.join(runDir, "verify.json"), JSON.stringify(verify, null, 2), { encoding: "utf8", mode: 0o600 });
		const verdict = classifyVerifyRun(verify);
		progress = { ...progress, message: `verify: ${verdict.summary}${verdict.verifyFailed ? " · checks failed" : ""}`, updatedAt: Date.now() };
		emit(input.input, progress);
	}

	const endedAt = Date.now();
	const result: ScrutinyRunResult = {
		runId,
		surface,
		...planResultMetadata(plan),
		status: "ok",
		failure_reason: judge && judge.status !== "ok" ? "judge_failed" : undefined,
		packetPath,
		packet,
		scout,
		normalized: normalizeSurface(surface, responses),
		responses,
		failed_models: failedModels,
		judge,
		analysis,
		verify,
		startedAt,
		endedAt,
		durationMs: endedAt - startedAt,
	};
	await writeRunResult({ cwd: input.input.cwd, runDir, result, prompt: input.input.params.prompt });
	progress = { ...progress, status: "ok", updatedAt: endedAt, message: `done in ${formatDuration(result.durationMs)}` };
	emit(input.input, progress);
	recordRunEnd(runId, { status: "ok", endedAt });
	return {
		result,
		brief: formatScrutinyBrief({
			surface,
			strategy: plan.strategy,
			analysis,
			responses,
			failedModels,
			judgeRan: runJudge,
			verify,
			llmPanelExcerptChars: PANEL_EXCERPT_CHARS,
			budgetLine: budgetLine(packet, responses, runJudge),
		}),
	};
}

async function finishPanelFailure(input: {
	input: RunScrutinyInput;
	runId: string;
	startedAt: number;
	runDir: string;
	plan: ResolvedDeliberationRunPlan;
	surface: ScrutinySurface;
	packetPath: string;
	packet: string;
	scout?: ScoutReport;
	responses: PanelResponse[];
	failedModels: Array<{ model: string; error: string }>;
	progress: ScrutinyRunProgress;
	message: string;
}): Promise<{ result: ScrutinyRunResult; brief: string }> {
	const endedAt = Date.now();
	const result: ScrutinyRunResult = {
		runId: input.runId,
		surface: input.surface,
		...planResultMetadata(input.plan),
		status: "error",
		failure_reason: "all_panels_failed",
		error: input.message,
		packetPath: input.packetPath,
		packet: input.packet,
		scout: input.scout,
		responses: input.responses,
		failed_models: input.failedModels,
		startedAt: input.startedAt,
		endedAt,
		durationMs: endedAt - input.startedAt,
	};
	await writeRunResult({ cwd: input.input.cwd, runDir: input.runDir, result, prompt: input.input.params.prompt });
	const progress = { ...input.progress, status: "error" as const, updatedAt: endedAt, message: input.message };
	emit(input.input, progress);
	recordRunEnd(input.runId, { status: "error", endedAt, error: input.message });
	return {
		result,
		brief: formatFailureBrief({
			surface: input.surface,
			runId: input.runId,
			runDir: input.runDir,
			responses: input.responses,
			failedModels: input.failedModels,
			reason: input.message,
		}),
	};
}

async function runVerifyOnly(input: {
	runId: string;
	cwd: string;
	exec: ExecLike;
	config: import("./types.js").ScrutinyConfig;
	runDir: string;
	startedAt: number;
	signal?: AbortSignal;
	onProgress?: (progress: ScrutinyRunProgress) => void;
	params: ScrutinyParams;
	plan: ResolvedRunPlan;
}): Promise<{ result: ScrutinyRunResult; brief: string }> {
	const { runId, cwd, exec, config, runDir, startedAt, signal, onProgress, params, plan } = input;
	recordRunStart({ runId, surface: "verify", status: "running", startedAt, runDir });
	let progress: ScrutinyRunProgress = {
		runId,
		surface: "verify",
		template: plan.template.name,
		panel: [],
		startedAt,
		updatedAt: Date.now(),
		status: "running",
		message: "running objective verify checks",
	};
	emit({ onProgress }, progress);
	const verify = await withProgressHeartbeat(
		() => runVerifyChecks({
			cwd,
			exec,
			config,
			signal,
			onCheckProgress: (event) => {
				progress = { ...progress, message: verifyProgressMessage(event), updatedAt: Date.now() };
				emit({ onProgress }, progress);
			},
		}),
		() => emit({ onProgress }, progress),
	);
	await fs.writeFile(path.join(runDir, "verify.json"), JSON.stringify(verify, null, 2), { encoding: "utf8", mode: 0o600 });
	const endedAt = Date.now();
	const result: ScrutinyRunResult = {
		runId,
		surface: "verify",
		...planResultMetadata(plan),
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
	const verdict = classifyVerifyRun(verify);
	progress = { ...progress, status: "ok", updatedAt: endedAt, message: `verify: ${verdict.summary}${verdict.verifyFailed ? " · checks failed" : ""}` };
	emit({ onProgress }, progress);
	recordRunEnd(runId, { status: "ok", endedAt });
	return { result, brief: formatVerifyBrief({ verify, budgetLine: verifyBudgetLine(verify) }) };
}

function mergeAnalysis(deterministic: ScrutinyAnalysis, judge: ScrutinyAnalysis, strategy: ResolvedDeliberationRunPlan["strategy"]): ScrutinyAnalysis {
	const canDisagree = strategy === "replicate";
	return {
		consensus: judge.consensus ?? deterministic.consensus,
		contradictions: canDisagree && judge.contradictions?.length ? judge.contradictions : deterministic.contradictions,
		unique_insights: judge.unique_insights ?? deterministic.unique_insights,
		risks: judge.risks?.length ? judge.risks : deterministic.risks,
		coverage: judge.coverage?.length ? judge.coverage : deterministic.coverage,
		blind_spots: judge.blind_spots ?? deterministic.blind_spots,
		confidence: judge.confidence ?? deterministic.confidence,
		disagreement_signal: canDisagree ? judge.disagreement_signal ?? deterministic.disagreement_signal : false,
	};
}

function planResultMetadata(plan: ResolvedRunPlan): Pick<ScrutinyRunResult, "template" | "panelName" | "strategy" | "assignments" | "unassignedLenses"> {
	return {
		template: plan.template.name,
		panelName: plan.panel?.name,
		strategy: plan.strategy,
		assignments: [...plan.assignments],
		unassignedLenses: [...plan.unassignedLenses],
	};
}

function isVerifyPlan(plan: ResolvedRunPlan): plan is Exclude<ResolvedRunPlan, ResolvedDeliberationRunPlan> {
	return plan.strategy === undefined;
}

function emit(input: { onProgress?: (progress: ScrutinyRunProgress) => void }, progress: ScrutinyRunProgress): void {
	const updated = { ...progress, updatedAt: Date.now() };
	recordRunProgress(updated);
	input.onProgress?.(updated);
}

function updatePanel(progress: ScrutinyRunProgress, index: number, patch: Partial<ScrutinyRunProgress["panel"][number]>): ScrutinyRunProgress {
	return { ...progress, updatedAt: Date.now(), panel: progress.panel.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) };
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

function emptyError(input: {
	runId: string;
	surface: ScrutinySurface;
	startedAt: number;
	error: string;
	failure_reason: ScrutinyRunResult["failure_reason"];
}, plan?: ResolvedRunPlan): ScrutinyRunResult {
	const endedAt = Date.now();
	return {
		runId: input.runId,
		surface: input.surface,
		...(plan ? planResultMetadata(plan) : {}),
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

async function withProgressHeartbeat<T>(work: () => Promise<T>, tick: () => void, intervalMs = PROGRESS_HEARTBEAT_MS): Promise<T> {
	const timer = setInterval(() => {
		try {
			tick();
		} catch {
			// UI progress must never affect the underlying run.
		}
	}, intervalMs);
	try {
		return await work();
	} finally {
		clearInterval(timer);
	}
}

