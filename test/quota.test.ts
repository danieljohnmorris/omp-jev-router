import type { Model, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { quotaForModel } from "../src/quota";
import type { QuotaSnapshot } from "../src/types";

const NOW = 1_800_000_000_000;

const model = { provider: "zai", id: "glm-5" } as unknown as Model;

function limit(windowId: string, usedFraction: number, extra?: Partial<UsageLimit>): UsageLimit {
	return {
		id: `zai:${windowId}`,
		scope: { provider: "zai", windowId },
		window: { id: windowId, label: windowId, durationMs: 18_000_000, resetsAt: NOW + 3_600_000 },
		amount: { used: usedFraction * 100, limit: 100, unit: "credits" },
		status: "ok",
		...extra,
	} as UsageLimit;
}

function report(limits: UsageLimit[], accountId = "a"): UsageReport {
	return { provider: "zai", fetchedAt: NOW - 1_000, limits, metadata: { accountId } } as unknown as UsageReport;
}

function snapshot(reports: UsageReport[]): QuotaSnapshot {
	return { reports, checkedAt: NOW };
}

describe("quotaForModel", () => {
	it("marks the account exhausted when any single window is spent", () => {
		const state = quotaForModel(snapshot([report([limit("5h", 0.01), limit("7d", 1)])]), model, DEFAULT_CONFIG, NOW);
		expect(state.status).toBe("exhausted");
	});

	it("keeps the provider available when one of several accounts has headroom", () => {
		const state = quotaForModel(
			snapshot([report([limit("7d", 1)], "a"), report([limit("7d", 0.2)], "b")]),
			model,
			DEFAULT_CONFIG,
			NOW,
		);
		expect(state.status).toBe("available");
		expect(state.remainingFraction).toBeCloseTo(0.8);
	});

	it("does not treat an unreadable window as headroom", () => {
		const broken = { ...limit("7d", 0), amount: { unit: "credits" } } as unknown as UsageLimit;
		expect(quotaForModel(snapshot([report([broken])]), model, DEFAULT_CONFIG, NOW).status).toBe("unknown");
	});

	it("does not assume zero usage after a window resets past the snapshot", () => {
		const reset = limit("5h", 0.1, { window: { id: "5h", label: "5h", durationMs: 18_000_000, resetsAt: NOW - 1 } });
		expect(quotaForModel(snapshot([report([reset])]), model, DEFAULT_CONFIG, NOW).status).toBe("unknown");
	});

	it("reports stale rather than available when the snapshot is too old", () => {
		const old = { ...report([limit("7d", 0.1)]), fetchedAt: NOW - DEFAULT_CONFIG.quotaMaxAgeMs - 1 } as UsageReport;
		expect(quotaForModel(snapshot([old]), model, DEFAULT_CONFIG, NOW).status).toBe("stale");
	});

	it("ignores limits scoped to a different model", () => {
		const other = limit("7d", 1, { scope: { provider: "zai", windowId: "7d", modelId: "glm-4.6" } });
		expect(quotaForModel(snapshot([report([other])]), model, DEFAULT_CONFIG, NOW).status).toBe("unknown");
	});

	it("reports unknown for a provider with no usage report", () => {
		expect(quotaForModel(snapshot([]), model, DEFAULT_CONFIG, NOW).status).toBe("unknown");
	});
});
