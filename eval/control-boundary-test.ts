import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatFailureBrief, formatScrutinyBrief, formatVerifyBrief } from "../extensions/scrutiny/analysis.ts";
import { SCRUTINY_STOP_STATEMENT, SCRUTINY_SURFACES, SURFACE_NEXT_STEP_LINES } from "../extensions/scrutiny/surfaces.ts";
import type { PanelResponse, VerifyReport } from "../extensions/scrutiny/types.ts";

const extensionPath = path.resolve(process.cwd(), "extensions/scrutiny.ts");
const probePath = path.resolve(process.cwd(), "eval/control-boundary-probe.ts");

type ObservedMessage = {
	phase: "start" | "end";
	role: string;
	customType?: string;
	runId?: string;
	artifactsAtStart?: { result: boolean; verify: boolean };
};

type PiRun = { code: number; stdout: string; stderr: string; timedOut: boolean; events: string[]; messages: ObservedMessage[] };
type ProbeReport = {
	events: string[];
	messages: Array<{
		phase: "start" | "end";
		role: string;
		customType?: string;
		runId?: string;
		artifactsAtStart?: { result: boolean; verify: boolean };
	}>;
	tools?: Array<{ name: string; sourceInfo?: unknown }>;
	commands?: Array<{ name: string; source?: string }>;
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
	const tempDirs: string[] = [];
	try {
		const registrationDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scrutiny-boundaries-registration-"));
		tempDirs.push(registrationDir);
		await checkRegistrationBoundary(registrationDir);

		checkActivationSource();
		checkBriefBoundaries();

		const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scrutiny-boundaries-runtime-"));
		tempDirs.push(runtimeDir);
		await checkVerifyRuntime(runtimeDir);

		console.log("suite: boundaries · 4/4 pass");
	} finally {
		for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
	}
}

async function checkRegistrationBoundary(cwd: string): Promise<void> {
	const probeOutput = path.join(cwd, "registration-probe.json");
	const run = await runPi(
		["--no-extensions", "--no-builtin-tools", "-e", extensionPath, "-e", probePath, "--mode", "json", "--no-session", "/scrutiny-boundary-probe"],
		cwd,
		{ PI_SCRUTINY_BOUNDARY_PROBE_OUT: probeOutput },
	);
	const report = readProbe(probeOutput, run);
	assert(run.code === 0 && !run.timedOut, `registration probe did not settle: ${run.stderr || run.stdout}`);
	const tools = report.tools ?? [];
	for (const tool of tools) {
		const identity = JSON.stringify({ name: tool.name, sourceInfo: tool.sourceInfo }).toLowerCase();
		assert(!identity.includes("scrutiny"), `Scrutiny-owned tool remains registered: ${identity}`);
	}
	assert(
		report.commands?.some((command) => command.name === "scrutiny" && (!command.source || command.source === "extension")),
		"/scrutiny command is not registered",
	);
	console.log("  ✓ registration boundary");
}

