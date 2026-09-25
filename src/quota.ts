import type { Model, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { resolveUsedFraction } from "@oh-my-pi/pi-ai";
import type { Billing, QuotaSnapshot, QuotaState, QuotaWindow, RouterConfig } from "./types";

/**
 * Minimal view of the OMP surfaces this module needs. Keeping it structural lets
 * tests supply fixtures without constructing a real ModelRegistry.
 */
export interface QuotaHost {
	modelRegistry: {
		getProviderBaseUrl(provider: string): string | undefined;
		authStorage: {
			/**
			 * Optional on purpose: OMP's own callers guard it too (`command-controller`
			 * checks `!provider.fetchUsageReports`, `selector-controller` calls it with
			 * `?.()`), and the object an extension receives via `ctx.modelRegistry`
			 * really does omit it on some builds.
			 */
			fetchUsageReports?(options?: {
				baseUrlResolver?: (provider: string) => string | undefined;
				signal?: AbortSignal;
			}): Promise<UsageReport[] | null | undefined>;
			/**
			 * Machine-readable auth provenance; `kind: "oauth"` marks a plan
			 * subscription. Optional for the same reason as `fetchUsageReports`.
			 */
			getCredentialOrigin?(provider: string): { kind: string } | undefined;
			/** Stored credential lookup; `type: "oauth" | "api_key"`. Fallback when origin is absent. */
			get?(provider: string): { type: string } | undefined;
			/** 18.3.1 facade: credential store facet. `hasOAuth` marks a plan login. */
			credentials?: {
				hasOAuth?(provider: string): boolean;
				get?(provider: string): { type?: string } | undefined;
			};
			/**
			 * 18.3.1 facade: usage facet. `reports(options)` is the replacement for
			 * `fetchUsageReports` and takes the same option bag. The facet also has a
			 * `fetch` property, but that is the injected HTTP fetch implementation,
			 * not a usage call — calling it with an option bag throws.
			 */
			usage?: {
				reports?(options?: {
					baseUrlResolver?: (provider: string) => string | undefined;
					signal?: AbortSignal;
				}): Promise<UsageReport[] | null | undefined>;
			};
		};
	};
}

/**
 * Classify how a provider bills this session: an OAuth credential is a plan
 * subscription (capped upstream), any other resolvable auth is a key that
 * draws down a credit balance. Prefers `getCredentialOrigin`; falls back to
 * the stored credential's `type` because some omp builds (18.3.1) hand
 * extensions an authStorage missing the origin method. Nothing resolvable is
 * `unknown`, which the router treats like `credit` under `credits: "off"`.
 */
export function billingForProvider(host: QuotaHost, provider: string): Billing {
	const auth = host.modelRegistry.authStorage;
	try {
		const origin = auth.getCredentialOrigin?.(provider);
		if (origin) return origin.kind === "oauth" ? "plan" : "credit";
		const stored = auth.get?.(provider);
		if (stored) return stored.type === "oauth" ? "plan" : "credit";
		// 18.3.1 facade: flat methods are gone; the credential store moved to a
		// `credentials` facet. `hasOAuth` is the read-only plan marker.
		const store = auth.credentials;
		if (store?.hasOAuth?.(provider)) return "plan";
		const facetCred = store?.get?.(provider);
		if (facetCred && typeof facetCred.type === "string") return facetCred.type === "oauth" ? "plan" : "credit";
	} catch {
		// A throwing probe is no evidence either way.
	}
	return "unknown";
}

let cached: QuotaSnapshot | undefined;
let inflight: Promise<QuotaSnapshot> | undefined;

/** Test seam: drop the module-level snapshot cache. */
export function resetQuotaCache(): void {
	cached = undefined;
	inflight = undefined;
}

/**
 * Bounded, coalesced usage fetch. Native AuthStorage already caches and
 * de-duplicates upstream calls, so this adds only a deadline and a last-good
 * fallback: a failed refresh keeps the previous reports and records the error,
 * which callers surface as `stale` rather than as spare capacity.
 */
export async function getQuotaSnapshot(host: QuotaHost, config: RouterConfig, now = Date.now()): Promise<QuotaSnapshot> {
	if (cached && now - cached.checkedAt < Math.max(0, config.quotaMaxAgeMs) / 2 && !cached.error) return cached;
	if (inflight) return inflight;
	const run = async (): Promise<QuotaSnapshot> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(1, config.quotaTimeoutMs));
		try {
			const auth = host.modelRegistry.authStorage;
			let reports: unknown;
			if (auth.fetchUsageReports) {
				reports = await auth.fetchUsageReports({
					baseUrlResolver: (provider: string) => host.modelRegistry.getProviderBaseUrl(provider),
					signal: controller.signal,
				});
			} else if (auth.usage?.reports) {
				// 18.3.1 facade: usage reporting moved to a `usage` facet, where
				// `reports` takes the same options as the old flat method.
				reports = await auth.usage.reports({
					baseUrlResolver: (provider: string) => host.modelRegistry.getProviderBaseUrl(provider),
					signal: controller.signal,
				});
			} else {
				// Observed on omp 18.3.1: `ctx.modelRegistry.authStorage` reaches the
				// extension without any usage surface at all.
				return { reports: cached?.reports ?? [], checkedAt: now, error: "usage reports unavailable" };
			}
			if (!Array.isArray(reports)) reports = undefined;
			if (reports === null || reports === undefined) {
				// A null result means the fetch produced no answer at all. Recording it as
				// an empty success would cache "no evidence" as if it were fresh evidence.
				return { reports: cached?.reports ?? [], checkedAt: now, error: "Usage reports were unavailable" };
			}
			const snapshot: QuotaSnapshot = { reports: reports as UsageReport[], checkedAt: Date.now() };
			cached = snapshot;
			return snapshot;
		} catch (error) {
			// Provider error *text* can carry account identifiers, so it never escapes.
			// The error's class and the timeout distinction are not sensitive and are the
			// only two facts that tell you whether to raise the timeout or look at the network.
			const timedOut = controller.signal.aborted;
			const kind = error instanceof Error && error.name && error.name !== "Error" ? error.name : "unknown error";
			const detail = timedOut ? `timed out after ${Math.max(1, config.quotaTimeoutMs)}ms` : kind;
			return { reports: cached?.reports ?? [], checkedAt: now, error: `Usage reports could not be refreshed (${detail})` };
		} finally {
			clearTimeout(timer);
		}
	};
	inflight = run().finally(() => {
		inflight = undefined;
	});
	return inflight;
}

