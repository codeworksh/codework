/*
 * @file The store, as it stands before Domain 2 replaces it.
 *
 * One directory per canonical spec under `<cache>/plugins`, published by an atomic rename and
 * proved by a `.complete.json` marker. What fills the staging directory is `PluginNpm.download`:
 * arborist in process, never a package manager binary.
 *
 * Domain 1 knows nothing about any of this. The split is what lets it be tested against a temp
 * directory with no store, and this file against a runner that copies a fixture.
 */

import { Duration, Effect, Encoding, Option, Ref, Schedule, Schema } from "effect";
import { crypto, fileSystem as fs, hostPath as path } from "../host.ts";
import { InstallError, StoreError } from "./error.ts";
import { download, type Runner, url } from "./npm.ts";
import type { Fetchable } from "./source.ts";

const Cached = Schema.Struct({
	spec: Schema.String,
	version: Schema.optional(Schema.String),
	revision: Schema.optional(Schema.String),
	/** Relative to the entry directory, so the marker survives the publishing rename. */
	entrypoint: Schema.String,
});

export interface Installed {
	readonly url: string;
	readonly version?: string;
	readonly revision?: string;
}

/** A marker that cannot be read, or does not describe what was asked for. */
const unreadable =
	(target: Fetchable) =>
	(cause: unknown): StoreError =>
		Schema.is(StoreError)(cause)
			? cause
			: new StoreError({
					reason: "plugin-marker-invalid",
					reference: target.spec,
					message: `cannot read what is filed for ${target.spec}`,
					cause,
				});

const mismatched = (target: Fetchable, marker: string) =>
	new StoreError({
		reason: "plugin-marker-invalid",
		reference: target.spec,
		message: `${marker} was filed under a different spec`,
	});

const location = Effect.fn("PluginPackage.location")(function* (target: Fetchable, cache: string) {
	const root = path.join(cache, "plugins");
	// The full digest of the canonical spec. Truncating it would make a collision return the
	// wrong package silently, because the fast path proves a hit by the marker *existing*.
	const key = Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(target.spec)));
	const directory = path.join(root, key);
	return { root, key, directory, marker: path.join(directory, ".complete.json") };
});

const readPublished = Effect.fn("PluginPackage.readPublished")(function* (
	target: Fetchable,
	directory: string,
	marker: string,
) {
	const saved = yield* fs
		.readFileString(marker)
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cached))));
	if (saved.spec !== target.spec) return yield* mismatched(target, marker);
	return {
		url: url(path.resolve(directory, saved.entrypoint)),
		...(saved.version === undefined ? {} : { version: saved.version }),
		...(saved.revision === undefined ? {} : { revision: saved.revision }),
	} satisfies Installed;
});

/** Resolve an already-published package without installing or waiting for an installer. */
export const resolveCached = Effect.fn("PluginPackage.resolveCached")(function* (target: Fetchable, cache: string) {
	const { directory, marker } = yield* location(target, cache).pipe(Effect.mapError(unreadable(target)));
	const filed = yield* fs.exists(marker).pipe(Effect.mapError(unreadable(target)));
	if (!filed) {
		return yield* new StoreError({
			reason: "plugin-not-installed",
			reference: target.spec,
			message: `${target.spec} is not installed`,
		});
	}
	return yield* readPublished(target, directory, marker).pipe(Effect.mapError(unreadable(target)));
});

/** How long to wait for another installer of the same spec before giving up. */
const LOCK_TIMEOUT = Duration.minutes(2);
/** The holder refreshes the lock's mtime this often; a lock not refreshed for the timeout is abandoned. */
const LOCK_HEARTBEAT = Duration.seconds(15);

/**
 * A lock whose holder stopped refreshing it was left by a crashed installer. Staleness is
 * measured from the heartbeat, not the install's start, so a slow but live install is never
 * stolen from.
 */
const abandoned = (directory: string) =>
	Effect.gen(function* () {
		const info = yield* fs.stat(directory);
		const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		return Option.exists(info.mtime, (mtime) => now - mtime.getTime() > Duration.toMillis(LOCK_TIMEOUT));
	}).pipe(Effect.orElseSucceed(() => false));

const heartbeat = (directory: string) =>
	Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
		Effect.flatMap((now) => fs.utimes(directory, now, now)),
		Effect.ignore,
		Effect.repeat(Schedule.spaced(LOCK_HEARTBEAT)),
	);

