/*
 * @file Domain 2: the store. Owns the disk, never opens a socket.
 *
 * ```
 * <cache>/plugins/v1/
 *   index.json                          an accelerator, never the truth
 *   <slug>/                             readable: acme-codework-tool-proc, or a git slug
 *     <digest>/                         sha256 of the canonical spec, full 64 hex
 *       .lock/                          atomic mkdir + mtime heartbeat
 *       .staging-<startedAt>-<uuid>/    in flight; never resolvable
 *       <generation>/                   monotonic ms timestamp
 *         .complete.json                a generation exists iff this is present
 * ```
 *
 * **One store, and nothing is ever written into a project.** The version-skew worry does not
 * apply, because identity is the canonical spec: `@acme/x@^1` and `@acme/x@2.0.0` are two entries
 * side by side. What the second root would have bought is duplication, and duplication was the
 * argument for sharing in the first place. What dropping it removes: a lookup order, a `root`
 * parameter every method would have to be told, a cache inside a repository, and a per-project
 * reinstall of a plugin ten projects share.
 *
 * `v1` lets the layout change by writing to `v2` rather than migrating; a miss costs one reinstall.
 *
 * **A generation is immutable.** Installing never mutates a published one: it stages elsewhere and
 * renames into place. Three problems that solves, and nothing simpler solves all three -- a
 * running exchange holding file URLs into generation *N* is not disturbed by *N+1*; Node's ESM
 * registry is keyed by URL and never evicts, so an in-place update would hand back the *old*
 * module on re-import; and rollback is a `rename`, because a generation that fails validation
 * never gets a marker.
 */

import { Effect, Encoding, Option, Schema } from "effect";
import { crypto, fileSystem as fs, hostPath as path } from "../host.ts";
import { InstallError, StoreError } from "./error.ts";
import { download, type Fetched, type Runner, url } from "./npm.ts";
import { canonical, type Fetchable, type Target } from "./source.ts";
import { PluginIndex } from "./index.store.ts";
import { lock } from "./lock.ts";

/** Facts about the *package*, and nothing about the plugin inside it. */
export const Marker = Schema.Struct({
	spec: Schema.String,
	name: Schema.String,
	version: Schema.optional(Schema.String),
	revision: Schema.optional(Schema.String),
	/** Relative to the generation directory, so the marker survives the publishing rename. */
	entrypoint: Schema.String,
	createdAt: Schema.Finite,
});
export type Marker = typeof Marker.Type;

const MARKER = ".complete.json";
const STAGING = ".staging-";

/** What `resolve` and `add` hand back: a marker, plus where it was found. */
export interface Entry extends Marker {
	readonly digest: string;
	readonly generation: number;
	readonly directory: string;
	/** A `file:` URL for the entrypoint, ready to import. */
	readonly url: string;
}

export const root = (cache: string) => path.join(cache, "plugins", "v1");

/**
 * A readable label, never an identity: two specs that slug alike share a parent directory and
 * nothing more. Worth having because a greppable path is worth real money when debugging, and a
 * bare hash throws away every clue.
 */
const slugOf = (target: Fetchable): string =>
	target.kind === "git"
		? target.slug
		: canonical(target)
				.replace(/^@/, "")
				.replace(/[^a-zA-Z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "") || "package";

/**
 * The **full** SHA-256 of the canonical spec.
 *
 * Not truncated. The fast path proves a hit by checking that a marker *exists* rather than by
 * decoding it, and the index is keyed by digest alone, so a truncated digest would let a collision
 * return the wrong package silently.
 */
export const digest = Effect.fn("PluginStore.digest")(function* (target: Fetchable) {
	return Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(target.spec)));
});

const entryDir = Effect.fn("PluginStore.entryDir")(function* (target: Fetchable, cache: string) {
	const key = yield* digest(target);
	return { key, directory: path.join(root(cache), slugOf(target), key) };
});

const failure = (target: Fetchable, reason: StoreError["reason"], message: string, cause?: unknown) =>
	new StoreError({ reason, reference: target.spec, message, ...(cause === undefined ? {} : { cause }) });

/** Generation directories, oldest first. A name that is not a number is not a generation. */
const generations = Effect.fn("PluginStore.generations")(function* (directory: string) {
	const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
	return names
		.filter((name) => /^\d+$/.test(name))
		.map((name) => Number(name))
		.sort((left, right) => left - right);
});

const readMarker = (directory: string) =>
	fs
		.readFileString(path.join(directory, MARKER))
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Marker))), Effect.option);

const entryOf = (marker: Marker, input: { digest: string; generation: number; directory: string }): Entry => ({
	...marker,
	digest: input.digest,
	generation: input.generation,
	directory: input.directory,
	url: url(path.resolve(input.directory, marker.entrypoint)),
});

/** The newest generation that carries a marker. Unmarked ones are invisible: they never happened. */
const active = Effect.fn("PluginStore.active")(function* (directory: string, key: string) {
	for (const generation of (yield* generations(directory)).reverse()) {
		const where = path.join(directory, String(generation));
		const marker = yield* readMarker(where);
		if (Option.isSome(marker)) return entryOf(marker.value, { digest: key, generation, directory: where });
	}
	return undefined;
});

