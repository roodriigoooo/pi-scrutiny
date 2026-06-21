export type EvalSurface = "consult" | "hypotheses" | "criteria" | "repo-map" | "risks" | "verify";

export type EvalTask = {
	id: string;
	description: string;
	surface: EvalSurface;
	prompt: string;
	councilEnv?: Record<string, string>;
	panelEnv?: string;
	/**
	 * Optional structural expectation over the parsed result.json.
	 * Each predicate is evaluated against the result; failures are recorded.
	 */
	expect?: EvalExpectation[];
	/**
	 * For verify-only tasks, the panel may be empty. For deliberation surfaces,
	 * the harness skips the task if no panel env is configured (recorded as skipped).
	 */
	requiresPanel?: boolean;
};

export type EvalExpectation = {
	name: string;
	/** Returns true if pass, false if fail; may throw to record an error. */
	check: (ctx: { result?: ScrutinyResultJson; stdout: string; runDir?: string }) => boolean;
};

/**
 * Minimal view of the on-disk result.json written by the engine.
 * Kept loose (all optional) so eval predicates can probe without hard-coupling.
 */
export type ScrutinyResultJson = {
	runId?: string;
	surface?: string;
	status?: "ok" | "error";
	failure_reason?: string;
	error?: string;
	responses?: Array<{ model?: string; status?: string; content?: string; error?: string }>;
	analysis?: {
		consensus?: string[];
		contradictions?: Array<{ topic: string; stances: Array<{ model: string; stance: string }> }>;
		risks?: string[];
		blind_spots?: string[];
		disagreement_signal?: boolean;
		confidence?: string;
	};
	verify?: {
		checks?: Array<{ name: string; status: string; exitCode?: number; output?: string; durationMs?: number }>;
		diffStat?: string;
		passed?: number;
		failed?: number;
		skipped?: number;
		durationMs?: number;
	};
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
};

export type EvalRunRecord = {
	taskId: string;
	surface: EvalSurface;
	status: "pass" | "fail" | "skipped" | "error";
	durationMs: number;
	expectations?: Array<{ name: string; pass: boolean; error?: string }>;
	runDir?: string;
	result?: ScrutinyResultJson;
	error?: string;
	stdoutSnippet?: string;
};

export type EvalReport = {
	suite: string;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	runs: EvalRunRecord[];
	summary: {
		total: number;
		pass: number;
		fail: number;
		skipped: number;
		error: number;
		expectationsTotal: number;
		expectationsPassed: number;
	};
};
