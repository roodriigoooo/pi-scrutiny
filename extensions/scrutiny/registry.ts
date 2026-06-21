import type { ScrutinyRunProgress, ScrutinySurface } from "./types.js";

export type RunRecord = {
	runId: string;
	surface: ScrutinySurface;
	status: "running" | "ok" | "error";
	startedAt: number;
	endedAt?: number;
	runDir?: string;
	error?: string;
};

const MAX_REMEMBERED = 20;
const runs: RunRecord[] = [];
const progresses = new Map<string, ScrutinyRunProgress>();

export function recordRunStart(rec: RunRecord): void {
	runs.unshift({ ...rec });
	trim();
}

export function recordRunEnd(runId: string, patch: Partial<RunRecord>): void {
	const rec = runs.find((r) => r.runId === runId);
	if (rec) Object.assign(rec, patch);
	const progress = progresses.get(runId);
	if (progress && patch.status) progresses.set(runId, { ...progress, status: patch.status, updatedAt: patch.endedAt ?? Date.now(), message: patch.error ?? progress.message });
	trim();
}

export function recordRunProgress(progress: ScrutinyRunProgress): void {
	progresses.set(progress.runId, { ...progress, panel: progress.panel.map((item) => ({ ...item })), judge: progress.judge ? { ...progress.judge } : undefined });
}

export function activeProgresses(): ScrutinyRunProgress[] {
	return [...progresses.values()].filter((progress) => progress.status === "running").sort((a, b) => a.startedAt - b.startedAt);
}

export function activeRuns(): RunRecord[] {
	return runs.filter((r) => r.status === "running");
}

export function recentRuns(limit = MAX_REMEMBERED): RunRecord[] {
	return runs.slice(0, limit);
}

function trim(): void {
	if (runs.length > MAX_REMEMBERED) runs.length = MAX_REMEMBERED;
}
