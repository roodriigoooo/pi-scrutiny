import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PanelResponse } from "./types.js";
import { addUsage, extractUsage, getAssistantText, truncate, usageZero } from "./util.js";

type RunModelTaskInput = {
	model: string;
	role: string;
	prompt: string;
	cwd: string;
	tools: string[];
	timeoutMs: number;
	outputCharLimit: number;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	signal?: AbortSignal;
};

export async function runModelTask(input: RunModelTaskInput): Promise<PanelResponse> {
	const startedAt = Date.now();
	const args = ["--mode", "json", "-p", "--no-session", "--model", input.model];
	if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
	if (input.tools.length > 0) args.push("--tools", input.tools.join(","));
	else args.push("--no-tools");
	args.push(input.prompt);

	let stderr = "";
	let text = "";
	let usage = usageZero();
	let exitCode = 0;
	let timedOut = false;
	let aborted = false;

	try {
		exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: input.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SCRUTINY_DEPTH: "1" },
			});

			let buffer = "";
			const timeout = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
				setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, 3_000);
			}, input.timeoutMs);

			const abort = () => {
				aborted = true;
				proc.kill("SIGTERM");
			};
			input.signal?.addEventListener("abort", abort, { once: true });

			proc.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					processJsonLine(line);
					newline = buffer.indexOf("\n");
				}
			});

			proc.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			proc.on("error", (error) => {
				stderr += `${error instanceof Error ? error.message : String(error)}\n`;
			});

			proc.on("close", (code) => {
				clearTimeout(timeout);
				input.signal?.removeEventListener("abort", abort);
				if (buffer.trim()) processJsonLine(buffer);
				resolve(code ?? 1);
			});
		});
	} catch (error) {
		stderr += error instanceof Error ? error.message : String(error);
		exitCode = 1;
	}

	const durationMs = Date.now() - startedAt;
	const error = timedOut ? `timed out after ${input.timeoutMs}ms` : aborted ? "aborted" : exitCode !== 0 ? stderr.trim() || `exit ${exitCode}` : undefined;
	return {
		model: input.model,
		role: input.role,
		status: error ? "error" : "ok",
		content: truncate(text.trim(), input.outputCharLimit),
		error,
		usage,
		durationMs,
		exitCode,
	};

	function processJsonLine(line: string): void {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "message_end" && event.message) {
			const messageText = getAssistantText(event.message);
			if (messageText.trim()) text = text ? `${text}\n\n${messageText}` : messageText;
			usage = addUsage(usage, extractUsage(event.message));
		}
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}
