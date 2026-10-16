import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Codework } from "./codework.ts";
import { Contract, type Project } from "./contract.ts";
import { Db } from "./db.ts";
import { Event } from "./event.ts";
import { Workspaces } from "./workspaces.ts";

const decodeJson = Schema.decodeUnknownEffect(Db.JsonText);
const encodeJson = Schema.encodeEffect(Db.JsonText);

/**
 * Sessions grouped by project, both newest first. A session whose project row is missing gets a
 * group of its own folder, so it still shows rather than vanishing.
 */
const byProject = (sessions: ReadonlyArray<Codework.SessionInfo>): Project[] => {
	const groups = new Map<string, Project & { sessions: Project["sessions"][number][] }>();
	for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
		const folder = session.hostDir ?? session.directory;
		const key = session.project?.id ?? folder;
		const group = groups.get(key) ?? {
			id: key,
			name: session.project?.name ?? folder.split("/").at(-1) ?? folder,
			// The newest session's folder: where the project was last worked on.
			path: folder,
			sessions: [],
		};
		group.sessions.push({
			id: session.id,
			title: session.title,
			updated: session.updatedAt,
			...(session.model === undefined ? {} : { model: session.model }),
		});
		groups.set(key, group);
	}
	return [...groups.values()];
};

export const layer = Contract.Api.toLayer(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const workspaces = yield* Workspaces.handlers;
		const events = yield* Event.Service;

		return Contract.Api.of({
			...workspaces,

			"projects.list": Effect.fn("projects.list")(function* () {
				const sessions = yield* Codework.call((client) => client["session.list"]({}));
				return byProject(sessions);
			}),

			"sessions.get": Effect.fn("sessions.get")(function* ({ id }) {
				// A missing session is an answer, not an outage, so it is caught before `call` sees it.
				const found = yield* Codework.call((client) =>
					Effect.all({
						info: client["session.info"]({ sessionId: id }),
						history: client["session.history"]({ sessionId: id }),
					}).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(undefined))),
				);
				if (found === undefined) return yield* new Contract.SessionNotFound({ id });
				const { info, history } = found;
				return {
					id: info.id,
					title: info.title,
					updated: info.updatedAt,
					...(info.model === undefined ? {} : { model: info.model }),
					...(info.project === undefined ? {} : { project: info.project }),
					entries: history.entries,
				};
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

			"event.publish": (input) => events.publish(input),
			"event.subscribe": (input) => events.subscribe(input),
		});
	}),
);

export * as Handlers from "./handlers.ts";
