import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Interface for credential storage.
 * Designed so OS keychain storage (e.g. macOS Keychain, Windows Credential Manager)
 * can be plugged in without changing business logic.
 */
export interface CredentialStore {
	getApiKey(providerId: string): Promise<string | undefined>;
	setApiKey(providerId: string, apiKey: string): Promise<void>;
	deleteApiKey(providerId: string): Promise<void>;
}

export function getCodeworkDir(): string {
	return process.env.CODEWORK_HOME || path.join(os.homedir(), ".codework");
}

/**
 * File-based JSON credential storage with restricted permissions (0o600).
 * Keeps secrets strictly separate from application configuration.
 */
export class JsonCredentialStore implements CredentialStore {
	private readonly filePath: string;

	constructor(dirPath?: string) {
		const baseDir = dirPath || getCodeworkDir();
		this.filePath = path.join(baseDir, "credentials.json");
	}

	private async ensureDir(): Promise<void> {
		const dir = path.dirname(this.filePath);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	}

	private async readAll(): Promise<Record<string, string>> {
		try {
			const data = await fs.readFile(this.filePath, "utf8");
			return JSON.parse(data) as Record<string, string>;
		} catch {
			return {};
		}
	}

	async getApiKey(providerId: string): Promise<string | undefined> {
		const all = await this.readAll();
		return all[providerId];
	}

	async setApiKey(providerId: string, apiKey: string): Promise<void> {
		await this.ensureDir();
		const all = await this.readAll();
		all[providerId] = apiKey;
		await fs.writeFile(this.filePath, JSON.stringify(all, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
	}

	async deleteApiKey(providerId: string): Promise<void> {
		const all = await this.readAll();
		if (providerId in all) {
			delete all[providerId];
			await fs.writeFile(this.filePath, JSON.stringify(all, null, 2), {
				encoding: "utf8",
				mode: 0o600,
			});
		}
	}
}

/**
 * Future OS Keychain implementation stub:
 * export class KeychainCredentialStore implements CredentialStore { ... }
 */

let defaultStore: CredentialStore | null = null;

export function getCredentialStore(): CredentialStore {
	if (!defaultStore) {
		defaultStore = new JsonCredentialStore();
	}
	return defaultStore;
}
