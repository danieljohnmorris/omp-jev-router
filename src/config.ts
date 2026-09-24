import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RouterConfig, RoutingMode, Tier } from "./types";

export const CONFIG_PATH = join(homedir(), ".omp", "jev-router.json");

/**
 * Routing is off until the user turns it on. With no explicit `candidates`,
 * the router derives them from the models this install is authenticated for.
 */
export const DEFAULT_CONFIG: RouterConfig = {
	main: "off",
	tasks: "off",
	candidates: [],
	cataloguePerTier: 3,
	taskAgents: {},
	timeoutMs: 4_000,
	quotaTimeoutMs: 4_000,
	quotaMaxAgeMs: 10 * 60_000,
	confidenceThreshold: 0.6,
	maxPromptChars: 4_000,
	contextReserveTokens: 32_000,
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mode(value: unknown, fallback: RoutingMode): RoutingMode {
	return value === "auto" || value === "off" ? value : fallback;
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function tier(value: unknown): value is Tier {
	return value === "quick" || value === "balanced" || value === "strong";
}

function candidates(value: unknown): RouterConfig["candidates"] {
	if (!Array.isArray(value)) return [];
	const out: RouterConfig["candidates"] = [];
	for (const entry of value) {
		if (!record(entry) || typeof entry.model !== "string" || !entry.model.trim() || !tier(entry.tier)) continue;
		out.push({
			model: entry.model.trim(),
			tier: entry.tier,
			thinking: typeof entry.thinking === "string" ? entry.thinking : undefined,
		});
	}
	return out;
}

function taskAgents(value: unknown): RouterConfig["taskAgents"] {
	if (!record(value)) return {};
	const out: RouterConfig["taskAgents"] = {};
	for (const key of ["quick", "balanced", "strong"] as const) {
		const name = value[key];
		if (typeof name === "string" && name.trim()) out[key] = name.trim();
	}
	return out;
}

/** Parse a user config object. Unknown or malformed fields fall back to defaults rather than throwing. */
export function parseConfig(raw: unknown): RouterConfig {
	if (!record(raw)) return { ...DEFAULT_CONFIG };
	const threshold = raw.confidenceThreshold;
	return {
		main: mode(raw.main, DEFAULT_CONFIG.main),
		tasks: mode(raw.tasks, DEFAULT_CONFIG.tasks),
		candidates: candidates(raw.candidates),
		cataloguePerTier: positive(raw.cataloguePerTier, DEFAULT_CONFIG.cataloguePerTier),
		taskAgents: taskAgents(raw.taskAgents),
		timeoutMs: positive(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs),
		quotaTimeoutMs: positive(raw.quotaTimeoutMs, DEFAULT_CONFIG.quotaTimeoutMs),
		quotaMaxAgeMs: positive(raw.quotaMaxAgeMs, DEFAULT_CONFIG.quotaMaxAgeMs),
		confidenceThreshold:
			typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
				? threshold
				: DEFAULT_CONFIG.confidenceThreshold,
		maxPromptChars: positive(raw.maxPromptChars, DEFAULT_CONFIG.maxPromptChars),
		contextReserveTokens: positive(raw.contextReserveTokens, DEFAULT_CONFIG.contextReserveTokens),
	};
}

/** Read the config file. A missing or unreadable file yields defaults (routing off). */
export function loadConfig(path = CONFIG_PATH): RouterConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
