import type { Model, UsageReport } from "@oh-my-pi/pi-ai";

export type Tier = "quick" | "balanced" | "strong";
export type RoutingMode = "auto" | "off";

export interface RouterConfig {
	/** Routing for this session's own model. */
	main: RoutingMode;
	/** Routing for subagents spawned through the `task` tool. */
	tasks: RoutingMode;
	/** Model specs (`provider/id` or role alias) with the tier they satisfy. */
	candidates: Array<{ model: string; tier: Tier; thinking?: string }>;
	/** Tier → agent name used when `tasks` routing is on and the caller left the agent unset. */
	taskAgents: Partial<Record<Tier, string>>;
	timeoutMs: number;
	quotaTimeoutMs: number;
	quotaMaxAgeMs: number;
	confidenceThreshold: number;
	maxPromptChars: number;
	contextReserveTokens: number;
}

export interface QuotaSnapshot {
	reports: UsageReport[];
	checkedAt: number;
	error?: string;
}

export interface QuotaWindow {
	label: string;
	remainingFraction?: number;
	resetsAt?: number;
	durationMs?: number;
}

export interface QuotaState {
	status: "available" | "exhausted" | "unknown" | "stale";
	reason: string;
	fetchedAt?: number;
	remainingFraction?: number;
	pressure?: number;
	windows: QuotaWindow[];
}

export interface Candidate {
	model: Model;
	tier: Tier;
	thinking?: string;
	quota: QuotaState;
}

export interface Triage {
	tier: Tier;
	confidence: number;
	source: "jev" | "fallback" | "image";
	reason: string;
}

export interface Decision {
	candidate?: Candidate;
	reason: string;
}
