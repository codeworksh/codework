import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { getCodeworkDir } from "./credentials.ts";

export interface ModelConfig {
	readonly provider: string;
	readonly model: string;
	readonly updatedAt?: string;
}

export class ConfigManager {
	private readonly filePath: string;

	constructor(dirPath?: string) {
		const baseDir = dirPath || getCodeworkDir();
		this.filePath = path.join(baseDir, "config.json");
	}

	loadSync(): ModelConfig | null {
		try {
			const data = fsSync.readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(data);
			if (parsed && typeof parsed.provider === "string" && typeof parsed.model === "string") {
				return {
					provider: parsed.provider,
					model: parsed.model,
					updatedAt: parsed.updatedAt,
				};
			}
			return null;
		} catch {
			return null;
		}
	}

	async load(): Promise<ModelConfig | null> {
		try {
			const data = await fs.readFile(this.filePath, "utf8");
			const parsed = JSON.parse(data);
			if (parsed && typeof parsed.provider === "string" && typeof parsed.model === "string") {
				return {
					provider: parsed.provider,
					model: parsed.model,
					updatedAt: parsed.updatedAt,
				};
			}
			return null;
		} catch {
			return null;
		}
	}

	async save(config: ModelConfig): Promise<void> {
		const dir = path.dirname(this.filePath);
		await fs.mkdir(dir, { recursive: true });
		const content = JSON.stringify(
			{
				provider: config.provider,
				model: config.model,
				updatedAt: new Date().toISOString(),
			},
			null,
			2,
		);
		await fs.writeFile(this.filePath, content, "utf8");
	}
}

let defaultConfigManager: ConfigManager | null = null;

export function getConfigManager(): ConfigManager {
	if (!defaultConfigManager) {
		defaultConfigManager = new ConfigManager();
	}
	return defaultConfigManager;
}
