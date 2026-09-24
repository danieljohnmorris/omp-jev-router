import type { Model } from "@oh-my-pi/pi-ai";
import { describe, expect, test } from "bun:test";
import { catalogueCandidates, tierFor } from "../src/catalogue";

function model(provider: string, id: string, output: number, extra: Partial<Model> = {}): Model {
	return {
		provider,
		id,
		name: id,
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: true,
		input: ["text"],
		cost: { input: output / 4, output, cacheRead: 0, cacheWrite: 0 },
		...extra,
	} as unknown as Model;
}

describe("tierFor", () => {
	test("bands by output price", () => {
		expect(tierFor(0.5)).toBe("quick");
		expect(tierFor(2)).toBe("quick");
		expect(tierFor(4)).toBe("balanced");
		expect(tierFor(15)).toBe("balanced");
		expect(tierFor(75)).toBe("strong");
	});
});

describe("catalogueCandidates", () => {
	test("prefers the wider context window over a pricier retired generation", () => {
		const specs = catalogueCandidates(
			[
				model("anthropic", "retired-opus", 75, { contextWindow: 200_000 }),
				model("anthropic", "current-opus", 60, { contextWindow: 1_000_000 }),
			],
			3,
		);
		expect(specs).toEqual([{ model: "anthropic/current-opus", tier: "strong" }]);
	});

	test("keeps one model per provider per tier", () => {
		const specs = catalogueCandidates(
			[
				model("anthropic", "cheap-opus", 60),
				model("anthropic", "dear-opus", 75),
				model("zai", "glm", 20),
			],
			3,
		);
		expect(specs).toEqual([
			{ model: "anthropic/dear-opus", tier: "strong" },
			{ model: "zai/glm", tier: "strong" },
		]);
	});

	test("caps each tier at perTier providers", () => {
		const specs = catalogueCandidates(
			["a", "b", "c", "d"].map((p) => model(p, `${p}-model`, 1, { reasoning: false })),
			2,
		);
		expect(specs).toHaveLength(2);
	});

	test("drops dated snapshots, batch routes, image-only and non-reasoning models above quick", () => {
		const specs = catalogueCandidates(
			[
				model("anthropic", "claude-opus-20251101", 75),
				model("openrouter", "openai/gpt-pro:batch", 80),
				model("zai", "vision", 40, { input: ["image"] }),
				model("deepseek", "chat", 40, { reasoning: false }),
			],
			5,
		);
		expect(specs).toEqual([]);
	});

	test("skips models with no published price", () => {
		expect(catalogueCandidates([model("local", "free", 0, { cost: undefined })], 3)).toEqual([]);
	});
});
