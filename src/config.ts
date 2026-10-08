import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RouterConfig, RoutingMode, SparksMode, Tier } from "./types";
import { DEFAULT_SPARKS_PROVIDER, DEFAULT_SPARKS_TIERS } from "./local";

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
	quotaTimeoutMs: 8_000,
	quotaMaxAgeMs: 10 * 60_000,
	credits: "on",
	creditRecheckMs: 6 * 60 * 60_000,
	sparks: "off",
	sparksProvider: DEFAULT_SPARKS_PROVIDER,
	sparksTiers: { ...DEFAULT_SPARKS_TIERS },
	sparksLivenessMs: 5_000,
	sparksTimeoutMs: 2_000,
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

function sparksMode(value: unknown): SparksMode {
	return value === "on" ? "on" : "off";
}

/**
 * A user's tier map merged over the defaults, so adding local hardware needs one
 * line rather than a copy of the whole list. `"off"` removes an id, which is the
 * only way to drop something the defaults declare.
 */
function sparksTiers(value: unknown): Record<string, Tier> {
	const out: Record<string, Tier> = { ...DEFAULT_SPARKS_TIERS };
	if (!record(value)) return out;
	for (const [id, entry] of Object.entries(value)) {
		if (entry === "off") {
			delete out[id];
			continue;
		}
		if (tier(entry)) out[id] = entry;
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
		credits: raw.credits === "off" ? "off" : "on",
		creditRecheckMs: positive(raw.creditRecheckMs, DEFAULT_CONFIG.creditRecheckMs),
		sparks: sparksMode(raw.sparks),
		sparksProvider:
			typeof raw.sparksProvider === "string" && raw.sparksProvider.trim()
				? raw.sparksProvider.trim()
				: DEFAULT_CONFIG.sparksProvider,
		sparksTiers: sparksTiers(raw.sparksTiers),
		sparksLivenessMs: positive(raw.sparksLivenessMs, DEFAULT_CONFIG.sparksLivenessMs),
		sparksTimeoutMs: positive(raw.sparksTimeoutMs, DEFAULT_CONFIG.sparksTimeoutMs),
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

/**
 * Persist the three switches so a toggle survives a restart. Every other key in
 * the file is preserved, including ones this version does not know about.
 */
export function saveModes(main: RoutingMode, tasks: RoutingMode, sparks: SparksMode, path = CONFIG_PATH): void {
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (record(parsed)) raw = parsed;
	} catch {
		// No readable file: write one holding just the switches.
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...raw, main, tasks, sparks }, null, "\t")}\n`);
}
