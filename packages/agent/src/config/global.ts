import fs from "node:fs/promises";
import os from "os";
import { join } from "node:path";

export const configDir = ".codework";
export const app = "codework";

function homeDir() {
	const envDir = process.env.CODEWORK_HOME_DIR;
	if (envDir) {
		if (envDir === "~") return os.homedir();
		if (envDir.startsWith("~/")) return join(os.homedir(), envDir.slice(2));
		return envDir;
	}
	return join(os.homedir(), configDir);
}

export namespace Global {
	export const Path = {
		get home() {
			return homeDir();
		},
		get cache() {
			return join(homeDir(), "cache");
		},
		get agent() {
			return join(homeDir(), "agent");
		},
		get data() {
			return join(homeDir(), "data");
		},
		get log() {
			return join(homeDir(), "log");
		},
	} as const;
}

await Promise.all([
	fs.mkdir(Global.Path.cache, { recursive: true }),
	fs.mkdir(Global.Path.agent, { recursive: true }),
	fs.mkdir(Global.Path.data, { recursive: true }),
	fs.mkdir(Global.Path.log, { recursive: true }),
]);