/** What the index files about an entry, all of it derivable from the spec and the marker. */
const record = (target: Fetchable, entry: Entry, installedAt: number): PluginIndex.Record_ => ({
	spec: target.spec,
	source: target.kind,
	name: entry.name,
	slug: slugOf(target),
	mutable: target.mutable,
	generation: entry.generation,
	...(entry.version === undefined ? {} : { version: entry.version }),
	...(entry.revision === undefined ? {} : { revision: entry.revision }),
	entrypoint: entry.entrypoint,
	installedAt,
});

/**
 * Disk-only lookup. No network, no install -- this is what boot uses, and the reason booting
 * offline works.
 *
 * The index is consulted first and is only ever a hint: a hit is proved by the marker still
 * existing, and anything else falls through to a scan that repairs the index on the way past.
 */
export const resolve = Effect.fn("PluginStore.resolve")(
	function* (target: Fetchable, cache: string) {
		const { key, directory } = yield* entryDir(target, cache);
		const base = root(cache);

		const hinted = (yield* PluginIndex.read(base)).get(key);
		if (hinted !== undefined) {
			const where = path.join(directory, String(hinted.generation));
			const marker = yield* readMarker(where);
			// The index is the hint; the marker is the proof. An index that disagrees with disk loses,
			// which is what makes deleting index.json always safe.
			if (Option.isSome(marker)) {
				return entryOf(marker.value, { digest: key, generation: hinted.generation, directory: where });
			}
		}

		const scanned = yield* active(directory, key);
		if (scanned === undefined) return undefined;
		// Rebuilt from the marker, which is why that file carries the artifact's facts rather than a
		// bare flag: the marker is the truth an index is derived from.
		yield* PluginIndex.put(base, key, record(target, scanned, scanned.createdAt));
		return scanned;
	},
	// A lookup answers "what is filed", so a filesystem it cannot read is the store being damaged
	// rather than a failure of whatever asked.
	Effect.mapError((cause) =>
		Schema.is(StoreError)(cause)
			? cause
			: new StoreError({
					reason: "plugin-marker-invalid",
					reference: "",
					message: "cannot read the plugin store",
					cause,
				}),
	),
);

/**
 * `resolve`, for a caller that needs the entry rather than an answer about it.
 *
 * `plugin remove` uses this as its installer: it has to identify what an entry names without
 * fetching anything, and a spec with nothing filed is a real answer there -- the command reports
 * it and moves on.
 */
export const required = Effect.fn("PluginStore.required")(function* (target: Fetchable, cache: string) {
	const found = yield* resolve(target, cache);
	if (found === undefined) {
		return yield* failure(target, "plugin-not-installed", `${target.spec} is not installed`);
	}
	return found;
});

/**
 * What a caller may do with a staged artifact before it is published.
 *
 * Supplied by the caller, so the store stays ignorant of plugins: it knows only that what was
 * fetched may be rejected. Whatever the check learns rides back to the caller and is never filed
 * (a marker holding `id: "acme.tool.proc"` would make the on-disk format encode the result of
 * executing code the store should be indifferent to).
 */
export type Validate<A> = (fetched: Fetched) => Effect.Effect<A, InstallError>;

export interface Added<A> {
	readonly entry: Entry;
	/** Absent when the entry came back from the fast path, because nothing was staged to check. */
	readonly validated?: A;
}

/**
 * Install if absent; hand back what is filed if present.
 *
 * `refresh` forces past both the fast path and the double-check, which is what `update` needs and
 * nothing else should use.
 */
