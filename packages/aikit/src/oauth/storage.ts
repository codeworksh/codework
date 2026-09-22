/**
 * Shared helpers for OAuth credential modules: environment access, the
 * codework auth.json path, and a JSON file store that understands both flat
 * credential files and per-provider maps.
 */

export function readEnv(name: string): string | undefined {
	if (typeof process === "undefined") return undefined;
	return process.env[name];
}

export function joinPath(...parts: string[]): string {
	return parts.filter(Boolean).join("/").replaceAll(/\/+/g, "/");
}

export function expandHome(path: string): string {
	if (path === "~") return homeDirectory();
	if (path.startsWith("~/")) return joinPath(homeDirectory(), path.slice(2));
	return path;
}

export function homeDirectory(): string {
	const home = readEnv("HOME") ?? readEnv("USERPROFILE");
	if (!home) {
		throw new Error("unable to resolve home directory for OAuth credential storage");
	}
	return home;
}

export function codeworkHomeDirectory(): string {
	const override = readEnv("CODEWORK_HOME_DIR");
	if (override) return expandHome(override);
	return joinPath(homeDirectory(), ".codework");
}

export function defaultAuthFilePath(): string {
	const authFile = readEnv("CODEWORK_CREDENTIALS");
	if (authFile) return expandHome(authFile);
	return joinPath(codeworkHomeDirectory(), "aikit", "auth.json");
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type JsonAuthStorageOptions<T> = {
	path?: string;
	providerId: string;
	isCredentials: (value: unknown) => value is T;
};

/**
 * Provider-scoped credentials inside a shared JSON file.
 *
 * Reads tolerate three layouts: the whole file being the credentials, a
 * top-level `providerId` key, or `providers[providerId]`. Writes always take
 * the top-level key and leave unrelated entries untouched.
 */
export class JsonAuthStorage<T> {
	readonly path: string;
	readonly providerId: string;
	private readonly isCredentials: (value: unknown) => value is T;

	constructor(options: JsonAuthStorageOptions<T>) {
		this.path = options.path ? expandHome(options.path) : defaultAuthFilePath();
		this.providerId = options.providerId;
		this.isCredentials = options.isCredentials;
	}

	async get(): Promise<T | undefined> {
		// A read falls through to the next credential source, so an unreadable
		// file is simply "no credentials here". A write must not: see readFile.
		const file = await this.readFile().catch(() => undefined);
		if (!file) return undefined;

		if (this.isCredentials(file)) return file;

		const direct = file[this.providerId];
		if (this.isCredentials(direct)) return direct;

		const providers = file.providers;
		const nested = isObject(providers) ? providers[this.providerId] : undefined;
		if (this.isCredentials(nested)) {
			return nested;
		}

		return undefined;
	}

	async set(credentials: T): Promise<void> {
		const current = await this.readFile();
		const next = isObject(current) && !this.isCredentials(current) ? current : {};
		next[this.providerId] = credentials;
		await this.writeFile(next);
	}

	async clear(): Promise<void> {
		const current = await this.readFile();
		if (!current) return;

		if (this.isCredentials(current)) {
			await this.writeFile({});
			return;
		}

		delete current[this.providerId];
		const providers = current.providers;
		if (isObject(providers)) delete providers[this.providerId];
		await this.writeFile(current);
	}

	/**
	 * Undefined means the file is genuinely absent or holds no credential map.
	 * Anything else -- unparseable JSON, a permission error -- throws, because
	 * `set` and `clear` rewrite the whole file: treating an unreadable file as
	 * empty would drop every other provider's credentials on the next login.
	 */
	private async readFile(): Promise<AuthFile | undefined> {
		const fs = await import("node:fs/promises");
		let text: string;
		try {
			text = await fs.readFile(this.path, "utf8");
		} catch (error) {
			if (isObject(error) && error.code === "ENOENT") return undefined;
			throw error;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(
				`credentials file ${this.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return isObject(parsed) ? parsed : undefined;
	}

	private async writeFile(value: AuthFile): Promise<void> {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		await fs.mkdir(path.dirname(this.path), { recursive: true });
		const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(tempPath, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.chmod(tempPath, 0o600);
		await fs.rename(tempPath, this.path);
	}
}

type AuthFile = Record<string, unknown>;
