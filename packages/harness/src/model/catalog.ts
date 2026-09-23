/*
 * @file The model catalog a Codework home keeps.
 *
 * aikit reads `models.gen.json` from wherever it is pointed; this module points it at
 * `<home>/models.gen.json` and keeps that file fresh. A one-shot command checks it once, a
 * server re-checks on a timer, and both apply the same TTL -- they differ only in how often
 * they ask. `CODEWORK_MODELS_FILE` pins the catalog to a file the user manages: it is read,
 * and reloaded when it changes, but only an explicit refresh ever writes it.
 */
import { Model } from "@codeworksh/aikit";
import { generateModels } from "@codeworksh/aikit/modelgen";
import { Clock, Config, Duration, Effect, Layer, Option, Ref, Schedule, Schema } from "effect";
import { fileSystem, hostPath } from "../host.ts";
import { Runner } from "../runner/run.ts";

export const filename = "models.gen.json";

/** How old the catalog may get before a check downloads a new one. */
export const ttlConfig = Config.Duration("CODEWORK_MODELS_TTL").pipe(Config.withDefault(Duration.minutes(15)));

/** How often a server looks at the file. A look is a `stat`; only a stale file costs a download. */
const checkEvery = Duration.minutes(1);

export class RefreshError extends Schema.TaggedError<RefreshError>()("ModelCatalog.RefreshError", {
	path: Schema.String,
	detail: Schema.String,
}) {
	override get message(): string {
		return `failed to refresh the model catalog at ${this.path}: ${this.detail}`;
	}
}

export interface Status {
	readonly path: string;
	/** False when the catalog was fresh enough to keep. */
	readonly refreshed: boolean;
}

interface Target {
	/** The file aikit reads. */
	readonly path: string;
	/** Set when `CODEWORK_MODELS_FILE` overrides the home's catalog. */
	readonly pinned: boolean;
}

/** Point aikit at `<home>/models.gen.json`, which `CODEWORK_MODELS_FILE` overrides. */
const use = (home: string): Target => {
	const own = hostPath.resolve(home, filename);
	Model.configureCatalog(own);
	const path = Model.catalogPath();
	return { path, pinned: path !== own };
};

const modified = (path: string) =>
	fileSystem.stat(path).pipe(
		Effect.map((info) => Option.map(info.mtime, (date) => date.getTime())),
		Effect.orElseSucceed(() => Option.none<number>()),
	);

const stale = Effect.fn("ModelCatalog.stale")(function* (path: string) {
	const mtime = yield* modified(path);
	if (Option.isNone(mtime)) return true;
	const ttl = yield* ttlConfig;
	return (yield* Clock.currentTimeMillis) - mtime.value >= Duration.toMillis(ttl);
});

const download = (path: string) =>
	Effect.tryPromise({
		try: () => generateModels({ path }),
		catch: (cause) => new RefreshError({ path, detail: cause instanceof Error ? cause.message : String(cause) }),
	});

/** Download a new catalog for the home when it is missing, older than the TTL, or `force` asks. */
export const refresh = Effect.fn("ModelCatalog.refresh")(function* (
	home: string,
	options: { readonly force?: boolean } = {},
) {
	const { path } = use(home);
	if (options.force !== true && !(yield* stale(path))) return { path, refreshed: false } satisfies Status;
	yield* download(path);
	return { path, refreshed: true } satisfies Status;
});

/**
 * The automatic check: refresh a stale catalog unless it is pinned, and never fail. A failed
 * download leaves the old file in place; a missing one surfaces later as a
 * `Runner.ModelCatalogError` from whatever needed it.
 */
const check = Effect.fn("ModelCatalog.check")(function* ({ path, pinned }: Target) {
	if (pinned || !(yield* stale(path))) return;
	yield* download(path);
});

const quietly = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.asVoid,
		Effect.catch((error) => Effect.logWarning(`model catalog: ${error.message}`)),
	);

/** Check the home's catalog once, for a command that runs and exits; returns the file aikit reads. */
export const sync = Effect.fn("ModelCatalog.sync")(function* (home: string) {
	const target = use(home);
	yield* quietly(check(target));
	return target.path;
});

/**
 * Check at boot, and with `watch`, keep checking for the life of the layer. A file whose mtime
 * moved -- refreshed here, by `codework models refresh`, or by hand -- is reloaded, so the
 * process never serves a catalog older than what is on disk.
 */
export const layer = (options: { readonly home: string; readonly watch: boolean }) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const target = use(options.home);
			yield* quietly(check(target));
			if (!options.watch) return;

			const current = modified(target.path).pipe(Effect.map(Option.getOrUndefined));
			const seen = yield* Ref.make(yield* current);
			const tick = Effect.gen(function* () {
				yield* quietly(check(target));
				const mtime = yield* current;
				if (mtime !== (yield* Ref.getAndSet(seen, mtime))) Model.reloadCatalog();
			});
			yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(checkEvery))));
		}),
	);

/** Translate aikit's catalog failure, or undefined for anything else. */
export const loadError = (cause: unknown): Runner.ModelCatalogError | undefined => {
	if (typeof cause !== "object" || cause === null || !("name" in cause) || cause.name !== "ModelCatalogLoadError") {
		return undefined;
	}
	if (!("data" in cause) || typeof cause.data !== "object" || cause.data === null) return undefined;
	const data = cause.data;
	if (
		!("path" in data) ||
		typeof data.path !== "string" ||
		!("message" in data) ||
		typeof data.message !== "string" ||
		!("reason" in data) ||
		(data.reason !== "missing" &&
			data.reason !== "unreadable" &&
			data.reason !== "empty" &&
			data.reason !== "invalid")
	) {
		return undefined;
	}
	return new Runner.ModelCatalogError({ path: data.path, reason: data.reason, detail: data.message });
};

const catalogError = (cause: unknown): Runner.ModelCatalogError =>
	loadError(cause) ??
	new Runner.ModelCatalogError({
		path: Model.catalogPath(),
		reason: "unreadable",
		detail: cause instanceof Error ? cause.message : "failed to load the model catalog",
	});

export const models = Effect.tryPromise({ try: () => Model.getBuiltInModels(), catch: catalogError });

export const providers = Effect.tryPromise({ try: () => Model.getProviders(), catch: catalogError });

export * as ModelCatalog from "./catalog.ts";