function applies(limit: UsageLimit, model: Model): boolean {
	const scope = limit.scope;
	if (scope.provider !== model.provider) return false;
	if (scope.modelId && scope.modelId !== model.id) return false;
	return true;
}

function describe(limit: UsageLimit, remainingFraction: number | undefined): QuotaWindow {
	return {
		label: limit.window?.label ?? limit.label,
		remainingFraction,
		resetsAt: limit.window?.resetsAt,
		durationMs: limit.window?.durationMs,
	};
}

interface AccountState {
	status: "available" | "exhausted" | "unknown";
	remainingFraction?: number;
	pressure?: number;
	windows: QuotaWindow[];
	reason: string;
}

/**
 * One report is one account. Every applicable window must have known headroom
 * (AND); a single exhausted or unreadable window disqualifies the account.
 */
function accountState(report: UsageReport, model: Model, now: number): AccountState {
	const limits = report.limits.filter((limit) => applies(limit, model));
	if (limits.length === 0) {
		// Empty limits are not evidence of unlimited quota.
		return { status: "unknown", windows: [], reason: "The provider reported no applicable limits" };
	}
	const windows: QuotaWindow[] = [];
	let minRemaining = 1;
	let maxPressure = 0;
	let status: AccountState["status"] = "available";
	let reason = "All applicable windows have headroom";
	for (const limit of limits) {
		const resetsAt = limit.window?.resetsAt;
		if (typeof resetsAt === "number" && resetsAt <= now && report.fetchedAt < resetsAt) {
			// The window reset after this snapshot was taken. Post-reset usage is
			// unmeasured, so it cannot be assumed to be zero.
			windows.push(describe(limit, undefined));
			status = "unknown";
			reason = "A usage window reset after the last snapshot";
			continue;
		}
		const used = resolveUsedFraction(limit);
		if (used === undefined || !Number.isFinite(used)) {
			windows.push(describe(limit, undefined));
			status = "unknown";
			reason = "A usage window reported no readable amount";
			continue;
		}
		const remaining = Math.max(0, 1 - used);
		windows.push(describe(limit, remaining));
		minRemaining = Math.min(minRemaining, remaining);
		if (remaining <= 0 || limit.status === "exhausted") {
			if (status !== "unknown") {
				status = "exhausted";
				reason = `Window ${limit.window?.label ?? limit.label} is exhausted`;
			}
			continue;
		}
		// Headroom is only useful relative to how long it has to last.
		const span = limit.window?.durationMs;
		const timeShare =
			typeof resetsAt === "number" && typeof span === "number" && span > 0
				? Math.min(1, Math.max(0, (resetsAt - now) / span))
				: 1;
		maxPressure = Math.max(maxPressure, timeShare / remaining);
	}
	if (status !== "available") return { status, windows, reason, remainingFraction: undefined };
	return { status, windows, reason, remainingFraction: minRemaining, pressure: maxPressure };
}

/**
 * Aggregate every account for the model's provider. Accounts are OR: one
 * account with headroom keeps the provider usable, because native credential
 * selection owns which account actually serves the request.
 */
export function quotaForModel(snapshot: QuotaSnapshot, model: Model, config: RouterConfig, now = Date.now()): QuotaState {
	const reports = snapshot.reports.filter((report) => report.provider === model.provider);
	if (reports.length === 0) {
		return {
			status: "unknown",
			reason: snapshot.error ?? "No usage report is available for this provider",
			windows: [],
		};
	}
	const fetchedAt = Math.max(...reports.map((report) => report.fetchedAt));
	if (now - fetchedAt > Math.max(0, config.quotaMaxAgeMs)) {
		return {
			status: "stale",
			reason: "The usage report is older than the freshness limit",
			fetchedAt,
			windows: [],
		};
	}
	let best: AccountState | undefined;
	let fallback: AccountState | undefined;
	for (const report of reports) {
		const state = accountState(report, model, now);
		if (state.status === "available") {
			if (!best || (state.pressure ?? Number.POSITIVE_INFINITY) < (best.pressure ?? Number.POSITIVE_INFINITY)) best = state;
			continue;
		}
		// Prefer reporting "exhausted" over "unknown": it is the more specific fact.
		if (!fallback || (fallback.status === "unknown" && state.status === "exhausted")) fallback = state;
	}
	const chosen = best ?? fallback;
	if (!chosen) return { status: "unknown", reason: "No account state could be resolved", fetchedAt, windows: [] };
	return {
		status: chosen.status,
		reason:
			chosen === best && reports.length > 1
				? `${chosen.reason} on at least one account`
				: chosen.reason,
		fetchedAt,
		remainingFraction: chosen.remainingFraction,
		pressure: chosen.pressure,
		windows: chosen.windows,
	};
}
