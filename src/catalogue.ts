import type { Model } from "@oh-my-pi/pi-ai";
import type { CandidateSpec, Tier } from "./types";

/**
 * Upper bound of output price (USD per million tokens) for each tier. A model
 * priced above the last bound is `strong`. Prices are the only capability
 * signal the catalogue carries that is comparable across providers.
 */
const TIER_CEILING: Array<{ tier: Tier; maxOutput: number }> = [
	{ tier: "quick", maxOutput: 2 },
	{ tier: "balanced", maxOutput: 15 },
];

/** Dated snapshot ids (`...-20251101`) duplicate a rolling alias in the same catalogue. */
const SNAPSHOT_SUFFIX = /-\d{8}$/;

/** Batch routes trade latency for price; they are unusable for an interactive turn. */
const BATCH_SUFFIX = /:batch$/;

function outputPrice(model: Model): number | undefined {
	const cost = (model as { cost?: { output?: number } }).cost;
	return typeof cost?.output === "number" && Number.isFinite(cost.output) ? cost.output : undefined;
}

export function tierFor(price: number): Tier {
	for (const band of TIER_CEILING) {
		if (price <= band.maxOutput) return band.tier;
	}
	return "strong";
}

/**
 * Derive candidates from the models this OMP install is authenticated for, so a
 * user who never writes a config still routes across their own providers.
 *
 * Only chat models that accept text are eligible; `balanced` and `strong` also
 * require reasoning support, because those tiers exist to buy deliberation.
 * Each tier keeps its most expensive models first (price is the capability
 * proxy inside a band) and at most one model per provider, so a tier spans
 * providers and stays useful when one of them runs out of quota. `perTier`
 * bounds the quota probe on installs with hundreds of models.
 */
export function catalogueCandidates(models: Model[], perTier = 3): CandidateSpec[] {
	const byTier: Record<Tier, Array<{ model: Model; price: number }>> = { quick: [], balanced: [], strong: [] };
	for (const model of models) {
		if (model.kind !== undefined && model.kind !== null && model.kind !== "chat") continue;
		if (Array.isArray(model.input) && !model.input.includes("text")) continue;
		if (SNAPSHOT_SUFFIX.test(model.id) || BATCH_SUFFIX.test(model.id)) continue;
		const price = outputPrice(model);
		if (price === undefined) continue;
		const tier = tierFor(price);
		if (tier !== "quick" && !model.reasoning) continue;
		byTier[tier].push({ model, price });
	}
	const out: CandidateSpec[] = [];
	for (const tier of ["quick", "balanced", "strong"] as const) {
		const ranked = byTier[tier].sort((a, b) => b.price - a.price || (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0));
		const seen = new Set<string>();
		for (const entry of ranked) {
			if (seen.size >= perTier) break;
			if (seen.has(entry.model.provider)) continue;
			seen.add(entry.model.provider);
			out.push({ model: `${entry.model.provider}/${entry.model.id}`, tier });
		}
	}
	return out;
}
