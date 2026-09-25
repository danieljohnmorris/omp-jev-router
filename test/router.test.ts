import type { Model } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "bun:test";
import { chooseCandidate } from "../src/router";
import type { Candidate, Tier, Triage } from "../src/types";

function candidate(id: string, tier: Tier, remaining: number | undefined, status: Candidate["quota"]["status"] = "available", input: string[] = ["text"]): Candidate {
	return {
		model: { provider: "p", id, contextWindow: 200_000, input } as unknown as Model,
		tier,
		quota: { status, reason: "test", remainingFraction: remaining, pressure: remaining === undefined ? undefined : 1 / remaining, windows: [] },
	};
}

const triage = (tier: Tier, source: Triage["source"] = "jev"): Triage => ({ tier, confidence: 0.9, source, reason: "test" });

describe("chooseCandidate", () => {
	it("never selects below the tier Jev asked for", () => {
		const decision = chooseCandidate(triage("strong"), [candidate("cheap", "quick", 0.9), candidate("big", "strong", 0.2)]);
		expect(decision.candidate?.model.id).toBe("big");
	});

	it("falls back to the strong floor when classification failed", () => {
		const decision = chooseCandidate({ tier: "quick", confidence: 0, source: "fallback", reason: "x" }, [
			candidate("cheap", "quick", 0.9),
			candidate("big", "strong", 0.9),
		]);
		expect(decision.candidate?.model.id).toBe("big");
	});

	it("uses the argmax tier as the floor when confidence is merely low, not forced strong", () => {
		const decision = chooseCandidate(triage("quick", "jev-low-confidence"), [
			candidate("cheap", "quick", 0.9),
			candidate("big", "strong", 0.9),
		]);
		expect(decision.candidate?.model.id).toBe("cheap");
	});

	it("prefers a model with measured headroom over exhausted and unknown-quota models", () => {
		const decision = chooseCandidate(triage("quick"), [
			candidate("spent", "quick", 0, "exhausted"),
			candidate("murky", "quick", undefined, "unknown"),
			candidate("ok", "balanced", 0.5),
		]);
		expect(decision.candidate?.model.id).toBe("ok");
	});

	it("selects the cheapest model at the floor when no candidate has readable quota", () => {
		const decision = chooseCandidate(triage("quick"), [
			candidate("strongish", "strong", undefined, "unknown"),
			candidate("cheap", "quick", undefined, "unknown"),
		]);
		expect(decision.candidate?.model.id).toBe("cheap");
	});

	it("stands down instead of spending an unmeasurable balance when credits routing is off", () => {
		const blind = [candidate("strongish", "strong", undefined, "unknown"), candidate("cheap", "quick", undefined, "unknown")];
		expect(chooseCandidate(triage("quick"), blind, undefined, "off").candidate).toBeUndefined();
		expect(chooseCandidate(triage("quick"), blind, undefined, "on").candidate?.model.id).toBe("cheap");
	});

	it("still uses measured plan headroom when credits routing is off", () => {
		const decision = chooseCandidate(triage("quick"), [candidate("ok", "quick", 0.5), candidate("blind", "quick", undefined, "unknown")], undefined, "off");
		expect(decision.candidate?.model.id).toBe("ok");
	});

	it("never selects an exhausted model, even when no other candidate has readable quota", () => {
		const decision = chooseCandidate(triage("quick"), [candidate("spent", "quick", 0, "exhausted")]);
		expect(decision.candidate).toBeUndefined();
	});

	it("requires image input when the prompt carries images", () => {
		const decision = chooseCandidate(triage("quick", "image"), [
			candidate("textonly", "strong", 0.9),
			candidate("vision", "strong", 0.3, "available", ["text", "image"]),
		]);
		expect(decision.candidate?.model.id).toBe("vision");
	});

	it("keeps the current model when headroom is comparable", () => {
		const decision = chooseCandidate(triage("quick"), [candidate("a", "quick", 0.8), candidate("b", "quick", 0.82)], "p/a");
		expect(decision.candidate?.model.id).toBe("a");
	});

	it("moves off the current model when it is exhausted", () => {
		const decision = chooseCandidate(triage("quick"), [candidate("a", "quick", 0, "exhausted"), candidate("b", "quick", 0.5)], "p/a");
		expect(decision.candidate?.model.id).toBe("b");
	});
});
