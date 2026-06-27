import type { SurfaceArtifact } from "./normalize.js";

export type ScrutinySurface = "consult" | "hypotheses" | "criteria" | "repo-map" | "risks" | "verify";
export type PanelMode = "replicate" | "roles";
export type ScrutinyStatus = "pending" | "running" | "ready" | "failed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type { SurfaceArtifact };

export type ScoutCandidate = {
	/** Stable id assigned in ranked order (c0, c1, ...). Used by packet preview to toggle candidates. */
	id: string;
	kind: "file" | "match" | "prior";
	title: string;
	score: number;
	why: string[];
	preview?: string;
	/** Present on prior candidates whose referenced file hashes no longer match. */
	stale?: boolean;
};

export type ScoutGap = {
	id: string;
	severity: "warn" | "info";
	message: string;
};

export type ScoutReport = {
	surface: ScrutinySurface;
	skipped: boolean;
	skipReason?: string;
	anchors: { files: string[]; symbols: string[]; terms: string[]; reasons: string[] };
	candidates: ScoutCandidate[];
	priorCount: number;
	gaps: ScoutGap[];
};

export type ScrutinyUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

export type PanelSpec = {
	model: string;
	role: string;
	thinking?: ThinkingLevel;
	status: ScrutinyStatus;
	startedAt?: number;
	endedAt?: number;
};

export type PanelResponse = {
	model: string;
	role: string;
	status: "ok" | "error";
	content: string;
	error?: string;
	usage: ScrutinyUsage;
	durationMs: number;
	exitCode: number;
};

export type ScrutinyAnalysis = {
	consensus?: string[];
	contradictions?: Array<{ topic: string; stances: Array<{ model: string; stance: string }> }>;
	unique_insights?: Array<{ model: string; insight: string }>;
	risks?: string[];
	coverage?: string[];
	blind_spots?: string[];
	confidence?: "low" | "medium" | "high" | string;
	disagreement_signal?: boolean;
};

export type ScrutinyRunProgress = {
	runId: string;
	surface: ScrutinySurface;
	panel_mode?: PanelMode;
	packetPath?: string;
	panel: PanelSpec[];
	judge?: PanelSpec;
	startedAt: number;
	updatedAt: number;
	status: "running" | "ok" | "error";
	message?: string;
};

export type ScrutinyRunResult = {
	runId: string;
	surface: ScrutinySurface;
	panel_mode?: PanelMode;
	status: "ok" | "error";
	failure_reason?: "missing_panel" | "all_panels_failed" | "judge_failed" | "recursion_capped" | "unexpected_error";
	error?: string;
	packetPath?: string;
	packet: string;
	responses: PanelResponse[];
	failed_models: Array<{ model: string; error: string }>;
	judge?: PanelResponse;
	analysis?: ScrutinyAnalysis;
	verify?: VerifyReport;
	scout?: ScoutReport;
	normalized?: SurfaceArtifact;
	startedAt: number;
	endedAt: number;
	durationMs: number;
};

export type ScrutinySummary = {
	runId: string;
	surface: ScrutinySurface;
	startedAt: number;
	endedAt: number;
	prompt: string;
	status: "ok" | "error";
	failure_reason?: ScrutinyRunResult["failure_reason"];
	error?: string;
	files: string[];
	symbols: string[];
	keywords: string[];
	signals: string[];
	risks: string[];
	contradictions: string[];
	missingContext: string[];
	scoutGaps?: string[];
	sourceRefs: string[];
	fileHashes: Record<string, string>;
	resultPath: string;
	surfaceArtifactPath?: string;
	packetPath?: string;
	responsesPath?: string;
	verifyPath?: string;
};

export type VerifyCheck = {
	name: string;
	command: string;
	status: "pass" | "fail" | "skipped" | "error";
	exitCode?: number;
	output?: string;
	durationMs: number;
};

export type VerifyReport = {
	checks: VerifyCheck[];
	diffStat?: string;
	passed: number;
	failed: number;
	skipped: number;
	durationMs: number;
};

export type ScrutinyConfigSource = {
	scope: "global" | "project" | "env";
	path?: string;
	status: "loaded" | "missing" | "skipped" | "error";
	reason?: string;
};

export type ScrutinyConfig = {
	panel: PanelMember[];
	judge?: string;
	maxPanelModels: number;
	maxPanelOutputChars: number;
	maxJudgeOutputChars: number;
	panelTimeoutMs: number;
	judgeTimeoutMs: number;
	verifyTimeoutMs: number;
	includeGitDiff: boolean;
	gitDiffCharLimit: number;
	tools: string[];
	verifyChecks: VerifyCheckSpec[];
	councils: Council[];
	configSources: ScrutinyConfigSource[];
};

export type VerifyCheckSpec = {
	name: string;
	command: string;
	args?: string[];
	timeoutMs?: number;
};

export type PanelMember = {
	model: string;
	lens?: string;
	thinking?: ThinkingLevel;
};

export type CouncilPanelist = PanelMember;

export type Council = {
	name: string;
	surface: ScrutinySurface;
	panelists: PanelMember[];
	thinking?: ThinkingLevel;
	judge?: string;
	judgeMode?: "auto" | "off" | "on";
	includeGitDiff?: boolean;
	verify?: boolean;
};

export type ScrutinyParams = {
	prompt: string;
	context?: string;
	surface?: ScrutinySurface;
	panel?: string[];
	panelMembers?: PanelMember[];
	judge?: string;
	judgeMode?: "auto" | "off" | "on";
	maxPanelModels?: number;
	includeGitDiff?: boolean;
	tools?: string[];
	verify?: boolean;
};
