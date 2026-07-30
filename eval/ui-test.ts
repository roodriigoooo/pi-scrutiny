import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { activeProgresses, recordRunProgress } from "../extensions/scrutiny/registry.ts";
import type { ScrutinyRunProgress } from "../extensions/scrutiny/types.ts";
import { renderScrutinyDock, renderScrutinyPendingDock } from "../extensions/scrutiny/ui.ts";

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

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const startedAt = 1_000;
const now = 32_000;

function progress(patch: Partial<ScrutinyRunProgress> = {}): ScrutinyRunProgress {
	return {
		runId: `ui-${Math.random()}`,
		surface: "risks",
		template: "risks",
		panelName: "balanced",
		strategy: "roles",
		panel: [
			{ model: "provider-a/first-model-with-a-long-name", role: "security reviewer", status: "ready", startedAt: 1_100, endedAt: 4_000 },
			{ model: "provider-b/second-model", role: "concurrency reviewer", status: "running", startedAt: 20_000 },
			{ model: "provider-c/third-model", role: "API compatibility reviewer", status: "pending" },
		],
		phase: "panel",
		startedAt,
		updatedAt: now,
		status: "running",
		...patch,
	};
}

function assertWidth(lines: string[], width: number): void {
	for (const line of lines) assert(visibleWidth(line) <= width, `line width ${visibleWidth(line)} exceeds ${width}: ${line}`);
}

async function main(): Promise<void> {
	process.stdout.write("scrutiny progress UI · 6 checks\n");

	await check("waiting and starting use the same quiet component language", () => {
		for (const phase of ["waiting", "starting"] as const) {
			const lines = renderScrutinyPendingDock(phase, theme, 42, 31_000);
			const rendered = lines.join("\n");
			assert(rendered.includes(`phase ${phase}`), `${phase} phase label missing`);
			assert(rendered.includes("esc cancel"), `${phase} cancellation missing`);
			assert(!/[◆◐→●×]/.test(rendered), `${phase} reintroduced mixed indicators`);
			assertWidth(lines, 42);
		}
	});

	await check("sequential panel rows remain ordered and expose current, finished, and next work", () => {
		const lines = renderScrutinyDock([progress()], theme, 110, now);
		const rendered = lines.join("\n");
		assert(rendered.includes("phase panel 2/3"), "current sequential position missing");
		const rows = lines.filter((line) => line.startsWith("panel "));
		assert(rows[0]?.startsWith("panel 1/3") && rows[1]?.startsWith("panel 2/3") && rows[2]?.startsWith("panel 3/3"), "panel order moved");
		assert(rendered.includes("ready") && rendered.includes("running 12.0s") && rendered.includes("pending"), "consistent state words missing");
		assert(rendered.includes("second-model") && rendered.includes("concurrency reviewer"), "current model/lens missing");
		assert(rendered.includes("esc cancel"), "cancellation instruction missing");
		assert(!/[◆◐→●×]/.test(rendered), "mixed indicator family remains");
	});

	await check("partial panel failure stays legible without hiding pending work", () => {
		const value = progress({
			strategy: "replicate",
			panel: [
				{ model: "a/model", role: "first", status: "ready" },
				{ model: "b/model", role: "second", status: "failed" },
				{ model: "c/model", role: "third", status: "running", startedAt: 30_000 },
			],
		});
		const rendered = renderScrutinyDock([value], theme, 72, now).join("\n");
		assert(rendered.includes("risks · replicate"), "replicate strategy is not visible");
		assert(rendered.includes("failed") && rendered.includes("running 2.0s"), "failure or continuing work missing");
		assert(rendered.includes("2/3 panelists finished"), "partial completion summary incorrect");
	});

	await check("evidence-map work uses the same aligned state vocabulary", () => {
		const value = progress({
			phase: "evidence-map",
			panel: progress().panel.map((item) => ({ ...item, status: "ready" as const })),
			judge: { model: "provider/judge-model", role: "trade-off explainer", status: "running", startedAt: 25_000 },
		});
		const rendered = renderScrutinyDock([value], theme, 86, now).join("\n");
		assert(rendered.includes("phase evidence map"), "evidence-map phase missing");
		assert(rendered.includes("map") && rendered.includes("running 7.0s") && rendered.includes("trade-off explainer"), "map row does not match panel grammar");
	});

	await check("verify-only and mixed-result checks stay stable at narrow widths", () => {
		const value = progress({
			surface: "verify",
			strategy: undefined,
			panel: [],
			phase: "verify",
			verifyChecks: [
				{ name: "typecheck-with-a-very-long-name", status: "pass", startedAt: 2_000, endedAt: 5_000 },
				{ name: "unit tests", status: "fail", startedAt: 6_000, endedAt: 8_000 },
				{ name: "integration tests", status: "running", startedAt: 30_000 },
				{ name: "lint", status: "pending" },
			],
		});
		for (const width of [32, 48, 80]) {
			const lines = renderScrutinyDock([value], theme, width, now);
			assertWidth(lines, width);
			const rendered = lines.join("\n");
			assert(rendered.includes("verify"), `verify phase missing at ${width}`);
			assert(rendered.includes("esc cancel"), `cancellation missing at ${width}`);
			assert(rendered.includes("check 1/4"), `stable check rows missing at ${width}`);
		}
		const wide = renderScrutinyDock([value], theme, 100, now).join("\n");
		assert(wide.includes("pass") && wide.includes("fail") && wide.includes("running 2.0s") && wide.includes("pending"), "mixed verify states missing");
	});

	await check("terminal progress leaves the active registry and renders explicit failure when inspected", () => {
		const running = progress({ runId: "ui-terminal-registry" });
		recordRunProgress(running);
		assert(activeProgresses().some((item) => item.runId === running.runId), "running progress not active");
		const completed = { ...running, phase: "complete" as const, status: "ok" as const, message: "done", updatedAt: now };
		recordRunProgress(completed);
		assert(!activeProgresses().some((item) => item.runId === running.runId), "completed progress stayed active");
		assert(renderScrutinyDock([completed], theme, 70, now).join("\n").includes("phase complete"), "completion phase is not explicit");
		const failed = { ...running, phase: "complete" as const, status: "error" as const, message: "cancelled by user", updatedAt: now };
		recordRunProgress(failed);
		assert(!activeProgresses().some((item) => item.runId === running.runId), "terminal progress stayed active");
		const rendered = renderScrutinyDock([failed], theme, 70, now).join("\n");
		assert(rendered.includes("phase failed") && rendered.includes("failure cancelled by user"), "run failure is not explicit");
	});

	const pass = checks - failures.length;
	process.stdout.write(`\nsuite: progress UI · ${pass}/${checks} pass · ${failures.length} fail\n`);
	if (failures.length) {
		process.stdout.write("\nfailures:\n");
		for (const failure of failures) process.stdout.write(`- ${failure.name}: ${failure.error}\n`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(`suite: progress UI · fail · ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
