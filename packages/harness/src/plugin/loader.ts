import { Effect, Predicate, Schema } from "effect";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exports as packageExports } from "resolve.exports";
import { fileSystem as fs, hostPath as path } from "../host.ts";
import * as Package from "./package.ts";
import type { Plugin } from "./plugin.ts";

/** `vendor.domain.context`, exactly three segments — a fourth would shadow a package name. */
export const idPattern = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2}$/;
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
	yield* Schema.decodeUnknownEffect(Definition)(input).pipe(
		Effect.mapError((cause) => failure(origin, "definition", cause)),
	);
	// The author's own object, not the decoded copy: a `Struct` decode keeps only the
	// declared keys, which would strip a plugin's other properties and leave `this`
	// pointing at a clone inside the documented `setup() {}` shorthand.
	const plugin = input as Plugin;
	if (!builtin && plugin.id.startsWith("codework.")) {
		return yield* failure(origin, "definition", new Error("codework namespace is reserved for builtins"), plugin.id);
	}
	return plugin;
});

export type Source =
	| { readonly kind: "disable"; readonly id: string }
	| { readonly kind: "id"; readonly id: string }
	| { readonly kind: "local"; readonly path: string }
	| { readonly kind: "package"; readonly request: Package.Request };

export const classify = (source: string, hostCwd: string): Source => {
	if (source.startsWith("!")) {
		const id = Schema.decodeSync(Id)(source.slice(1));
		return { kind: "disable", id };
	}
	if (source.startsWith("file:")) {
		// Both `new URL` and `fileURLToPath` silently read a relative `file:./x` as `/x`. A file
		// URL names an absolute path or it is not one.
		if (!source.startsWith("file:///")) throw new Error(`not an absolute file URL: ${source}`);
		return { kind: "local", path: fileURLToPath(source) };
	}
	if (source.startsWith("./") || source.startsWith("../") || path.isAbsolute(source)) {
		return { kind: "local", path: path.resolve(hostCwd, source) };
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
	if (!(yield* fs.exists(manifestPath))) {
		const fallback = path.join(location, "index.js");
		if (!(yield* fs.exists(fallback)))
			return yield* failure(origin, "source", new Error(`Directory has no package.json or index.js: ${location}`));
		return pathToFileURL(fallback).href;
	}
	const manifest = yield* fs
		.readFileString(manifestPath)
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
	if (manifest.exports !== undefined) {
		const targets = yield* Effect.try(() => packageExports(manifest, "."));
		const target = targets?.[0];
		if (target === undefined || !target.startsWith("./"))
			return yield* failure(origin, "source", new Error("No valid root package export"));
		// Compare real paths: a symlinked target (or root) can point outside while the
		// string paths still nest.
		const resolved = yield* fs.realPath(path.resolve(location, target));
		if (path.relative(yield* fs.realPath(location), resolved).startsWith(".."))
			return yield* failure(origin, "source", new Error("Package export escapes its root"));
		return pathToFileURL(resolved).href;
	}
	return yield* Effect.try(() => pathToFileURL(createRequire(pathToFileURL(manifestPath)).resolve(location)).href);
});

export interface Options {
	readonly cache: string;
	/** The OS process's directory, that constructor-relative references resolve against. Never read here. */
	readonly hostCwd: string;
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
						// `localUrl` already reports its own source failures; only platform errors
						// reaching here still need attribution.
						Effect.mapError((cause) =>
							Schema.is(PreparationError)(cause) ? cause : failure(origin, "source", cause),
						),
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
