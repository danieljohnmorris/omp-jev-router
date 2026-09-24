import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "omp-jev-router";

/**
 * Resolve the TypeSafe/Jev API key. Environment first (CI, containers), then
 * the macOS Keychain, so the key never has to sit in a config file.
 */
export function loadApiKey(account = process.env.USER ?? "default"): string | undefined {
	const fromEnv = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
	if (fromEnv?.trim()) return fromEnv.trim();
	if (process.platform !== "darwin") return undefined;
	try {
		const value = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return value.trim() || undefined;
	} catch {
		return undefined;
	}
}
