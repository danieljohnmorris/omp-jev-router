import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { catalogueCandidates } from "./catalogue";
import { loadConfig, saveModes } from "./config";
import { loadApiKey } from "./credentials";
import { billingForProvider, getQuotaSnapshot, type QuotaHost, quotaForModel } from "./quota";
import { type CreditMarks, dryProviders, isDry, isOutOfCredit, loadCredits, markDry, markTopped } from "./credits";
import { applyFloorHysteresis, updateFloorHysteresis, type FloorHysteresis } from "./hysteresis";
import { chooseCandidate, classify } from "./router";
import type { Candidate, CandidateSpec, RouterConfig, RoutingMode, Tier, Triage } from "./types";

const THINKING_LEVELS: Record<string, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };

interface RouterState {
	config: RouterConfig;
	main: RoutingMode;
	tasks: RoutingMode;
	apiKey?: string;
	credits: CreditMarks;
	lastMain?: string;
	lastTasks?: string;
	/** Tier floor for hysteresis: when user approves a task with simple continuation words,
	 * keep the tier for follow-ups until expired or a new complex prompt resets it. */
	floorHysteresis?: FloorHysteresis;
}

/** Configured candidates win; otherwise derive them from the authenticated catalogue. */
function specsFor(state: RouterState, ctx: ExtensionContext): CandidateSpec[] {
	if (state.config.candidates.length > 0) return state.config.candidates;
	return catalogueCandidates(ctx.models.list(), state.config.cataloguePerTier);
}

/**
 * Candidates the session can actually use right now: authenticated, quota-checked,
 * and large enough to hold the live context plus the configured output reserve.
 *
 * With no configured candidates the specs are derived from the models this
 * install is logged in to, so routing works before the user writes any config.
 */
async function buildCandidates(state: RouterState, ctx: ExtensionContext): Promise<{ candidates: Candidate[]; note?: string }> {
	const host = ctx as unknown as QuotaHost;
	const snapshot = await getQuotaSnapshot(host, state.config);
	const used = ctx.getContextUsage()?.tokens ?? 0;
	const needed = used + state.config.contextReserveTokens;
	const out: Candidate[] = [];
	let unresolved = 0;
	let tooSmall = 0;
	let dry = 0;
	for (const entry of specsFor(state, ctx)) {
		const model = ctx.models.resolve(entry.model);
		if (!model) {
			unresolved++;
			continue;
		}
		if (typeof model.contextWindow === "number" && model.contextWindow < needed) {
			tooSmall++;
			continue;
		}
		if (state.config.credits === "on" && isDry(state.credits, model.provider, state.config.creditRecheckMs)) {
			dry++;
			continue;
		}
		out.push({
			model,
			tier: entry.tier,
			thinking: entry.thinking && THINKING_LEVELS[entry.thinking] ? entry.thinking : undefined,
			quota: quotaForModel(snapshot, model, state.config),
			billing: billingForProvider(host, model.provider),
		});
	}
	const notes: string[] = [];
	if (snapshot.error) notes.push(`quota stale: ${snapshot.error}`);
	if (unresolved > 0) notes.push(`${unresolved} configured model(s) not resolvable`);
	if (tooSmall > 0) notes.push(`${tooSmall} dropped: context window < ${needed} tokens`);
	if (dry > 0) notes.push(`${dry} dropped: provider marked out of credits`);
	if (out.length > 0 && out.every((candidate) => candidate.billing !== "plan")) {
		// No provider classified as a plan subscription means either every login
		// really is an API key, or the authStorage proxy is stripping the lookup
		// methods. The status line truncates, so dump the evidence to a file.
		const auth: object = host.modelRegistry.authStorage ?? {};
		const keys = [...new Set([...Object.keys(auth), ...Object.getOwnPropertyNames(Object.getPrototypeOf(auth) ?? {})])].filter((key) => key !== "constructor").sort();
		notes.push("billing diagnostic written to ~/.omp/jev-router-debug.json");
		try {
			writeFileSync(
				join(homedir(), ".omp", "jev-router-debug.json"),
				JSON.stringify(
					{
						at: new Date().toISOString(),
						authStorageKeys: keys,
						candidates: out.map((candidate) => ({
							model: `${candidate.model.provider}/${candidate.model.id}`,
							billing: candidate.billing,
							quotaStatus: candidate.quota.status,
							origin: host.modelRegistry.authStorage.getCredentialOrigin?.(candidate.model.provider) ?? null,
							storedType: host.modelRegistry.authStorage.get?.(candidate.model.provider)?.type ?? null,
						})),
						snapshotError: snapshot.error ?? null,
					},
					null,
					"\t",
				),
			);
		} catch {
			// Diagnostics must never break routing.
		}
	}
	return { candidates: out, note: notes.length > 0 ? notes.join("; ") : undefined };
}

