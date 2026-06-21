export type ScrutinySurface = "consult" | "hypotheses" | "criteria" | "repo-map" | "risks" | "verify";
export type ScrutinyStatus = "pending" | "running" | "ready" | "failed";

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
	blind_spots?: string[];
	confidence?: "low" | "medium" | "high" | string;
	disagreement_signal?: boolean;
};

export type ScrutinyRunProgress = {
	runId: string;
	surface: ScrutinySurface;
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
	status: "ok" | "error";
	failure_reason?: "missing_panel" | "all_panels_failed" | "judge_failed" | "recursion_capped" | "unexpected_error" | "verify_failed";
	error?: string;
	packetPath?: string;
	packet: string;
	responses: PanelResponse[];
	failed_models: Array<{ model: string; error: string }>;
	judge?: PanelResponse;
	analysis?: ScrutinyAnalysis;
	verify?: VerifyReport;
	startedAt: number;
	endedAt: number;
	durationMs: number;
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

export type ScrutinyConfig = {
	panel: string[];
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
};

export type VerifyCheckSpec = {
	name: string;
	command: string;
	args?: string[];
	timeoutMs?: number;
};

export type CouncilPanelist = {
	model: string;
	lens?: string;
};

export type Council = {
	name: string;
	surface: ScrutinySurface;
	panelists: CouncilPanelist[];
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
	judge?: string;
	judgeMode?: "auto" | "off" | "on";
	maxPanelModels?: number;
	includeGitDiff?: boolean;
	tools?: string[];
	verify?: boolean;
};
