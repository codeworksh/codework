import { Effect, Predicate, Schema } from "effect";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exports as packageExports } from "resolve.exports";
import { fileSystem as fs, hostPath as path } from "../host.ts";
import * as Package from "./package.ts";
import type { Plugin } from "./plugin.ts";

export const idPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;
const Id = Schema.String.check(Schema.isPattern(idPattern));
const Definition = Schema.Struct({
	id: Id,
	setup: Schema.declare<Plugin["setup"]>((value): value is Plugin["setup"] => Predicate.isFunction(value)),
});

export class PreparationError extends Schema.TaggedError<PreparationError>()("PluginPreparationError", {
	phase: Schema.Literals(["source", "install", "import", "definition", "resolve"]),
	index: Schema.Finite,
	reference: Schema.String,
	id: Schema.optional(Schema.String),
	cause: Schema.Defect(),
}) {}

export interface Origin {
	readonly index: number;
	readonly reference: string;
}

export const failure = (origin: Origin, phase: PreparationError["phase"], cause: unknown, id?: string) =>
	new PreparationError({ ...origin, phase, cause, ...(id === undefined ? {} : { id }) });

export const validate = Effect.fn("PluginLoader.validate")(function* (input: unknown, origin: Origin, builtin = false) {
	const plugin = yield* Schema.decodeUnknownEffect(Definition)(input).pipe(
		Effect.mapError((cause) => failure(origin, "definition", cause)),
	);
	if (!builtin && plugin.id.startsWith("codework.")) {
		return yield* failure(
			origin,
			"definition",
			new Error("The codework namespace is reserved for built-ins"),
			plugin.id,
		);
	}
	return plugin;
});

export type Source =
	| { readonly kind: "disable"; readonly id: string }
	| { readonly kind: "id"; readonly id: string }
	| { readonly kind: "local"; readonly path: string }
	| { readonly kind: "package"; readonly request: Package.Request };

export const classify = (source: string, base: string): Source => {
	if (source.startsWith("!")) {
		const id = Schema.decodeSync(Id)(source.slice(1));
		return { kind: "disable", id };
	}
	if (source.startsWith("file:") || source.startsWith("./") || source.startsWith("../") || path.isAbsolute(source)) {
		return { kind: "local", path: source.startsWith("file:") ? fileURLToPath(source) : path.resolve(base, source) };
	}
	if (Schema.is(Id)(source)) return { kind: "id", id: source };
	return { kind: "package", request: Package.parse(source) };
};

const Manifest = Schema.Struct({
	name: Schema.optional(Schema.String),
	exports: Schema.optional(Schema.Unknown),
});

const localUrl = Effect.fn("PluginLoader.localUrl")(function* (location: string, origin: Origin) {
	const stat = yield* fs.stat(location);
	if (stat.type !== "Directory") return pathToFileURL(location).href;
	const manifestPath = path.join(location, "package.json");
	if (!(yield* fs.exists(manifestPath))) return pathToFileURL(path.join(location, "index.js")).href;
	const manifest = yield* fs
		.readFileString(manifestPath)
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
	if (manifest.exports !== undefined) {
		const targets = yield* Effect.try(() => packageExports(manifest, "."));
		const target = targets?.[0];
		if (target === undefined || !target.startsWith("./"))
			return yield* failure(origin, "source", new Error("No valid root package export"));
		const resolved = path.resolve(location, target);
		if (path.relative(location, resolved).startsWith(".."))
			return yield* failure(origin, "source", new Error("Package export escapes its root"));
		return pathToFileURL(resolved).href;
	}
	return yield* Effect.try(() => pathToFileURL(createRequire(pathToFileURL(manifestPath)).resolve(location)).href);
});

export interface Options {
	readonly cache: string;
	readonly base?: string;
	readonly import?: (url: string) => Promise<unknown>;
	readonly install?: (
		request: Package.Request,
		cache: string,
	) => Effect.Effect<Package.Installed, Package.InstallError>;
}

export interface Loaded {
	readonly plugin: Plugin;
	readonly source: string;
	readonly version?: string;
}

export const load = Effect.fn("PluginLoader.load")(function* (
	source: Extract<Source, { kind: "local" | "package" }>,
	origin: Origin,
	options: Options,
) {
	const installed =
		source.kind === "package"
			? yield* (options.install ?? Package.install)(source.request, options.cache).pipe(
					Effect.mapError((cause) => failure(origin, "install", cause)),
				)
			: {
					url: yield* localUrl(source.path, origin).pipe(
						Effect.mapError((cause) => failure(origin, "source", cause)),
					),
				};
	const module = yield* Effect.tryPromise({
		try: () => (options.import ?? ((url) => import(/* @vite-ignore */ url)))(installed.url),
		catch: (cause) => failure(origin, "import", cause),
	});
	const plugin = yield* validate(
		Predicate.isObject(module) && "default" in module ? module.default : undefined,
		origin,
	);
	return {
		plugin,
		source: origin.reference,
		...("version" in installed ? { version: installed.version } : {}),
	} satisfies Loaded;
});
