import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { ScrutinyAnalysis, ScrutinyUsage } from "./types.js";

export function createRunId(): string {
	return `scr_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function truncate(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

export function formatTokens(count: number): string {
	if (!count) return "0";
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${Math.round(count / 1_000)}k`;
}

export function usageZero(): ScrutinyUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function addUsage(a: ScrutinyUsage, b: Partial<ScrutinyUsage> | undefined): ScrutinyUsage {
	return {
		input: a.input + (b?.input ?? 0),
		output: a.output + (b?.output ?? 0),
		cacheRead: a.cacheRead + (b?.cacheRead ?? 0),
		cacheWrite: a.cacheWrite + (b?.cacheWrite ?? 0),
		cost: a.cost + (b?.cost ?? 0),
		contextTokens: Math.max(a.contextTokens, b?.contextTokens ?? 0),
		turns: a.turns + (b?.turns ?? 0),
	};
}

export function getAssistantText(message: any): string {
	if (!message || message.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (part.type === "text") return String(part.text ?? "");
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export function extractUsage(message: any): Partial<ScrutinyUsage> | undefined {
	const usage = message?.usage;
	if (!usage || typeof usage !== "object") return undefined;
	return {
		input: Number(usage.input ?? 0),
		output: Number(usage.output ?? 0),
		cacheRead: Number(usage.cacheRead ?? 0),
		cacheWrite: Number(usage.cacheWrite ?? 0),
		cost: Number(usage.cost?.total ?? usage.cost ?? 0),
		contextTokens: Number(usage.totalTokens ?? 0),
		turns: 1,
	};
}

export function parseAnalysisJson(text: string): ScrutinyAnalysis | undefined {
	const trimmed = text.trim();
	const candidates = [trimmed, stripFence(trimmed), firstJsonObject(trimmed)].filter((value): value is string => Boolean(value));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as ScrutinyAnalysis;
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			// try next
		}
	}
	return undefined;
}

export function safeMkdir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function stripFence(text: string): string | undefined {
	const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return match?.[1]?.trim();
}

function firstJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}
