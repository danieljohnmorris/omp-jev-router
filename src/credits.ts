import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CREDITS_PATH = join(homedir(), ".omp", "jev-router-credits.json");

/**
 * Credit-billed providers report no usage windows, so the only evidence that a
 * balance ran out is a 402 from the provider or the user saying so. A mark is
 * therefore a memory, not a measurement, and it expires: an entry older than
 * `recheckMs` lets the provider back into candidacy on its own, so a forgotten
 * mark can never permanently disable a provider the user has since topped up.
 */
export interface CreditMark {
	state: "dry";
	at: number;
	reason: string;
}

export type CreditMarks = Record<string, CreditMark>;

function parse(raw: unknown): CreditMarks {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const out: CreditMarks = {};
	for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) continue;
		const mark = value as Record<string, unknown>;
		if (mark.state !== "dry" || typeof mark.at !== "number" || !Number.isFinite(mark.at)) continue;
		out[provider] = { state: "dry", at: mark.at, reason: typeof mark.reason === "string" ? mark.reason : "marked dry" };
	}
	return out;
}

/** Read the marks file. Missing or malformed content means "nothing is known to be dry". */
export function loadCredits(path = CREDITS_PATH): CreditMarks {
	try {
		return parse(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

function save(marks: CreditMarks, path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(marks, null, "\t")}\n`);
}

/** Record that a provider has no credits left. Persisted, so the mark survives a restart. */
export function markDry(marks: CreditMarks, provider: string, reason: string, now = Date.now(), path = CREDITS_PATH): CreditMarks {
	const next: CreditMarks = { ...marks, [provider]: { state: "dry", at: now, reason } };
	save(next, path);
	return next;
}

/** Clear a provider's mark after a top-up. */
export function markTopped(marks: CreditMarks, provider: string, path = CREDITS_PATH): CreditMarks {
	const next: CreditMarks = { ...marks };
	delete next[provider];
	save(next, path);
	return next;
}

/** A mark counts only while it is fresh; past `recheckMs` the provider is retried. */
export function isDry(marks: CreditMarks, provider: string, recheckMs: number, now = Date.now()): boolean {
	const mark = marks[provider];
	return mark !== undefined && now - mark.at < recheckMs;
}

/** Providers currently held out, for the status line and `/jev` summary. */
export function dryProviders(marks: CreditMarks, recheckMs: number, now = Date.now()): string[] {
	return Object.keys(marks)
		.filter((provider) => isDry(marks, provider, recheckMs, now))
		.sort();
}

/** True when a provider response means "your balance is gone", not "this request failed". */
export function isOutOfCredit(status: number, body?: string): boolean {
	if (status === 402) return true;
	if (status !== 400 && status !== 403 && status !== 429) return false;
	return /insufficient[\s_-]*(balance|credit|quota|funds)|out of credits|billing.*(hard limit|not active)|exceeded your current quota/i.test(body ?? "");
}
