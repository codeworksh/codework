import { Effect, Predicate, Schema } from "effect";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { domains, type PluginKind } from "./plugin.ts";
import { importModule, resolveModule } from "../util/module.ts";
import { fileSystem as fs, hostPath as path } from "../host.ts";
import { InstallError, LoadError, SourceError, type StoreError } from "./error.ts";
import { url } from "./npm.ts";
import { canonical as canonicalOf, type Fetchable, parse, type Target } from "./source.ts";
import * as Store from "./store.ts";
import type { EventSchema } from "../event/schema.ts";
import type { Plugin } from "./plugin.ts";

/** `vendor.domain.context`, exactly three segments — a fourth would shadow a package name. */
export const idPattern = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2}$/;
const Id = Schema.String.check(Schema.isPattern(idPattern));
const Definition = Schema.Struct({
	id: Id,
	kind: Schema.Literals(Object.keys(domains) as ReadonlyArray<PluginKind>),
	// Shape only. What the types mean -- namespace, collisions with the kernel or
	// another plugin -- is `EventRegistry.flatten`'s call, since it is the only
	// place that sees every plugin at once.
	events: Schema.optional(
		Schema.Array(
			Schema.declare<EventSchema.Definition>(
				(value): value is EventSchema.Definition =>
					Predicate.hasProperty(value, "type") && Predicate.isString(value.type),
			),
		),
	),
	setup: Schema.declare<Plugin["setup"]>((value): value is Plugin["setup"] => Predicate.isFunction(value)),
});

export interface Origin {
	readonly index: number;
	readonly reference: string;
}

const detail = (cause: unknown): string =>
	cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

/** A reference that does not name anything loadable. */
export const sourceFailure = (origin: Origin, cause: unknown) =>
	Schema.is(SourceError)(cause)
		? cause
		: new SourceError({
				reason: "plugin-not-found",
				reference: origin.reference,
				message: detail(cause),
			});

/**
 * A module that would not import.
 *
 * A missing dependency gets its own reason because the remedy is different: the plugin is fine and
 * its `node_modules` is not, which is a thing a person fixes in the package rather than in their
 * settings.
 */
export const importFailure = (origin: Origin, cause: unknown) =>
	new LoadError({
		reason: /cannot find (package|module)/i.test(detail(cause))
			? "plugin-missing-dependency"
			: "plugin-import-failed",
		reference: origin.reference,
		message: detail(cause),
		cause,
	});

/** A module that imported and is not a plugin. */
export const definitionFailure = (origin: Origin, cause: unknown, id?: string) =>
	new LoadError({
		reason: "plugin-invalid-definition",
		reference: origin.reference,
		message: detail(cause),
		...(id === undefined ? {} : { id }),
		cause,
	});

export const validate = Effect.fn("PluginLoader.validate")(function* (input: unknown, origin: Origin, builtin = false) {
	yield* Schema.decodeUnknownEffect(Definition)(input).pipe(
		Effect.mapError((cause) => definitionFailure(origin, cause)),
	);
	// The author's own object, not the decoded copy: a `Struct` decode keeps only the
	// declared keys, which would strip a plugin's other properties and leave `this`
	// pointing at a clone inside the documented `setup() {}` shorthand.
	const plugin = input as Plugin;
	if (!builtin && plugin.id.startsWith("codework.")) {
		return yield* definitionFailure(origin, new Error("codework namespace is reserved for builtins"), plugin.id);
	}
	return plugin;
});

const Manifest = Schema.Struct({
	name: Schema.optional(Schema.String),
	exports: Schema.optional(Schema.Unknown),
});

/** What either path produced: a URL to import, plus whatever it could say about it. */
interface Resolved extends Installed {
	/** The package name a local package declared. Only a local source has one. */
	readonly name?: string | undefined;
}

const localUrl = Effect.fn("PluginLoader.localUrl")(function* (location: string, origin: Origin) {
	const escapes = (message: string) =>
		new SourceError({ reason: "plugin-escapes-root", reference: origin.reference, message });
	const stat = yield* fs.stat(location);
	if (stat.type !== "Directory") {
		return { url: yield* Effect.try(() => resolveModule(location, path.dirname(location))) } satisfies Resolved;
	}
	const manifestPath = path.join(location, "package.json");
	if (!(yield* fs.exists(manifestPath))) {
		return { url: yield* Effect.try(() => resolveModule("./index", location)) } satisfies Resolved;
	}
	const manifest = yield* fs
		.readFileString(manifestPath)
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
	if (manifest.exports !== undefined) {
		const name = manifest.name;
		if (!name) return yield* escapes("a local package with exports must declare its name");
		const url = yield* Effect.try(() => resolveModule(name, location));
		// Compare real paths: a symlinked target (or root) can point outside while the
		// string paths still nest.
		const resolved = yield* fs.realPath(fileURLToPath(url));
		if (path.relative(yield* fs.realPath(location), resolved).startsWith("..")) {
			return yield* escapes("package export escapes its root");
		}
		return { url: pathToFileURL(resolved).href, name } satisfies Resolved;
	}
	const url = yield* Effect.try(() =>
		resolveModule(createRequire(pathToFileURL(manifestPath)).resolve(location), location),
	);
	return (manifest.name === undefined ? { url } : { url, name: manifest.name }) satisfies Resolved;
});

export interface Options {
	readonly cache: string;
	/** The host directory a relative reference anchors to. Never read here. */
	readonly hostDir: string;
	readonly import?: (url: string) => Promise<unknown>;
	/**
	 * How a package reaches the disk. The default installs; `plugin remove` passes a resolve-only
	 * one so it can identify an entry without fetching anything.
	 */
	readonly install?: (target: Fetchable, cache: string) => Effect.Effect<Installed, InstallError | StoreError>;
}

