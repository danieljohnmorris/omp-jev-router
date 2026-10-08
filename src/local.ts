import type { Model } from "@oh-my-pi/pi-ai";
import { TIERS } from "./router";
import type { Candidate, CandidateSpec, QuotaState, Tier } from "./types";

/**
 * Tier for each local model id. Nothing here is `strong`, on purpose: the owned
 * hardware serves the workhorse and small roles, so an architecture-sized floor
 * always leaves for the frontier. An id absent from this map is not a candidate
 * at all, which also keeps the per-head `sparks-live-*` discovery providers from
 * competing with the aggregated one they duplicate.
 */
export const DEFAULT_SPARKS_TIERS: Record<string, Tier> = {
	"GLM-5.3-Flash-EXL3": "balanced",
	"GLM-5.3-EXL3": "balanced",
	"DeepSeek-v4.1-Flash-EXL3": "balanced",
	"deepseek-v4.1-flash": "balanced",
	"deepseek-v4-flash-vision-exp": "balanced",
	"Qwen3.8-Flash-Next": "quick",
	"Gemma-4-26B-A4B": "quick",
	"Nemotron-3.5-Lightning-30B": "quick",
};

export const DEFAULT_SPARKS_PROVIDER = "sparks";

/** Cache of liveness probes, so a route pays one round trip rather than one per turn. */
const probes = new Map<string, { live: boolean; at: number }>();

/**
 * Is this provider local hardware? The cluster exposes one provider per head
 * (`sparks-live-spark1|2|3`) next to the aggregated `sparks`; both are the same
 * boxes, and a model id can appear under either.
 */
export function isLocalProvider(provider: string, sparksProvider: string): boolean {
	return provider === sparksProvider || provider.startsWith(`${sparksProvider}-`);
}

/**
 * Local models the tier map declares a tier for, in catalogue order.
 *
 * Only the aggregated provider is a candidate source. The per-head
 * `sparks-live-*` providers are discovery views of the same boxes: their
 * baseUrl is one node, which lists every configured model id whether or not that
 * node serves it, so a candidate taken from one would pass the liveness probe
 * and then 404 the model. `isLocalProvider` stays broad for quota and billing,
 * where duplicates are harmless — a model on the cluster is never metered
 * whichever provider name it is reached through.
 */
export function localSpecs(models: Model[], sparksProvider: string, tiers: Record<string, Tier>): CandidateSpec[] {
	const out: CandidateSpec[] = [];
	for (const model of models) {
		if (model.provider !== sparksProvider) continue;
		const declared = tiers[model.id];
		if (!declared) continue;
		out.push({ model: `${model.provider}/${model.id}`, tier: declared });
	}
	return out;
}

/**
 * Local hardware spends nothing, so its quota is a constant rather than a
 * measurement: full headroom and zero pressure, which is what makes it win the
 * pressure comparison against every metered provider. It is deliberately not
 * `plan`: under `credits: "off"` that billing is what the selector falls back to
 * when nothing measurable is left, and local hardware needs no such fallback.
 */
export function localQuota(now = Date.now()): QuotaState {
	return {
		status: "available",
		reason: "local hardware: no quota to spend",
		fetchedAt: now,
		remainingFraction: 1,
		pressure: 0,
		windows: [],
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Model ids from an OpenAI-compatible `/models` body, or undefined if the shape is not one. */
function servedIds(body: unknown): string[] | undefined {
	if (!record(body) || !Array.isArray(body.data)) return undefined;
	const ids: string[] = [];
	for (const entry of body.data) if (record(entry) && typeof entry.id === "string") ids.push(entry.id);
	return ids;
}

/**
 * Is this endpoint serving *this* model?
 *
 * A reachable endpoint is not enough. The cluster runs one recipe at a time and
 * the head lists every configured model id whether or not the running recipe
 * answers it — and the aggregated `sparks` provider points all of those ids at
 * that one baseUrl. So without the id check the router passes every local model
 * whenever anything is up, and picks ones the head does not serve: observed
 * live, routing chose `deepseek-v4-flash-vision-exp` on a head running only
 * GLM-5.3-Flash-EXL3. `GET /v1/models` is the authoritative check the repo
 * documents for exactly this reason.
 *
 * A body in an unrecognised shape counts as live: a server that answers
 * `/models` in another dialect should not blackhole every local candidate.
 * Cached per endpoint *and* id, since several ids share one baseUrl.
 */
export async function endpointLive(baseUrl: string, modelId: string, ttlMs: number, timeoutMs: number): Promise<boolean> {
	const key = `${baseUrl}\u0000${modelId}`;
	const now = Date.now();
	const cached = probes.get(key);
	if (cached && now - cached.at < ttlMs) return cached.live;
	let live = false;
	try {
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
		} else {
			let ids: string[] | undefined;
			try {
				ids = servedIds(await response.json());
			} catch {
				ids = undefined;
			}
			live = ids === undefined || ids.includes(modelId);
		}
	} catch {
		// Only an unreachable endpoint is dead on its own account. A body this code
		// cannot read is not evidence the model is absent.
		live = false;
	}
	probes.set(key, { live, at: now });
	return live;
}

/**
 * While local hardware is serving, it takes every turn at or below the highest
 * tier it can claim, and the cloud is kept for the floors above that.
 *
 * This is a filter rather than a preference because the selector's own tie-break
 * would otherwise hand a `quick` floor to a cheaper-tier cloud model, and paying
 * for a turn the owned hardware can answer is the one outcome `sparks: "on"`
 * exists to prevent. It is only ever applied when the switch is on, so the cloud
 * candidate list is untouched for every user who leaves it off.
 */
export function preferLocal(candidates: Candidate[], sparksProvider: string): { candidates: Candidate[]; released: number } {
	const local = candidates.filter((candidate) => isLocalProvider(candidate.model.provider, sparksProvider));
	if (local.length === 0) return { candidates, released: 0 };
	let ceiling = -1;
	for (const candidate of local) ceiling = Math.max(ceiling, TIERS.indexOf(candidate.tier));
	const kept = candidates.filter(
		(candidate) => isLocalProvider(candidate.model.provider, sparksProvider) || TIERS.indexOf(candidate.tier) > ceiling,
	);
	return { candidates: kept, released: candidates.length - kept.length };
}
