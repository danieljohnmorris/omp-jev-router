import type { Model, UsageReport } from "@oh-my-pi/pi-ai";

export type Tier = "quick" | "balanced" | "strong";
export type RoutingMode = "auto" | "off";
export type CreditsMode = "on" | "off";

/** A model the router may select, and the tier it satisfies. */
export interface CandidateSpec {
	/** `provider/id` or a role alias. */
	model: string;
	tier: Tier;
	thinking?: string;
}

export interface RouterConfig {
	/** Routing for this session's own model. */
	main: RoutingMode;
	/** Routing for subagents spawned through the `task` tool. */
	tasks: RoutingMode;
	/** Explicit candidates. Empty means derive them from the authenticated catalogue. */
	candidates: CandidateSpec[];
	/** Models kept per tier when candidates are derived from the catalogue. */
	cataloguePerTier: number;
	/** Tier → agent name used when `tasks` routing is on and the caller left the agent unset. */
	taskAgents: Partial<Record<Tier, string>>;
	timeoutMs: number;
	quotaTimeoutMs: number;
	quotaMaxAgeMs: number;
	/**
	 * `on`: providers with no readable quota (credit-billed ones, or any provider
	 * on a build with no usage API) stay selectable, ranked below measured ones.
	 * `off`: only measured plan headroom counts, and the router stands down when
	 * nothing is measurable rather than spending a balance it cannot see.
	 */
	credits: CreditsMode;
	/** How long a "no credits left" mark holds before the provider is retried. */
	creditRecheckMs: number;
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
	source: "jev" | "jev-low-confidence" | "fallback" | "image";
	reason: string;
}

export interface Decision {
	candidate?: Candidate;
	reason: string;
}
