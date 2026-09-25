import type { Tier, Triage } from "./types";

/** Tier floor state for hysteresis: when user approves a task with simple continuation words,
 * keep the tier for follow-ups until expired or a new complex prompt resets it. */
export interface FloorHysteresis {
	tier: Tier;
	at: number;
}

const CONTINUATION_WORDS = /^\s*(yes|yep|ok|okay|sure|got it|right|correct|exactly|go ahead|proceed|continue|do it|let's do it|do that)\s*$/i;
// 30 minutes. The floor exists to survive a user reading a plan before replying "yes";
// a short window defeats that, and the floor only ever raises tier, so erring long is cheap.
const HYSTERESIS_EXPIRY_MS = 30 * 60_000;

/**
 * Detects low-information continuation messages that shouldn't reset capability tier.
 * Matches simple affirmations, single-word replies, or short confirmations.
 */
export function isContinuation(prompt: string): boolean {
	return CONTINUATION_WORDS.test(prompt.trim());
}

/**
 * Apply hysteresis floor: if the previous choice was "strong" or "balanced" and the
 * new prompt is just a continuation word, raise the tier floor to match the previous floor.
 * Tier only falls (resets to "quick") on new complex prompts or if hysteresis expires.
 */
export function applyFloorHysteresis(triage: Triage, hysteresis: FloorHysteresis | undefined, prompt: string, now: number): Triage {
	if (!hysteresis || now - hysteresis.at > HYSTERESIS_EXPIRY_MS) {
		// Hysteresis expired or not set; accept the fresh classification.
		return triage;
	}
	if (isContinuation(prompt)) {
		// Simple follow-up after an approved task; inherit the tier floor.
		if (triage.tier !== hysteresis.tier && (triage.tier === "quick" || hysteresis.tier === "strong")) {
			return {
				...triage,
				tier: hysteresis.tier,
				source: triage.source === "fallback" ? "fallback" : "jev", // Keep source honest, unless it was fallback.
				reason: `${triage.reason}; inherited floor from the approved task`,
			};
		}
	}
	// Complex new prompt: hysteresis expires, accept the fresh classification.
	return triage;
}

/**
 * Update hysteresis after a decision: record the tier floor for future continuation messages.
 * Only record strong/balanced models; if quick was chosen, clear hysteresis (single-turn task).
 */
export function updateFloorHysteresis(tier: Tier, now: number): FloorHysteresis | undefined {
	return tier === "quick" ? undefined : { tier, at: now };
}
