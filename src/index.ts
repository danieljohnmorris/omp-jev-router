import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { catalogueCandidates } from "./catalogue";
import { loadConfig } from "./config";
import { loadApiKey } from "./credentials";
import { getQuotaSnapshot, type QuotaHost, quotaForModel } from "./quota";
import { chooseCandidate, classify } from "./router";
import type { Candidate, CandidateSpec, RouterConfig, RoutingMode, Tier, Triage } from "./types";

const THINKING_LEVELS: Record<string, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };

interface RouterState {
	config: RouterConfig;
	main: RoutingMode;
	tasks: RoutingMode;
	apiKey?: string;
	lastMain?: string;
	lastTasks?: string;
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
async function buildCandidates(state: RouterState, ctx: ExtensionContext): Promise<Candidate[]> {
	const snapshot = await getQuotaSnapshot(ctx as unknown as QuotaHost, state.config);
	const used = ctx.getContextUsage()?.tokens ?? 0;
	const needed = used + state.config.contextReserveTokens;
	const out: Candidate[] = [];
	for (const entry of specsFor(state, ctx)) {
		const model = ctx.models.resolve(entry.model);
		if (!model) continue;
		if (typeof model.contextWindow === "number" && model.contextWindow < needed) continue;
		out.push({
			model,
			tier: entry.tier,
			thinking: entry.thinking && THINKING_LEVELS[entry.thinking] ? entry.thinking : undefined,
			quota: quotaForModel(snapshot, model, state.config),
		});
	}
	return out;
}

function describe(triage: Triage, detail: string): string {
	return `jev: ${triage.tier} (${triage.source}, ${triage.confidence.toFixed(2)}) · ${detail}`;
}

async function routeMain(state: RouterState, pi: ExtensionAPI, ctx: ExtensionContext, prompt: string, hasImages: boolean): Promise<void> {
	const triage = await classify(prompt, hasImages, state.config, state.apiKey);
	const candidates = await buildCandidates(state, ctx);
	const current = ctx.models.current();
	const decision = chooseCandidate(triage, candidates, current ? `${current.provider}/${current.id}` : undefined);
	if (!decision.candidate) {
		state.lastMain = describe(triage, decision.reason);
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
	state.lastMain = describe(triage, `${key} · ${chosen.quota.reason}`);
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
	].join("\n");
}

export default function activate(pi: ExtensionAPI): void {
	const config = loadConfig();
	const state: RouterState = { config, main: config.main, tasks: config.tasks, apiKey: loadApiKey() };

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
		description: "Jev router: status, or `main auto|off`, `tasks auto|off`, `reload`",
		handler: async (args, ctx) => {
			const [target, value] = args.trim().split(/\s+/);
			if (!target) {
				ctx.ui.notify(summary(state, ctx));
				return;
			}
			if (target === "reload") {
				state.config = loadConfig();
				state.apiKey = loadApiKey();
				state.main = state.config.main;
				state.tasks = state.config.tasks;
				ctx.ui.notify(`Reloaded.\n${summary(state, ctx)}`);
				return;
			}
			if ((target !== "main" && target !== "tasks") || (value !== "auto" && value !== "off")) {
				ctx.ui.notify("Usage: /jev [main|tasks auto|off] [reload]", "warning");
				return;
			}
			state[target] = value;
			ctx.ui.setStatus("jev-router", `jev: main ${state.main}, tasks ${state.tasks}`);
			ctx.ui.notify(summary(state, ctx));
		},
	});
}
