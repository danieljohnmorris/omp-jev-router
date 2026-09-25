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
	 * `off`: only measured plan headroom and unmeasured plan-subscription (OAuth)
	 * candidates count; the router stands down rather than spend a credit-billed
	 * balance it cannot see. Plan subscriptions are capped upstream, so routing
	 * to them blind cannot overspend.
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

/**
 * How a candidate's provider bills this session's credential. `plan` (OAuth
 * subscription) is capped upstream and safe to route blind; `credit` (API key)
 * can overspend; `unknown` is treated as `credit` under `credits: "off"`.
 */
export type Billing = "plan" | "credit" | "unknown";

export interface Candidate {
	model: Model;
	tier: Tier;
	thinking?: string;
	quota: QuotaState;
	billing: Billing;
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