export const add = Effect.fn("PluginStore.add")(function* <A>(
	target: Fetchable,
	cache: string,
	options: { readonly refresh?: boolean; readonly validate: Validate<A>; readonly runner?: Runner },
) {
	return yield* Effect.gen(function* () {
		const { key, directory } = yield* entryDir(target, cache);

		// ── Fast path: no lock, no network, no staging. The common case. ──
		if (options.refresh !== true) {
			const found = yield* resolve(target, cache);
			if (found !== undefined) return { entry: found } satisfies Added<A>;
		}

		yield* fs.makeDirectory(directory, { recursive: true });
		yield* lock(path.join(directory, ".lock"), () =>
			failure(target, "plugin-lock-timeout", `timed out waiting for another installation of ${target.spec}`),
		);

		// Double-check under the lock: another process may have finished while we waited, and the
		// loser of a race must adopt the winner's work rather than install a second copy.
		const current = yield* active(directory, key);
		if (current !== undefined && options.refresh !== true) return { entry: current } satisfies Added<A>;

		// realpath, because arborist keys its lockfile relative to the root's real path -- and
		// because a staging path reached through a symlink comes back with no root edges at all.
		const real = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
		const staging = yield* Effect.acquireRelease(
			fs.makeTempDirectory({ directory: real, prefix: STAGING }),
			(staged) => fs.remove(staged, { recursive: true, force: true }).pipe(Effect.orDie),
		);
		yield* fs.writeFileString(path.join(staging, "package.json"), '{"private":true,"type":"module"}');

		const fetched = yield* download(target, staging, cache, options.runner);

		// Nothing moved. Throw the work away rather than publish a redundant generation, or every
		// update on an unchanged branch grows the store and Node's never-evicting module registry.
		if (current !== undefined && current.revision === fetched.revision) {
			return { entry: current } satisfies Added<A>;
		}

		/*
		 * Validated BEFORE the marker is written, which is what makes "rollback is a rename" true.
		 *
		 * Publishing first and validating afterwards poisons the store: `resolve` returns the
		 * newest *marked* generation, so a broken plugin becomes the answer on every later run,
		 * and re-running `add` hits the fast path and returns it again. The claimed rollback has
		 * nothing to roll back to.
		 */
		const validated = yield* options.validate(fetched);

		const entrypoint = path.relative(yield* fs.realPath(staging), fetched.entrypoint);
		if (entrypoint.startsWith("..") || path.isAbsolute(entrypoint)) {
			return yield* new InstallError({
				reason: "plugin-no-entrypoint",
				reference: target.spec,
				message: `entrypoint escapes its installation: ${entrypoint}`,
			});
		}

		const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		const marker: Marker = {
			spec: target.spec,
			name: fetched.name,
			...(fetched.version === undefined ? {} : { version: fetched.version }),
			...(fetched.revision === undefined ? {} : { revision: fetched.revision }),
			entrypoint,
			createdAt: now,
		};
		yield* fs.writeFileString(
			path.join(staging, MARKER),
			yield* Schema.encodeEffect(Schema.fromJsonString(Marker))(marker),
		);

		// Monotonic even when the clock is not: a generation must never reuse or precede a number
		// already on disk, because `resolve` reads the highest one.
		const previous = (yield* generations(directory)).at(-1) ?? 0;
		const generation = Math.max(now, previous + 1);
		const published = path.join(directory, String(generation));
		// One syscall, and the only moment this entry changes.
		yield* fs.rename(staging, published);

		const entry = entryOf(marker, { digest: key, generation, directory: published });
		yield* PluginIndex.put(root(cache), key, record(target, entry, now));
		yield* collect(directory);
		return { entry, validated } satisfies Added<A>;
	}).pipe(
		Effect.scoped,
		// Everything the filesystem or a decoder can raise becomes the store's own failure here,
		// so a caller sees two kinds of error -- "could not fetch" and "the store is damaged" --
		// rather than every platform error this file can touch.
		Effect.mapError((cause) =>
			Schema.is(InstallError)(cause) || Schema.is(StoreError)(cause)
				? cause
				: failure(target, "plugin-marker-invalid", `cannot write the store entry for ${target.spec}`, cause),
		),
	);
});

/**
 * Expire what is superseded.
 *
 * The two newest generations are kept regardless of age: the newest is live, and the one before it
 * may still be imported by an exchange in flight. Runs at the end of an `add` that published
 * something -- no timer and no sweeper, because installs are the only thing that creates garbage.
 */
export const collect = Effect.fn("PluginStore.collect")(function* (directory: string) {
	const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
	const keep = new Set((yield* generations(directory)).slice(-2).map(String));
	const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
	for (const name of names) {
		if (keep.has(name) || name === ".lock") continue;
		if (name.startsWith(STAGING)) {
			// A staging directory this old belongs to an installer that crashed.
			const started = yield* fs.stat(path.join(directory, name)).pipe(Effect.option);
			const age = Option.isNone(started)
				? 0
				: Option.match(started.value.mtime, { onNone: () => 0, onSome: (at) => now - at.getTime() });
			if (age > HOUR)
				yield* fs.remove(path.join(directory, name), { recursive: true, force: true }).pipe(Effect.ignore);
			continue;
		}
		if (!/^\d+$/.test(name)) continue;
		if (now - Number(name) > WEEK) {
			yield* fs.remove(path.join(directory, name), { recursive: true, force: true }).pipe(Effect.ignore);
		}
	}
});

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

/**
 * Drop a store entry entirely.
 *
 * Nothing in the CLI calls this: `plugin remove` deletes a settings entry and leaves the bytes
 * alone, so removing a plugin today and adding it back tomorrow costs nothing.
 */
export const remove = Effect.fn("PluginStore.remove")(function* (target: Fetchable, cache: string) {
	const { key, directory } = yield* entryDir(target, cache);
	const existed = yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false));
	yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
	yield* PluginIndex.drop(root(cache), key);
	return existed;
});

/** Every entry on disk, for `plugin list`. Scans, because the truth is the markers. */
export const all = Effect.fn("PluginStore.all")(function* (cache: string) {
	const base = root(cache);
	const slugs = yield* fs.readDirectory(base).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
	const found: Entry[] = [];
	for (const slug of slugs) {
		const digests = yield* fs
			.readDirectory(path.join(base, slug))
			.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
		for (const key of digests) {
			const entry = yield* active(path.join(base, slug, key), key);
			if (entry !== undefined) found.push(entry);
		}
	}
	return found as ReadonlyArray<Entry>;
});

export type { Target };
export * as PluginStore from "./store.ts";