/** Enough of a store entry to import it. */
export interface Installed {
	readonly url: string;
	readonly version?: string | undefined;
	/**
	 * Which store generation this came from. Absent for a built-in, a supplied object and a local
	 * source -- none of which are filed, so none of which can be superseded.
	 */
	readonly generation?: number | undefined;
	/**
	 * Set when the installer already imported and checked the module -- which the default one
	 * does, because the store validates a staged artifact before publishing it (§7.7). Carrying
	 * the result back means it is not imported a second time from the published path.
	 */
	readonly plugin?: Plugin | undefined;
}

/**
 * Install a package into the store, importing and validating it **while it is still staged**.
 *
 * The validation is passed down rather than done afterwards for one reason: the store publishes by
 * rename, so a package that turns out not to be a plugin must be rejected before it is published.
 * Publishing first would make the broken generation the newest marked one, which `resolve` returns
 * forever after -- and re-running `add` would hit the fast path and return it again.
 */
const install = Effect.fn("PluginLoader.install")(function* (
	target: Fetchable,
	cache: string,
	origin: Origin,
	options: Options,
) {
	// The validation failure passes through as itself: "installed, and is not a plugin" is a load
	// failure, and calling it an install failure would send the reader to the registry.
	const added = yield* Store.add(target, cache, {
		validate: (fetched) => imported(url(fetched.entrypoint), origin, options.import),
	});
	return {
		url: added.entry.url,
		...(added.entry.version === undefined ? {} : { version: added.entry.version }),
		generation: added.entry.generation,
		...(added.validated === undefined ? {} : { plugin: added.validated }),
	} satisfies Installed;
});

/** The default installer, or the one the caller injected. */
const installer = (
	target: Fetchable,
	origin: Origin,
	options: Options,
): Effect.Effect<Installed, InstallError | StoreError | LoadError> =>
	options.install === undefined
		? install(target, options.cache, origin, options)
		: options.install(target, options.cache);

/** Import a module and confirm it default-exports a plugin. */
const imported = Effect.fn("PluginLoader.imported")(function* (
	url: string,
	origin: Origin,
	load?: (url: string) => Promise<unknown>,
) {
	const module = yield* Effect.tryPromise({
		try: () => (load ?? importModule)(url),
		catch: (cause) => importFailure(origin, cause),
	});
	return yield* validate(Predicate.isObject(module) && "default" in module ? module.default : undefined, origin);
});

/**
 * Import one entrypoint and confirm it is a plugin, without touching the store.
 *
 * This is what a caller hands the store as its `validate`: the artifact is checked while it is
 * still staged, so a package that turns out not to be a plugin is never published.
 */
export const definition = (entrypoint: string, reference: string) => imported(url(entrypoint), { index: 0, reference });

export interface Loaded {
	readonly plugin: Plugin;
	readonly source: string;
	readonly version?: string;
	/** The store generation this module came from, when it came from the store. */
	readonly generation?: number;
	/** The package name a local package declared, registered as one of its aliases. */
	readonly name?: string;
}

/**
 * Install and import one reference, and report what it turned out to be, without selecting it.
 * `codework plugin add` uses this to prove a package really is a plugin before it writes the
 * reference into a settings file: the failure a user gets is the one they can act on — a bad
 * spec, an install that did not resolve, a module that exports no plugin — rather than a broken
 * configuration that only fails at the next run.
 */
export const inspect = Effect.fn("PluginLoader.inspect")(function* (reference: string, options: Options) {
	const origin = { index: 0, reference };
	const target = yield* parse(reference, options.hostDir);
	const loaded = yield* load(target, origin, options);
	return {
		id: loaded.plugin.id,
		...(loaded.version === undefined ? {} : { version: loaded.version }),
		...(loaded.name === undefined ? {} : { name: loaded.name }),
	};
});

export const load = Effect.fn("PluginLoader.load")(function* (target: Target, origin: Origin, options: Options) {
	const resolved: Effect.Effect<Resolved, SourceError | InstallError | StoreError | LoadError> =
		target.kind === "local"
			? localUrl(target.path, origin).pipe(Effect.mapError((cause) => sourceFailure(origin, cause)))
			: // An installer already speaks the taxonomy, so its failure passes through untouched:
				// wrapping it would bury the reason a caller is meant to act on.
				installer(target, origin, options);
	const installed = yield* resolved;
	// Already checked while staged, in the common case; a local source and an injected installer
	// still have to be imported here.
	const plugin = installed.plugin ?? (yield* imported(installed.url, origin, options.import));
	return {
		plugin,
		source: origin.reference,
		...("version" in installed && installed.version !== undefined ? { version: installed.version } : {}),
		...("generation" in installed && installed.generation !== undefined ? { generation: installed.generation } : {}),
		// A local package answers to the name it declares, so a path entry can be configured by
		// the package name its README documents.
		...(installed.name === undefined ? {} : { name: installed.name }),
	} satisfies Loaded;
});

/**
 * The version-free, location-anchored spelling of a reference.
 *
 * Two references naming the same module compare equal through it: `@acme/x@1.2.0` and `@acme/x`
 * are one package, and `./plugins/x.ts` is the file it resolves to from the directory that
 * declared it. Pure -- nothing is installed, imported or read.
 */
export const canonical = (reference: string, hostDir: string): Effect.Effect<string, SourceError> =>
	Effect.map(parse(reference, hostDir), canonicalOf);

export * as PluginLoader from "./loader.ts";
