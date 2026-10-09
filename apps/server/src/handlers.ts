import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Contract, type Entry } from "./contract.ts";
import { findSession, projects } from "./mock.ts";

const JsonText = Schema.fromJsonString(Schema.Json);
const decodeJson = Schema.decodeUnknownEffect(JsonText);
const encodeJson = Schema.encodeEffect(JsonText);

// Directories first, then names in natural order, so "file10" follows "file9".
const byKindThenName = (a: Entry, b: Entry) =>
	a.kind === b.kind
		? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
		: a.kind === "directory"
			? -1
			: 1;

export const layer = Contract.Api.toLayer(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const sql = yield* SqlClient.SqlClient;

		return Contract.Api.of({
			"fs.list": Effect.fn("fs.list")(function* ({ path: directory }) {
				const fail = (cause: unknown) => new Contract.FsError({ path: directory, message: String(cause) });
				const names = yield* fs.readDirectory(directory).pipe(Effect.mapError(fail));
				const entries = yield* Effect.forEach(
					names,
					(name) =>
						fs.stat(path.join(directory, name)).pipe(
							Effect.map((info): Entry => ({
								name,
								kind: info.type === "Directory" ? "directory" : "file",
							})),
							// A broken symlink or a file removed mid-listing is skipped, not fatal.
							Effect.option,
						),
					{ concurrency: 32 },
				);
				return entries
					.filter(Option.isSome)
					.map((entry) => entry.value)
					.sort(byKindThenName);
			}),

			"projects.list": () => Effect.succeed(projects),

			"sessions.get": Effect.fn("sessions.get")(function* ({ id }) {
				const session = findSession(id);
				if (session === undefined) return yield* new Contract.SessionNotFound({ id });
				return session;
			}),

			"kv.get": Effect.fn("kv.get")(function* ({ package: pkg, key }) {
				const rows = yield* sql<{ value: string }>`
					SELECT value FROM kv WHERE package = ${pkg} AND key = ${key}
				`.pipe(Effect.orDie);
				const row = rows[0];
				if (row === undefined) return Option.none();
				return Option.some(yield* decodeJson(row.value).pipe(Effect.orDie));
			}),

			"kv.set": Effect.fn("kv.set")(function* ({ package: pkg, key, value }) {
				const text = yield* encodeJson(value).pipe(Effect.orDie);
				const updated = yield* Clock.currentTimeMillis;
				yield* sql`
					INSERT INTO kv (package, key, value, updated) VALUES (${pkg}, ${key}, ${text}, ${updated})
					ON CONFLICT (package, key) DO UPDATE SET value = excluded.value, updated = excluded.updated
				`.pipe(Effect.orDie);
			}),
		});
	}),
);

export * as Handlers from "./handlers.ts";
