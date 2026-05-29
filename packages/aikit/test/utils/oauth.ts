import { homedir } from "os";
import { readFileSync } from "fs";
import { join } from "path";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveOpenAICodexToken(): string | undefined {
	const authPath = join(homedir(), ".codework", "aikit", "auth.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		return undefined;
	}

	const credentials = findOpenAICodexCredentials(parsed);
	return credentials?.access;
}

function findOpenAICodexCredentials(value: unknown): { access: string } | undefined {
	if (!isObject(value)) return undefined;
	if (typeof value.access === "string") return { access: value.access };

	const direct = value["openai-codex"];
	if (isObject(direct) && typeof direct.access === "string") {
		return { access: direct.access };
	}

	const providers = value.providers;
	if (isObject(providers)) {
		const provider = providers["openai-codex"];
		if (isObject(provider) && typeof provider.access === "string") {
			return { access: provider.access };
		}
	}
}
