import { Effect, Context, Layer } from "effect";
import * as os from "node:os";
import { join, resolve } from "node:path";
import fs from "node:fs/promises";

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

await Promise.all([
	fs.mkdir(Path.cache, { recursive: true }),
	fs.mkdir(Path.agent, { recursive: true }),
	fs.mkdir(Path.data, { recursive: true }),
	fs.mkdir(Path.log, { recursive: true }),
]);

export class Service extends Context.Service<Service, Interface>()("@codework/global") {}

export interface Interface {
	readonly home: string;
	readonly cache: string;
	readonly agent: string;
	readonly data: string;
	readonly log: string;
}

export function make(input: Partial<Interface> = {}): Interface {
	return {
		home: Path.home,
		cache: Path.cache,
		agent: Path.agent,
		data: Path.data,
		log: Path.log,
		...input,
	};
}

export const layer = Layer.effect(
	Service,
	Effect.sync(() => Service.of(make())),
);

export const defaultLayer = layer;

export const layerWith = (input: Partial<Interface>) =>
	Layer.effect(
		Service,
		Effect.sync(() => Service.of(make(input))),
	);

export * as Global from "./global";
