/* @effect-diagnostics globalDate:off nodeBuiltinImport:off -- module setup for live suites, outside any Effect. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import "./env.ts";

/**
 * The Codex login's current access token, for `OPENAI_CODEX_API_KEY`. The login file itself is
 * never used by a test: a refresh would rotate the refresh token and sign the developer out. An
 * expired token skips the Codex cases rather than refreshing.
 */
const codexToken = (): string | undefined => {
	try {
		const login = JSON.parse(readFileSync(join(homedir(), ".codework", "aikit", "auth.json"), "utf8"))[
			"openai-codex"
		];
		return typeof login?.access === "string" && login.expires > Date.now() + 10 * 60_000 ? login.access : undefined;
	} catch {
		return undefined;
	}
};
const codex = process.env.OPENAI_CODEX_API_KEY ?? codexToken();
if (codex !== undefined) process.env.OPENAI_CODEX_API_KEY = codex;

/** Every live case runs against each of these; `env` names the key that enables it. */
export const LIVE = [
	{ name: "openai", provider: "openai", id: "gpt-5.6-luna", env: "OPENAI_API_KEY" },
	{ name: "openai-codex", provider: "openai-codex", id: "gpt-5.6-luna", env: "OPENAI_CODEX_API_KEY" },
	{ name: "anthropic", provider: "anthropic", id: "claude-sonnet-5-5", env: "ANTHROPIC_API_KEY" },
	{ name: "deepseek", provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", env: "OPENROUTER_API_KEY" },
	{ name: "gemini", provider: "openrouter", id: "google/gemini-3.8-flash", env: "OPENROUTER_API_KEY" },
	{ name: "muse", provider: "openrouter", id: "meta/muse-spark-1.3-contributor", env: "OPENROUTER_API_KEY" },
] as const;
export type Live = (typeof LIVE)[number];

/** Whether a live case's key is set. */
export const available = (live: Live): boolean => Boolean(process.env[live.env]?.trim());

/** OpenAI's own request options (`reasoningSummary`, `reasoningEffort`) apply only to these. */
export const openaiFamily = (live: Live): boolean => live.provider === "openai" || live.provider === "openai-codex";