function checkActivationSource(): void {
	const files = [extensionPath, ...fs.readdirSync(path.dirname(extensionPath)).filter((file) => file.endsWith(".ts")).map((file) => path.join(path.dirname(extensionPath), file))];
	const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
	assert(!/\bregisterTool\s*\(/.test(source), "extension activation path registers a model tool");
	assert(!/\bon\s*\(\s*["'](?:input|before_agent_start)["']/.test(source), "extension activation path intercepts natural-language input");
	assert(!/\bsendUserMessage\s*\(/.test(source), "extension activation path sends a user message");
	assert(!/triggerTurn\s*:\s*true/.test(source), "extension activation path triggers an agent turn");
	console.log("  ✓ activation source boundary");
}

function checkBriefBoundaries(): void {
	const response = panelResponse();
	const verify = verifyReport();
	for (const surface of SCRUTINY_SURFACES) {
		const brief = surface === "verify"
			? formatVerifyBrief({ verify, budgetLine: "budget: boundary probe" })
			: formatScrutinyBrief({
				surface,
				panelMode: surface === "repo-map" || surface === "risks" ? "roles" : "replicate",
				analysis: undefined,
				responses: [response],
				failedModels: [],
				judgeRan: false,
				llmPanelExcerptChars: 200,
				budgetLine: "budget: boundary probe",
			});
		assert(brief.includes(SURFACE_NEXT_STEP_LINES[surface]), `${surface}: missing human-choice footer`);
		assert(brief.includes(SCRUTINY_STOP_STATEMENT), `${surface}: missing idle stop statement`);
		assert(!brief.includes("RECOMMENDED NEXT ACTION"), `${surface}: autonomous action line remains`);
	}

	const failure = formatFailureBrief({
		surface: "consult",
		runId: "scr_boundary",
		runDir: "/tmp/scr_boundary",
		responses: [],
		failedModels: [{ model: "probe/model", error: "probe failure" }],
		reason: "probe failure",
	});
	assert(failure.includes(SURFACE_NEXT_STEP_LINES.consult), "failure: missing human-choice footer");
	assert(failure.includes(SCRUTINY_STOP_STATEMENT), "failure: missing idle stop statement");
	assert(!failure.includes("RECOMMENDED NEXT ACTION"), "failure: autonomous action line remains");
	assert(!failure.includes("Tell the user"), "failure: indirect agent instruction remains");
	console.log("  ✓ brief boundaries");
}

async function checkVerifyRuntime(cwd: string): Promise<void> {
	const run = await runPi(
		["--no-extensions", "--no-builtin-tools", "-e", extensionPath, "--mode", "json", "--no-session", "/scrutiny verify:"],
		cwd,
		{
			PI_SCRUTINY_PANEL: "",
			PI_SCRUTINY_INCLUDE_GIT_DIFF: "false",
			PI_SCRUTINY_VERIFY_CHECKS: JSON.stringify([{ name: "probe", command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 }]),
		},
	);
	assert(run.code === 0 && !run.timedOut, `verify probe did not settle: ${run.stderr || run.stdout}`);
	const starts = run.messages.filter((message) => message.phase === "start" && message.customType === "scrutiny-result");
	const ends = run.messages.filter((message) => message.phase === "end" && message.customType === "scrutiny-result");
	assert(starts.length === 1 && ends.length === 1, `expected one scrutiny-result message, got ${starts.length} start/${ends.length} end`);
	assert(starts[0]?.artifactsAtStart?.result, "result.json was not present before custom message completion");
	assert(starts[0]?.artifactsAtStart?.verify, "verify.json was not present before custom message completion");
	assert(!run.events.includes("agent_start"), "verify command started an agent turn");
	assert(!run.events.includes("turn_start"), "verify command started a turn");
	assert(!run.messages.some((message) => message.role === "assistant"), "verify command emitted an assistant message");
	assert(!run.events.some((event) => event.startsWith("tool_execution_")), "verify command executed an agent tool");
	assert(run.events.some((event) => event === "message_end:custom"), "custom result did not settle");
	console.log("  ✓ verify runtime boundary");
}

function panelResponse(): PanelResponse {
	return {
		model: "probe/model",
		role: "probe",
		status: "ok",
		content: "Probe evidence is available for human review.",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
		durationMs: 1,
		exitCode: 0,
	};
}

function verifyReport(): VerifyReport {
	return {
		checks: [{ name: "probe", command: "node", status: "pass", durationMs: 1 }],
		passed: 1,
		failed: 0,
		skipped: 0,
		durationMs: 1,
	};
}

function readProbe(file: string, run: PiRun): ProbeReport {
	assert(fs.existsSync(file), `probe report missing (exit ${run.code}): ${run.stderr || run.stdout}`);
	return JSON.parse(fs.readFileSync(file, "utf8")) as ProbeReport;
}

function runPi(args: string[], cwd: string, env: Record<string, string>, timeoutMs = 30_000): Promise<PiRun> {
	return new Promise((resolve) => {
		const events: string[] = [];
		const messages: ObservedMessage[] = [];
		const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
		let stdout = "";
		let stderr = "";
		let buffer = "";
		let timedOut = false;
		const observe = (line: string): void => {
			if (!line.trim()) return;
			let event: any;
			try { event = JSON.parse(line); } catch { return; }
			if (typeof event.type !== "string") return;
			if (event.type === "message_start" || event.type === "message_end") {
				const message = event.message as any;
				const role = typeof message?.role === "string" ? message.role : "unknown";
				events.push(`${event.type}:${role}`);
				const observed: ObservedMessage = {
					phase: event.type === "message_start" ? "start" : "end",
					role,
					customType: typeof message?.customType === "string" ? message.customType : undefined,
				};
				if (observed.customType === "scrutiny-result" && observed.phase === "start") {
					const runId = typeof message?.details?.runId === "string" ? message.details.runId : undefined;
					observed.runId = runId;
					if (runId) {
						const runDir = path.join(cwd, ".pi", "scrutiny", runId);
						observed.artifactsAtStart = {
							result: fs.existsSync(path.join(runDir, "result.json")),
							verify: fs.existsSync(path.join(runDir, "verify.json")),
						};
					}
				}
				messages.push(observed);
				return;
			}
			events.push(event.type);
		};
		const flush = (): void => {
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				observe(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
		}, timeoutMs);
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			buffer += chunk.toString();
			flush();
		});
		proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		proc.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout, stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`, timedOut, events, messages });
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			observe(buffer);
			resolve({ code: code ?? 1, stdout, stderr, timedOut, events, messages });
		});
	});
}

main().catch((error) => {
	console.error(`suite: boundaries · fail · ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