/**
 * Claims `directory` by creating it, polling while another process holds it.
 *
 * One finalizer for the whole wait, registered before the first attempt: retrying inside
 * `acquireRelease` would add a finalizer per poll. A crashed installer leaves its lock
 * behind; an abandoned one is reclaimed rather than waited on forever, and the wait itself
 * is bounded. While held, the lock is heartbeated so waiters can tell live from dead.
 */
const lock = Effect.fn("PluginPackage.lock")(function* (target: Fetchable, directory: string) {
	const held = yield* Ref.make(false);
	yield* Effect.acquireRelease(Effect.void, () =>
		Ref.get(held).pipe(
			Effect.flatMap((owned) => (owned ? fs.remove(directory, { recursive: true, force: true }) : Effect.void)),
			Effect.orDie,
		),
	);
	// One attempt is uninterruptible so `mkdir` and recording ownership cannot be split: an
	// interrupt between them would leave a lock the finalizer does not know to remove.
	const attempt = fs.makeDirectory(directory).pipe(
		Effect.andThen(Ref.set(held, true)),
		Effect.as(true),
		Effect.catchIf(
			(error) => error.reason._tag === "AlreadyExists",
			() =>
				abandoned(directory).pipe(
					Effect.flatMap((stale) =>
						stale
							? fs.remove(directory, { recursive: true, force: true }).pipe(Effect.as(false))
							: Effect.succeed(false),
					),
				),
		),
		Effect.uninterruptible,
	);
	const acquired = yield* attempt.pipe(
		Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (owned) => owned }),
		Effect.timeoutOrElse({ duration: LOCK_TIMEOUT, orElse: () => Effect.succeed(false) }),
	);
	if (!acquired) {
		return yield* new StoreError({
			reason: "plugin-lock-timeout",
			reference: target.spec,
			message: `timed out waiting for another installation to release ${directory}`,
		});
	}
	// Scoped to the install: the heartbeat dies with the scope, before the lock is removed.
	yield* Effect.forkScoped(heartbeat(directory));
});

export const install = Effect.fn("PluginPackage.install")(function* (
	target: Fetchable,
	cache: string,
	home: string,
	runner?: Runner,
) {
	const failure = (cause: unknown): InstallError | StoreError =>
		Schema.is(InstallError)(cause) || Schema.is(StoreError)(cause)
			? cause
			: new InstallError({
					reason: "plugin-fetch-failed",
					reference: target.spec,
					message: `cannot install ${target.spec}`,
					cause,
				});

	return yield* Effect.gen(function* () {
		const { root, key, directory, marker } = yield* location(target, cache);
		yield* fs.makeDirectory(root, { recursive: true });
		// A published entry is immutable, so reading one never contends with an installer.
		// mkdir is atomic across processes; the scoped release also runs on interruption.
		if (!(yield* fs.exists(marker))) yield* lock(target, `${directory}.lock`);
		// Re-check under the lock: the installer we waited for may have just published.
		if (!(yield* fs.exists(marker))) {
			const staging = yield* Effect.acquireRelease(
				fs.makeTempDirectory({ directory: root, prefix: `${key}-` }),
				(staging) => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.orDie),
			);
			yield* fs.writeFileString(path.join(staging, "package.json"), '{"private":true,"type":"module"}');
			const fetched = yield* download(target, staging, home, runner);
			// `resolveModule` realpaths its answer while `makeTempDirectory` does not, so relate
			// the two through the realpath or a symlinked cache root escapes the published entry.
			const entry = path.relative(yield* fs.realPath(staging), fetched.entrypoint);
			if (entry.startsWith("..") || path.isAbsolute(entry)) {
				return yield* new InstallError({
					reason: "plugin-no-entrypoint",
					reference: target.spec,
					message: `entrypoint escapes its installation: ${entry}`,
				});
			}
			yield* fs.writeFileString(
				path.join(staging, ".complete.json"),
				yield* Schema.encodeEffect(Schema.fromJsonString(Cached))({
					spec: target.spec,
					...(fetched.version === undefined ? {} : { version: fetched.version }),
					...(fetched.revision === undefined ? {} : { revision: fetched.revision }),
					entrypoint: entry,
				}),
			);
			if (yield* fs.exists(directory)) yield* fs.remove(directory, { recursive: true });
			yield* fs.rename(staging, directory);
		}
		return yield* readPublished(target, directory, marker);
	}).pipe(Effect.scoped, Effect.mapError(failure));
});

export * as PluginPackage from "./package.ts";
