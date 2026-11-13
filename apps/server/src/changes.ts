import {
	type ChangesSpace,
	ChangesError,
	type CodeworkUnavailable,
	SpaceChanges,
	SpaceDiff,
	type SpaceThread,
} from "@codeworksh/contract";
import { Codework as Client } from "@codeworksh/widget/backend";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Codework } from "./codework.ts";
import { Reads } from "./reads.ts";

// The daemon's Status event as it came: its `spaceId` is dropped, being the row's key.
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(SpaceChanges));
const decodeDiff = Schema.decodeUnknownEffect(SpaceDiff);

/** A space's changes as its git daemon last published them, mirrored from CodeWork's event stream. */
export const status = Effect.fn("Changes.status")(function* (input: {
	readonly machineId: string;
	readonly spaceId: string;
}) {
	const sql = yield* SqlClient.SqlClient;
	const [row] = yield* sql<{ data: string }>`
		SELECT data FROM machine_space_state
		WHERE machine_id = ${input.machineId} AND space_id = ${input.spaceId} AND type = 'plugin.git.status'
	`.pipe(Effect.orDie);
	return row === undefined ? null : Option.getOrNull(decodeStored(row.data));
});

/**
 * The space a changes panel shows and the threads working in it, from the app's own rows; a sandbox's
 * driver and status come from the machine's store, which wakes nothing.
 */
export const space = Effect.fn("Changes.space")(function* (
	input: { readonly machineId: string; readonly spaceId: string },
	machine: Effect.Effect<typeof Client.Service, CodeworkUnavailable>,
) {
	const sql = yield* SqlClient.SqlClient;
	const [row] = yield* sql<Pick<ChangesSpace, "location" | "kind"> & { env: string | null }>`
		SELECT location, kind, env FROM space WHERE machine_id = ${input.machineId} AND id = ${input.spaceId}
	`.pipe(Effect.orDie);
	if (row === undefined) return null;
	// Whole sessions, so a fork placed here still reads its title from an ancestor placed elsewhere.
	const rows = yield* sql<{
		id: string;
		sessionId: string;
		originKind: string;
		originThreadId: string | null;
		title: string | null;
		runState: SpaceThread["runState"];
		updatedAt: number;
		slug: string;
		spaceId: string;
	}>`
		SELECT thread.id, thread.session_id, thread.origin_kind, thread.origin_thread_id, thread.title,
			thread.run_state, thread.updated_at, session.slug,
			COALESCE(thread.placement_space_id, session.space_id) AS space_id
		FROM thread JOIN session ON session.id = thread.session_id
		WHERE session.machine_id = ${input.machineId} AND session.deleted_at IS NULL AND thread.deleted_at IS NULL
			AND thread.session_id IN (
				SELECT placed.session_id FROM thread AS placed JOIN session AS home ON home.id = placed.session_id
				WHERE home.machine_id = ${input.machineId}
					AND COALESCE(placed.placement_space_id, home.space_id) = ${input.spaceId}
			)
		ORDER BY thread.updated_at DESC, thread.id
	`.pipe(Effect.orDie);
	const titleOf = Reads.titles(rows);
	const mains = new Map(
		rows.filter((thread) => thread.originKind === "main").map((thread) => [thread.sessionId, thread]),
	);
	const sandbox =
		row.env === null
			? undefined
			: (yield* machine.pipe(
					Effect.flatMap((client) => client("sandbox.list", {})),
					Effect.timeout("10 seconds"),
					Effect.orElseSucceed(() => []),
				)).find((info) => info.id === row.env);
	return {
		location: row.location,
		kind: row.kind,
		env: row.env === null ? null : sandbox === undefined ? {} : { driver: sandbox.driver, status: sandbox.status },
		threads: rows
			.filter((thread) => thread.spaceId === input.spaceId && thread.originKind !== "subagent")
			.map((thread): SpaceThread => {
				const title = titleOf(thread);
				return {
					id: thread.id,
					sessionId: thread.sessionId,
					main: thread.originKind === "main",
					...(title === undefined ? {} : { title }),
					sessionName: mains.get(thread.sessionId)?.title ?? thread.slug,
					runState: thread.runState,
					updatedAt: thread.updatedAt,
				};
			}),
	} satisfies ChangesSpace;
});

/** A space's patches from its git daemon, over the connection to the space's machine. */
export const diff = Effect.fn("Changes.diff")(function* (
	input: { readonly spaceId: string; readonly files?: ReadonlyArray<string> | undefined },
	machine: Effect.Effect<typeof Client.Service, CodeworkUnavailable>,
) {
	const client = yield* machine;
	const reply = yield* Codework.call(
		(rpc) =>
			rpc("daemon.call", {
				plugin: "git",
				spaceId: input.spaceId,
				method: "diff",
				input: input.files === undefined ? {} : { files: input.files },
			}).pipe(
				Effect.map((output) => ({ output })),
				Effect.catchTag("DaemonCallError", (error) => Effect.succeed({ failed: error })),
			),
		// Past the daemon's own 60-second budget, so its failure is the one that shows.
		{ timeout: "70 seconds" },
	).pipe(Effect.provideService(Client, client));
	if ("failed" in reply) {
		const { reason, message } = reply.failed;
		return yield* new ChangesError({
			reason: reason === "unavailable" || reason === "detached" ? reason : "failed",
			message,
		});
	}
	return yield* decodeDiff(reply.output).pipe(
		Effect.mapError((error) => new ChangesError({ reason: "failed", message: error.message })),
	);
});

export * as Changes from "./changes.ts";
