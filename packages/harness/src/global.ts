import { Config, Context, Effect, Layer } from "effect";
import * as os from "node:os";
import { fileSystem } from "./host.ts";
import { expandTilde } from "./util/home.ts";
import { posix } from "./util/posix.ts";

export const appConfigDir = ".codework";
export const app = "codework";

const defaultHome = posix.join(os.homedir(), appConfigDir);

const expandHome = (value: string) => posix.resolve(expandTilde(value, posix));

export const homeConfig = Config.String("CODEWORK_HOME_DIR").pipe(
	Config.withDefault(defaultHome),
	Config.map(expandHome),
);

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/global/Service") {}

export interface Interface {
	readonly home: string;
	readonly cache: string;
	readonly data: string;
	readonly log: string;
}

export function make(input: Partial<Interface> = {}): Interface {
	const home = expandHome(input.home ?? defaultHome);
	return {
		home,
		cache: input.cache ?? posix.join(home, "cache"),
		data: input.data ?? posix.join(home, "data"),
		log: input.log ?? posix.join(home, "log"),
	};
}

/**
 * Where a Codework home keeps its OAuth credentials, or undefined to let aikit
 * resolve them (`CODEWORK_CREDENTIALS`, then the default home).
 *
 * Callers pass a home only when the user actually chose one, so an explicit
 * `--home` pins the file and everything else defers to aikit. The harness and
 * the RPC server both go through here: if they disagreed, a login stored by one
 * would be invisible to the other.
 */
export const authFile = (home: string | undefined): string | undefined =>
	home === undefined ? undefined : posix.join(home, "aikit", "auth.json");

export const resolve = Effect.fn("Global.resolve")(function* (input: Partial<Interface> = {}) {
	const home = input.home === undefined ? yield* homeConfig : expandHome(input.home);
	return make({ ...input, home });
});

const build = (input: Partial<Interface>) =>
	Effect.gen(function* () {
		const paths = yield* resolve(input);
		yield* Effect.all([
			fileSystem.makeDirectory(paths.cache, { recursive: true }),
			fileSystem.makeDirectory(paths.data, { recursive: true }),
			fileSystem.makeDirectory(paths.log, { recursive: true }),
		]).pipe(Effect.orDie);
		return Service.of(paths);
	});

export const layer = Layer.effect(Service, build({}));

export const defaultLayer = layer;

export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, build(input));

export * as Global from "./global.ts";
