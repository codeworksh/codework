type ApiKeyProvider = {
	env?: string[];
	key?: string;
};

export function getEnvApiKey(provider: ApiKeyProvider): string | undefined {
	if (typeof process === "undefined") return;

	const candidates = [provider.key, ...(provider.env ?? [])].filter((name): name is string => Boolean(name));
	for (const name of candidates) {
		const value = process.env[name];
		if (value) return value;
	}
}
