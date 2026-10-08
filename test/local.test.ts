import type { Model } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "bun:test";
import { endpointLive, isLocalProvider, localQuota, localSpecs, preferLocal } from "../src/local";
import type { Candidate, Tier } from "../src/types";

const PROVIDER = "sparks";
const TIERS: Record<string, Tier> = { "GLM-5.3-Flash-EXL3": "balanced", "Qwen3.8-Flash-Next": "quick" };

const model = (provider: string, id: string): Model => ({ provider, id, contextWindow: 262_144, input: ["text"] }) as unknown as Model;

function candidate(provider: string, id: string, tier: Tier): Candidate {
	return { model: model(provider, id), tier, quota: { status: "available", reason: "test", windows: [] }, billing: "plan" };
}

describe("isLocalProvider", () => {
	it("matches the aggregated provider and its per-head discovery providers", () => {
		expect(isLocalProvider("sparks", PROVIDER)).toBe(true);
		expect(isLocalProvider("sparks-live-spark1", PROVIDER)).toBe(true);
		expect(isLocalProvider("sparks-live-spark3", PROVIDER)).toBe(true);
	});

	it("does not match a hosted provider that merely starts the same way", () => {
		expect(isLocalProvider("anthropic", PROVIDER)).toBe(false);
		expect(isLocalProvider("sparksomething", PROVIDER)).toBe(false);
	});
});

describe("localSpecs", () => {
	it("takes only the ids the tier map declares, in catalogue order", () => {
		const specs = localSpecs(
			[model("sparks", "Qwen3.8-Flash-Next"), model("sparks", "GLM-5.3-EXL3"), model("sparks", "GLM-5.3-Flash-EXL3")],
			PROVIDER,
			TIERS,
		);
		expect(specs).toEqual([
			{ model: "sparks/Qwen3.8-Flash-Next", tier: "quick" },
			{ model: "sparks/GLM-5.3-Flash-EXL3", tier: "balanced" },
		]);
	});

	it("ignores the per-head discovery providers, whose node lists ids it may not serve", () => {
		const specs = localSpecs([model("sparks-live-spark1", "GLM-5.3-Flash-EXL3"), model("sparks-live-spark1", "Qwen3.8-Flash-Next")], PROVIDER, TIERS);
		expect(specs).toEqual([]);
	});
});

describe("localQuota", () => {
	it("reports full headroom with no pressure, so no metered provider can outrank it", () => {
		const quota = localQuota(1_700_000_000_000);
		expect(quota.status).toBe("available");
		expect(quota.remainingFraction).toBe(1);
		expect(quota.pressure).toBe(0);
	});
});

describe("preferLocal", () => {
	it("keeps the cloud models above the local ceiling and releases the ones it can answer", () => {
		const { candidates, released } = preferLocal(
			[candidate("sparks", "GLM-5.3-Flash-EXL3", "balanced"), candidate("deepseek", "deepseek-flash", "quick"), candidate("anthropic", "opus", "strong")],
			PROVIDER,
		);
		expect(candidates.map((entry) => entry.model.id)).toEqual(["GLM-5.3-Flash-EXL3", "opus"]);
		expect(released).toBe(1);
	});

	it("releases the cloud option at a quick ceiling, keeping every floor above it", () => {
		const { candidates, released } = preferLocal(
			[candidate("sparks", "Qwen3.8-Flash-Next", "quick"), candidate("deepseek", "deepseek-flash", "quick"), candidate("zai", "glm-5.3", "balanced"), candidate("anthropic", "opus", "strong")],
			PROVIDER,
		);
		expect(candidates.map((entry) => entry.model.id)).toEqual(["Qwen3.8-Flash-Next", "glm-5.3", "opus"]);
		expect(released).toBe(1);
	});

	it("is a no-op when no local candidate survived the liveness probe", () => {
		const cloud = [candidate("anthropic", "opus", "strong"), candidate("deepseek", "deepseek-flash", "quick")];
		const { candidates, released } = preferLocal(cloud, PROVIDER);
		expect(candidates).toEqual(cloud);
		expect(released).toBe(0);
	});
});

describe("endpointLive", () => {
	const serving = (ids: string[]) =>
		Bun.serve({ port: 0, fetch: () => Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }) });

	it("is true only for an id the endpoint actually serves", async () => {
		// One head, several configured ids, one recipe up: the whole point of the
		// id check. A reachable endpoint serving a different model must not pass.
		const server = serving(["GLM-5.3-Flash-EXL3"]);
		const baseUrl = `http://127.0.0.1:${server.port}/v1`;

		expect(await endpointLive(baseUrl, "GLM-5.3-Flash-EXL3", 5_000, 2_000)).toBe(true);
		expect(await endpointLive(baseUrl, "deepseek-v4-flash-vision-exp", 5_000, 2_000)).toBe(false);

		await server.stop(true);
	});

	it("is true for an endpoint whose /models body is not a shape it knows", async () => {
		// A dialect this code cannot read must not blackhole every local candidate;
		// it falls back to "the endpoint answered".
		const server = Bun.serve({ port: 0, fetch: () => new Response("<html>models</html>", { headers: { "content-type": "text/html" } }) });
		expect(await endpointLive(`http://127.0.0.1:${server.port}/v1`, "anything", 5_000, 2_000)).toBe(true);
		await server.stop(true);
	});

	it("is false once the endpoint stops, and cached within the ttl", async () => {
		const server = serving(["GLM-5.3-Flash-EXL3"]);
		const baseUrl = `http://127.0.0.1:${server.port}/v1`;

		expect(await endpointLive(baseUrl, "GLM-5.3-Flash-EXL3", 5_000, 2_000)).toBe(true);
		await server.stop(true);
		// Probe is cached, so a stopped endpoint still reads live inside the ttl:
		// that is what keeps routing from paying a round trip every turn.
		expect(await endpointLive(baseUrl, "GLM-5.3-Flash-EXL3", 5_000, 2_000)).toBe(true);
		// With no ttl the probe is repeated, and now sees the stopped server.
		expect(await endpointLive(baseUrl, "GLM-5.3-Flash-EXL3", 0, 2_000)).toBe(false);
	});

	it("is false, not a throw, for an endpoint that refuses the connection", async () => {
		expect(await endpointLive("http://127.0.0.1:1/v1", "GLM-5.3-Flash-EXL3", 0, 2_000)).toBe(false);
	});
});