function describe(triage: Triage, detail: string): string {
	return `jev · ${triage.tier} via ${triage.source} (${triage.confidence.toFixed(2)}) · ${detail}`;
}

/**
 * On the available path the reason string is constant boilerplate, so show the
 * two numbers that actually decided the pick instead: the tightest applicable
 * window's headroom, and pressure (headroom measured against time to reset).
 * Every other state keeps its explicit reason, which is the informative case.
 */
function quotaDetail(quota: Candidate["quota"]): string {
	if (quota.status !== "available") return quota.reason;
	const headroom = quota.remainingFraction === undefined ? "?" : `${Math.round(quota.remainingFraction * 100)}%`;
	const load = quota.pressure === undefined ? "?" : quota.pressure.toFixed(2);
	return `${headroom} left · pressure ${load}`;
}

async function routeMain(state: RouterState, pi: ExtensionAPI, ctx: ExtensionContext, prompt: string, hasImages: boolean): Promise<void> {
	const now = Date.now();
	let triage = await classify(prompt, hasImages, state.config, state.apiKey);
	triage = applyFloorHysteresis(triage, state.floorHysteresis, prompt, now);
	const { candidates, note } = await buildCandidates(state, ctx);
	const current = ctx.models.current();
	const decision = chooseCandidate(triage, candidates, current ? `${current.provider}/${current.id}` : undefined, state.config.credits);
	if (!decision.candidate) {
		state.lastMain = describe(triage, note ? `${decision.reason} · ${note}` : decision.reason);
		ctx.ui.setStatus("jev-router", state.lastMain);
		return;
	}
	const chosen = decision.candidate;
	const key = `${chosen.model.provider}/${chosen.model.id}`;
	if (!current || `${current.provider}/${current.id}` !== key) {
		const ok = await pi.setModel(chosen.model);
		if (!ok) {
			state.lastMain = describe(triage, `could not switch to ${key}`);
			ctx.ui.setStatus("jev-router", state.lastMain);
			return;
		}
	}
	if (chosen.thinking) pi.setThinkingLevel(chosen.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	// Update hysteresis only if we actually chose a strong/balanced model.
	state.floorHysteresis = updateFloorHysteresis(chosen.tier, now);
	state.lastMain = describe(triage, `${key} · ${quotaDetail(chosen.quota)}`);
	ctx.ui.setStatus("jev-router", state.lastMain);
}

/**
 * Task routing rewrites only the agent of items that left it unset, so an
 * explicitly pinned agent (nategpt workers, reviewers) is never overridden.
 */
async function routeTasks(state: RouterState, ctx: ExtensionContext, input: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
	const items = input.tasks;
	if (!Array.isArray(items) || items.length === 0) return undefined;
	const notes: string[] = [];
	const routed = await Promise.all(
		items.map(async (item) => {
			if (typeof item !== "object" || item === null) return item;
			const entry = item as Record<string, unknown>;
			if (typeof entry.agent === "string" && entry.agent.trim() && entry.agent !== "task") return item;
			if (typeof entry.task !== "string" || !entry.task.trim()) return item;
			const triage = await classify(entry.task, false, state.config, state.apiKey);
			const agent = state.config.taskAgents[triage.tier];
			if (!agent) {
				notes.push(`${triage.tier}: no agent configured`);
				return item;
			}
			notes.push(`${triage.tier} → ${agent}`);
			return { ...entry, agent };
		}),
	);
	if (notes.length === 0) return undefined;
	state.lastTasks = `jev: ${notes.join(", ")}`;
	ctx.ui.setStatus("jev-router", state.lastTasks);
	return { ...input, tasks: routed };
}

function summary(state: RouterState, ctx: ExtensionContext): string {
	const specs = specsFor(state, ctx);
	const source = state.config.candidates.length > 0 ? "config" : "catalogue";
	const tiers: Tier[] = ["quick", "balanced", "strong"];
	const byTier = tiers.map((tier) => `${tier}=${specs.filter((c) => c.tier === tier).length}`).join(" ");
	return [
		`main: ${state.main}`,
		`tasks: ${state.tasks}`,
		`credential: ${state.apiKey ? "loaded" : "missing"}`,
		`candidates (${source}): ${byTier}`,
		`last main: ${state.lastMain ?? "none"}`,
		`last tasks: ${state.lastTasks ?? "none"}`,
		`credits: ${state.config.credits}${state.config.credits === "on" ? ` (dry: ${dryProviders(state.credits, state.config.creditRecheckMs).join(", ") || "none"})` : ""}`,
	].join("\n");
}

export default function activate(pi: ExtensionAPI): void {
	const config = loadConfig();
	const state: RouterState = { config, main: config.main, tasks: config.tasks, apiKey: loadApiKey(), credits: loadCredits() };

	/**
	 * Credit-billed providers publish no usage window, so the only machine-readable
	 * evidence that a balance is gone is the provider's own refusal. 402 (and the
	 * "insufficient balance" family) marks the provider dry for `creditRecheckMs`;
	 * ordinary rate limits and transport errors are left alone.
	 */
	pi.on("after_provider_response", (event, ctx) => {
		if (state.config.credits !== "on") return;
		const body = typeof event.metadata?.error === "string" ? event.metadata.error : undefined;
		if (!isOutOfCredit(event.status, body)) return;
		const model = ctx.models.current();
		if (!model) return;
		if (isDry(state.credits, model.provider, state.config.creditRecheckMs)) return;
		state.credits = markDry(state.credits, model.provider, `HTTP ${event.status} from ${model.provider}`);
		ctx.ui.notify(`jev: ${model.provider} marked out of credits (HTTP ${event.status}); retrying it after ${Math.round(state.config.creditRecheckMs / 60_000)} min`, "warning");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (state.main !== "auto") return;
		try {
			await routeMain(state, pi, ctx, event.prompt, (event.images?.length ?? 0) > 0);
		} catch {
			// Routing is advisory: a failure must never block the user's turn.
			state.lastMain = "jev: routing failed, kept the current model";
			ctx.ui.setStatus("jev-router", state.lastMain);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (state.tasks !== "auto" || event.toolName !== "task") return;
		try {
			const input = await routeTasks(state, ctx, event.input);
			return input ? { input } : undefined;
		} catch {
			return undefined;
		}
	});

	pi.registerCommand("jev", {
		description: "Jev router: `on`, `off`, `main auto|off`, `tasks auto|off`, `credits <provider> dry|topped`, `reload`, or no argument for status",
		getArgumentCompletions: (prefix) =>
			["on", "off", "main auto", "main off", "tasks auto", "tasks off", "credits", "reload"]
				.filter((option) => option.startsWith(prefix))
				.map((option) => ({ value: option, label: option })),
		handler: async (args, ctx) => {
			const [target, value, third] = args.trim().split(/\s+/);
			if (!target) {
				ctx.ui.notify(summary(state, ctx));
				return;
			}
			if (target === "reload") {
				state.config = loadConfig();
				state.apiKey = loadApiKey();
				state.credits = loadCredits();
				state.main = state.config.main;
				state.tasks = state.config.tasks;
			state.floorHysteresis = undefined;
				ctx.ui.notify(`Reloaded.\n${summary(state, ctx)}`);
				return;
			}
			if (target === "credits") {
				if (!value || (third !== "dry" && third !== "topped")) {
					ctx.ui.notify("Usage: /jev credits <provider> dry|topped", "warning");
					return;
				}
				state.credits =
					third === "dry"
						? markDry(state.credits, value, "marked by the user")
						: markTopped(state.credits, value);
				ctx.ui.notify(`jev: ${value} marked ${third}.\n${summary(state, ctx)}`);
				return;
			}
			if (target === "on" || target === "off") {
				state.main = target === "on" ? "auto" : "off";
				state.tasks = state.main;
			} else if ((target === "main" || target === "tasks") && (value === "auto" || value === "off")) {
				state[target] = value;
			} else {
				ctx.ui.notify("Usage: /jev [on|off] [main|tasks auto|off] [credits <provider> dry|topped] [reload]", "warning");
				return;
			}
			// Persist, so a toggle survives a restart rather than reverting to the file.
			saveModes(state.main, state.tasks);
			ctx.ui.setStatus("jev-router", `jev: main ${state.main}, tasks ${state.tasks}`);
			ctx.ui.notify(summary(state, ctx));
		},
	});
}
