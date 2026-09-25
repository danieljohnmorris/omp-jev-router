import { describe, expect, it } from "bun:test";
import { applyFloorHysteresis, isContinuation, updateFloorHysteresis } from "../src/hysteresis";
import type { Triage } from "../src/types";

function triage(tier: "quick" | "balanced" | "strong"): Triage {
	return { tier, confidence: 0.9, source: "jev", reason: "test" };
}

describe("isContinuation", () => {
	it("matches affirmations", () => {
		expect(isContinuation("yes")).toBe(true);
		expect(isContinuation("yep")).toBe(true);
		expect(isContinuation("ok")).toBe(true);
		expect(isContinuation("okay")).toBe(true);
		expect(isContinuation("sure")).toBe(true);
	});

	it("matches actions", () => {
		expect(isContinuation("go ahead")).toBe(true);
		expect(isContinuation("proceed")).toBe(true);
		expect(isContinuation("continue")).toBe(true);
		expect(isContinuation("do it")).toBe(true);
		expect(isContinuation("let's do it")).toBe(true);
	});

	it("rejects complex prompts", () => {
		expect(isContinuation("write a script")).toBe(false);
		expect(isContinuation("what does this mean")).toBe(false);
		expect(isContinuation("yes but with more detail")).toBe(false);
	});

	it("ignores whitespace", () => {
		expect(isContinuation("  yes  ")).toBe(true);
		expect(isContinuation("\tok\t")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isContinuation("YES")).toBe(true);
		expect(isContinuation("Ok")).toBe(true);
	});
});

describe("applyFloorHysteresis", () => {
	const now = Date.now();
	const recentFloor = { tier: "strong" as const, at: now - 10_000 }; // 10s old
	const expiredFloor = { tier: "strong" as const, at: now - 31 * 60_000 }; // past the 30min window

	it("preserves the original triage when no hysteresis is set", () => {
		const original = triage("quick");
		const result = applyFloorHysteresis(original, undefined, "yes", now);
		expect(result).toEqual(original);
	});

	it("preserves the original triage when prompt is not a continuation", () => {
		const original = triage("quick");
		const result = applyFloorHysteresis(original, recentFloor, "write a feature", now);
		expect(result).toEqual(original);
	});

	it("drops the floor once the idle window has passed", () => {
		const original = triage("quick");
		const result = applyFloorHysteresis(original, expiredFloor, "yes", now);
		expect(result).toEqual(original);
	});

	it("raises the tier to the hysteresis floor on continuation", () => {
		const original = triage("quick");
		const result = applyFloorHysteresis(original, recentFloor, "yes", now);
		expect(result.tier).toBe("strong");
		expect(result.reason).toContain("inherited floor");
	});

	it("doesn't raise tier if already at or above floor", () => {
		const original = triage("strong");
		const result = applyFloorHysteresis(original, { tier: "balanced", at: now - 10_000 }, "yes", now);
		expect(result.tier).toBe("strong");
		expect(result.reason).toBe("test"); // unchanged
	});

	it("raises balanced to strong", () => {
		const original = triage("balanced");
		const result = applyFloorHysteresis(original, recentFloor, "yes", now);
		expect(result.tier).toBe("strong");
	});

	it("doesn't change quick→balanced on continuation", () => {
		const original = triage("quick");
		const result = applyFloorHysteresis(original, { tier: "balanced", at: now - 10_000 }, "yes", now);
		expect(result.tier).toBe("balanced");
		expect(result.reason).toContain("inherited floor");
	});
});

describe("updateFloorHysteresis", () => {
	const now = Date.now();

	it("records strong tier", () => {
		const result = updateFloorHysteresis("strong", now);
		expect(result).toEqual({ tier: "strong", at: now });
	});

	it("records balanced tier", () => {
		const result = updateFloorHysteresis("balanced", now);
		expect(result).toEqual({ tier: "balanced", at: now });
	});

	it("does not record quick tier", () => {
		const result = updateFloorHysteresis("quick", now);
		expect(result).toBeUndefined();
	});
});
