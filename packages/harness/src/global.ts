import { Config, Context, Effect, Layer } from "effect";
import fs from "node:fs/promises";
import * as os from "node:os";
import { join, resolve as resolvePath } from "node:path";

export const configDir = ".codework";
export const app = "codework";

const defaultHome = join(os.homedir(), configDir);

function expandHome(value: string) {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return join(os.homedir(), value.slice(2));
	return resolvePath(value);
}

export const homeConfig = Config.string("CODEWORK_HOME_DIR").pipe(
	Config.withDefault(defaultHome),
	Config.map(expandHome),
);

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/global/Service") {}

export interface Interface {
	readonly home: string;
	readonly cache: string;
	readonly agent: string;
	readonly data: string;
	readonly log: string;
}

export function make(input: Partial<Interface> = {}): Interface {
	const home = expandHome(input.home ?? defaultHome);
	return {
		home,
		cache: input.cache ?? join(home, "cache"),
		agent: input.agent ?? join(home, "agent"),
		data: input.data ?? join(home, "data"),
		log: input.log ?? join(home, "log"),
	};
}

export const resolve = Effect.fn("Global.resolve")(function* (input: Partial<Interface> = {}) {
	const home = input.home === undefined ? yield* homeConfig : expandHome(input.home);
	return make({ ...input, home });
});

const build = (input: Partial<Interface>) =>
	Effect.gen(function* () {
		const paths = yield* resolve(input);
		yield* Effect.promise(() =>
			Promise.all([
				fs.mkdir(paths.cache, { recursive: true }),
				fs.mkdir(paths.agent, { recursive: true }),
				fs.mkdir(paths.data, { recursive: true }),
				fs.mkdir(paths.log, { recursive: true }),
			]),
		);
		return Service.of(paths);
	});

export const layer = Layer.effect(Service, build({}));

export const defaultLayer = layer;

export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, build(input));

export * as Global from "./global.ts";
