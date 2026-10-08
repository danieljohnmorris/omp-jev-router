import type { Model, UsageReport } from "@oh-my-pi/pi-ai";

export type Tier = "quick" | "balanced" | "strong";
export type RoutingMode = "auto" | "off";
export type CreditsMode = "on" | "off";
/** `on` puts local hardware in the candidate list; `off` leaves the cloud alone. */
export type SparksMode = "on" | "off";

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
	/**
	 * `on`: models on the local endpoint join the candidate list, and while any
	 * of them is serving they take every turn at or below the highest tier they
	 * can claim. `off`: cloud candidates only.
	 */
	sparks: SparksMode;
	/** Provider whose models are local hardware. */
	sparksProvider: string;
	/**
	 * Model id → tier for local models. An id absent from this map is never a
	 * candidate, and the map deliberately declares nothing `strong`, so an
	 * architecture-sized floor always leaves for the frontier.
	 */
	sparksTiers: Record<string, Tier>;
	/** How long a liveness probe of a local endpoint stands before it is re-probed. */
	sparksLivenessMs: number;
	/** Liveness probe deadline for one local endpoint. */
	sparksTimeoutMs: number;
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
 *
 * `local` bills nothing at all: hardware the user already owns, reachable only
 * while `sparks` is on, carrying no balance that routing could spend.
 */
export type Billing = "plan" | "credit" | "unknown" | "local";

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
