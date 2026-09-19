/*
 * @file `index.json`: one read into a Map, and never the truth.
 *
 * Two rules keep it from becoming a new class of bug:
 *
 * 1. **Disk is truth; this is an accelerator.** Every hit is confirmed by the generation's marker
 *    still existing. A miss, a mismatch, or an unreadable file falls back to scanning and rewrites
 *    it. Deleting `index.json` must always be safe, and this is what makes that true.
 * 2. **Writes are unlocked, and that is safe because of rule 1.** Two processes writing at once
 *    both read the whole file and both rewrite it, so one update is lost and a record added in
 *    between can vanish. Neither matters: a lost `checkedAt` costs one network call, and a
 *    vanished record is a miss that a scan repairs. Locking these would buy nothing the marker
 *    does not already guarantee.
 *
 * Nothing here describes the plugin inside the package -- no `id`, no `kind`, no exported shape.
 * Every field is the spec, or something `package.json` and the lockfile said, or a timestamp: the
 * same class of fact npm records. A package manager reads manifests; it does not run code to learn
 * about a package.
 *
 * Speed alone would not justify a file at tens of entries. What does: `list` answers "what do I
 * have" without importing a module, and the staleness fields **persist across processes**, which
 * an in-memory cache cannot do for a command that exits.
 */

import { Effect, Option, Schema } from "effect";
import { fileSystem as fs, hostPath as path } from "../host.ts";

export const Record_ = Schema.Struct({
	// What was asked for.
	spec: Schema.String,
	source: Schema.Literals(["registry", "git"]),
	name: Schema.String,
	slug: Schema.String,
	mutable: Schema.Boolean,

	// What is on disk.
	generation: Schema.Finite,
	version: Schema.optional(Schema.String),
	revision: Schema.optional(Schema.String),
	entrypoint: Schema.String,
	installedAt: Schema.Finite,

	// A cache of the last network answer, and the only disposable part of a record: a rebuild
	// resets it to "never checked", which costs one call on the next check.
	checkedAt: Schema.optional(Schema.Finite),
	outdated: Schema.optional(Schema.Boolean),
});
export type Record_ = typeof Record_.Type;

const File = Schema.Struct({
	version: Schema.Finite,
	entries: Schema.Record(Schema.String, Record_),
});

const VERSION = 1;
const NAME = "index.json";

/**
 * Read the whole file, or start empty.
 *
 * An unreadable or unparseable index is not an error: it is a cold cache. Failing here would make
 * a corrupt accelerator break installs that do not need it.
 */
export const read = Effect.fn("PluginIndex.read")(function* (root: string) {
	const parsed = yield* fs
		.readFileString(path.join(root, NAME))
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(File))), Effect.option);
	if (Option.isNone(parsed) || parsed.value.version !== VERSION) return new Map<string, Record_>();
	return new Map(Object.entries(parsed.value.entries));
});

/** Temp file plus rename, so a reader never sees a half-written index. */
const write = Effect.fn("PluginIndex.write")(function* (root: string, entries: Map<string, Record_>) {
	const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(File))({
		version: VERSION,
		entries: Object.fromEntries(entries),
	});
	yield* fs.makeDirectory(root, { recursive: true });
	const temporary = yield* fs.makeTempFile({ directory: root, prefix: `.${NAME}.`, suffix: ".tmp" });
	yield* fs
		.writeFileString(temporary, encoded)
		.pipe(
			Effect.andThen(fs.rename(temporary, path.join(root, NAME))),
			Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
		);
});

/**
 * Record one entry, keeping whatever else the file holds.
 *
 * Ignores its own failures. A store that cannot write its accelerator still works; refusing the
 * install would be the accelerator deciding whether the install counted.
 */
export const put = Effect.fn("PluginIndex.put")(function* (root: string, digest: string, record: Record_) {
	const entries = yield* read(root);
	entries.set(digest, record);
	yield* write(root, entries).pipe(Effect.ignore);
});

/** Forget one entry, for a store entry that has been removed. */
export const drop = Effect.fn("PluginIndex.drop")(function* (root: string, digest: string) {
	const entries = yield* read(root);
	if (!entries.delete(digest)) return;
	yield* write(root, entries).pipe(Effect.ignore);
});

export * as PluginIndex from "./index.store.ts";
