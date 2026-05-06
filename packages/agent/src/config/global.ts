import fs from "node:fs/promises";
import os from "os";
import { join, resolve } from "node:path";

export const configDir = ".codework";
export const app = "codework";

function homeDir() {
	const envDir = process.env.CODEWORK_HOME_DIR;
	if (envDir) {
		if (envDir === "~") return os.homedir();
		if (envDir.startsWith("~/")) return join(os.homedir(), envDir.slice(2));
		return resolve(envDir);
	}
	return join(os.homedir(), configDir);
}

const home = homeDir();

export namespace Global {
	export const Path = {
		get home() {
			return home;
		},
		get cache() {
			return join(home, "cache");
		},
		get agent() {
			return join(home, "agent");
		},
		get data() {
			return join(home, "data");
		},
		get log() {
			return join(home, "log");
		},
	} as const;
}

await Promise.all([
	fs.mkdir(Global.Path.cache, { recursive: true }),
	fs.mkdir(Global.Path.agent, { recursive: true }),
	fs.mkdir(Global.Path.data, { recursive: true }),
	fs.mkdir(Global.Path.log, { recursive: true }),
]);
