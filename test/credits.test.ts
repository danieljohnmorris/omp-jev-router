import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CreditMarks, dryProviders, isDry, isOutOfCredit, loadCredits, markDry, markTopped } from "../src/credits";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

function tempPath(): string {
	return join(mkdtempSync(join(tmpdir(), "jev-credits-")), "credits.json");
}

describe("credit marks", () => {
	it("round-trips a mark through the file so it survives a restart", () => {
		const path = tempPath();
		markDry({}, "deepseek", "HTTP 402", NOW, path);
		expect(loadCredits(path).deepseek).toEqual({ state: "dry", at: NOW, reason: "HTTP 402" });
	});

	it("stops holding a provider out once the mark is older than the recheck window", () => {
		const marks = markDry({}, "deepseek", "HTTP 402", NOW, tempPath());
		expect(isDry(marks, "deepseek", 6 * HOUR, NOW + HOUR)).toBe(true);
		expect(isDry(marks, "deepseek", 6 * HOUR, NOW + 7 * HOUR)).toBe(false);
		expect(dryProviders(marks, 6 * HOUR, NOW + 7 * HOUR)).toEqual([]);
	});

	it("clears a mark on top-up, and persists the clearing", () => {
		const path = tempPath();
		const marks = markDry({}, "zai", "HTTP 402", NOW, path);
		expect(markTopped(marks, "zai", path).zai).toBeUndefined();
		expect(loadCredits(path).zai).toBeUndefined();
	});

	it("ignores malformed entries rather than trusting them", () => {
		const path = tempPath();
		markDry({}, "ok", "r", NOW, path);
		const junk = { ...loadCredits(path), bad: { state: "maybe" }, worse: null } as unknown as CreditMarks;
		expect(Object.keys(junk).length).toBe(3);
		expect(Object.keys(loadCredits(path))).toEqual(["ok"]);
	});
});

describe("isOutOfCredit", () => {
	it("treats 402 as a spent balance", () => {
		expect(isOutOfCredit(402)).toBe(true);
	});

	it("does not treat a plain rate limit or server error as a spent balance", () => {
		expect(isOutOfCredit(429, "rate limit exceeded, retry in 20s")).toBe(false);
		expect(isOutOfCredit(500, "internal error")).toBe(false);
		expect(isOutOfCredit(401, "invalid api key")).toBe(false);
	});

	it("recognises the insufficient-balance family on ambiguous statuses", () => {
		expect(isOutOfCredit(400, "Insufficient Balance")).toBe(true);
		expect(isOutOfCredit(429, "You exceeded your current quota, please check your plan and billing")).toBe(true);
		expect(isOutOfCredit(403, "insufficient_credit for this organization")).toBe(true);
	});
});
