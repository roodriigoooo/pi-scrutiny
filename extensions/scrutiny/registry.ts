import type { ScrutinySurface } from "./types.js";

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

export function recordRunStart(rec: RunRecord): void {
	runs.unshift({ ...rec });
	trim();
}

export function recordRunEnd(runId: string, patch: Partial<RunRecord>): void {
	const rec = runs.find((r) => r.runId === runId);
	if (rec) Object.assign(rec, patch);
	trim();
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
