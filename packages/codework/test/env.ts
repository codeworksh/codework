/* @effect-diagnostics nodeBuiltinImport:off -- test setup reads local credential files. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env.local", import.meta.url));

if (existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

/**
 * The Codex login's current access token, for `OPENAI_CODEX_API_KEY`. The login file itself is
 * never copied into a test home: a refresh there would rotate the refresh token and sign the
 * developer out. An expired token skips the Codex cases rather than refreshing.
 */
const codexToken = (): string | undefined => {
	try {
		const login = JSON.parse(readFileSync(join(homedir(), ".codework", "aikit", "auth.json"), "utf8"))[
			"openai-codex"
		];
		// @effect-diagnostics-next-line globalDate:off -- module setup, outside any Effect.
		return typeof login?.access === "string" && login.expires > Date.now() + 10 * 60_000 ? login.access : undefined;
	} catch {
		return undefined;
	}
};
const codex = process.env.OPENAI_CODEX_API_KEY ?? codexToken();
if (codex !== undefined) process.env.OPENAI_CODEX_API_KEY = codex;
