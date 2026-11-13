import { SyncChanged, SyncState, syncTopics } from "@codeworksh/contract";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { Server } from "../../kernel/rpc";

const decodeState = Schema.decodeUnknownOption(SyncState);
const decodeChanged = Schema.decodeUnknownOption(SyncChanged);

/**
 * How long a space's reads outlive their last view: its frame leaves the screen with its workspace,
 * and returning shows what was there at once, still current, instead of loading it again.
 */
const IDLE = "5 minutes";

/**
 * A space's changes by `<machine id>/<space id>`: read when subscribed, and again whenever its git
 * daemon published a new status.
 */
export const statusAtom = Atom.family((key: string) => {
	const [machineId = "", spaceId = ""] = key.split("/");
	return Server.runtime
		.atom(
			Stream.unwrap(
				Server.use((client) =>
					Effect.succeed(
						client("event.subscribe", { topics: [syncTopics.state] }).pipe(
							Stream.filter(
								(item) =>
									"_tag" in item ||
									Option.exists(
										decodeState(item.payload),
										(state) =>
											state.machineId === machineId &&
											state.spaceId === spaceId &&
											state.type === "plugin.git.status",
									),
							),
							Stream.debounce("50 millis"),
							Stream.mapEffect(() => client("changes.status", { machineId, spaceId })),
						),
					),
				),
			).pipe(Stream.retry(Schedule.spaced("1 second"))),
		)
		.pipe(Atom.setIdleTTL(IDLE));
});

/** When the changes were read, while there are any: patches are read again only when it moves. */
const observedAtom = Atom.family((key: string) =>
	Atom.make((get) => {
		const status = Option.getOrUndefined(AsyncResult.value(get(statusAtom(key))));
		return status?.available === true && status.files.length > 0 ? status.observedAt : undefined;
	}),
);

/** A space's patches, all files, as of its latest changes; the last ones stay while the next load. */
export const diffAtom = Atom.family((key: string) => {
	const [machineId = "", spaceId = ""] = key.split("/");
	return Server.runtime
		.atom((get) =>
			get(observedAtom(key)) === undefined
				? Effect.succeed(undefined)
				: Server.use((client) => client("changes.diff", { machineId, spaceId })).pipe(Effect.result),
		)
		.pipe(Atom.setIdleTTL(IDLE));
});

/**
 * A space's folder, environment and threads by `<machine id>/<space id>`: read when subscribed, and
 * again after its machine's sync changes a space, a session or a thread.
 */
export const spaceAtom = Atom.family((key: string) => {
	const [machineId = "", spaceId = ""] = key.split("/");
	return Server.runtime
		.atom(
			Stream.unwrap(
				Server.use((client) =>
					Effect.succeed(
						client("event.subscribe", { topics: [syncTopics.changed] }).pipe(
							Stream.filter(
								(item) =>
									"_tag" in item ||
									Option.exists(
										decodeChanged(item.payload),
										(notice) =>
											notice.machineId === machineId &&
											notice.space.length +
												notice.session.length +
												notice.thread.length +
												notice.removed.length >
												0,
									),
							),
							Stream.debounce("50 millis"),
							Stream.mapEffect(() => client("changes.space", { machineId, spaceId })),
						),
					),
				),
			).pipe(Stream.retry(Schedule.spaced("1 second"))),
		)
		.pipe(Atom.setIdleTTL(IDLE));
});
