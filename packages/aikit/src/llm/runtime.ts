/** Where a provider's API key may come from: its catalog `key` and `env` variable names. */
export type ApiKeyProvider = {
	env?: string[];
	key?: string;
};

export function mergeHeaders(
	...headerSources: (Record<string, string | null> | undefined)[]
): Record<string, string | null> {
	const merged: Record<string, string | null> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

/** The provider's API key from the environment, checking its `key` then each `env` name. */
export function getEnvApiKey(provider: ApiKeyProvider): string | undefined {
	if (typeof process === "undefined") return;

	const candidates = [provider.key, ...(provider.env ?? [])].filter((name): name is string => Boolean(name));
	for (const name of candidates) {
		const value = process.env[name];
		if (value) return value;
	}
}

export function formatThrownError(error: unknown): string {
	if (error instanceof Error) {
		return error.stack || error.message || error.name;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
