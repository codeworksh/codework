import { Config, Context, Effect, Layer } from "effect";
import * as os from "node:os";
import { fileSystem } from "./host.ts";
import { posix } from "./util/posix.ts";

export const configDir = ".codework";
export const app = "codework";

const defaultHome = posix.join(os.homedir(), configDir);

function expandHome(value: string) {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return posix.join(os.homedir(), value.slice(2));
	return posix.resolve(value);
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
		cache: input.cache ?? posix.join(home, "cache"),
		agent: input.agent ?? posix.join(home, "agent"),
		data: input.data ?? posix.join(home, "data"),
		log: input.log ?? posix.join(home, "log"),
	};
}

export const resolve = Effect.fn("Global.resolve")(function* (input: Partial<Interface> = {}) {
	const home = input.home === undefined ? yield* homeConfig : expandHome(input.home);
	return make({ ...input, home });
});

const build = (input: Partial<Interface>) =>
	Effect.gen(function* () {
		const paths = yield* resolve(input);
		yield* Effect.all([
			fileSystem.makeDirectory(paths.cache, { recursive: true }),
			fileSystem.makeDirectory(paths.agent, { recursive: true }),
			fileSystem.makeDirectory(paths.data, { recursive: true }),
			fileSystem.makeDirectory(paths.log, { recursive: true }),
		]).pipe(Effect.orDie);
		return Service.of(paths);
	});

export const layer = Layer.effect(Service, build({}));

export const defaultLayer = layer;

export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, build(input));

export * as Global from "./global.ts";
