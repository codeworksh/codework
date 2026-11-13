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

export type Patches = Atom.Type<ReturnType<typeof diffAtom>>;

/**
 * One file read alone by `[<machine id>/<space id>, file, additions, deletions]`, for a file left out
 * of a space's patches: its entry as read, and whether it came from the patches kept after the last
 * run. The counts are the listed row's, so a row that changes reads again.
 */
export const fileAtom = Atom.family((key: string) => {
	const [space, file] = JSON.parse(key) as [string, string];
	const [machineId = "", spaceId = ""] = space.split("/");
	return Server.runtime
		.atom(
			Server.use((client) => client("changes.diff", { machineId, spaceId, files: [file] })).pipe(
				Effect.map((diff) => ({
					entry: diff.files.find((entry) => entry.file === file),
					cached: diff.cached === true,
				})),
				Effect.result,
			),
		)
		.pipe(Atom.setIdleTTL(IDLE));
});

/** Stands in for a space's patches while its frame is hidden: nothing is read. */
export const hiddenAtom = Atom.make<Patches>(AsyncResult.initial());

/**
 * A space's folder, environment and threads by `<machine id>/<space id>`: read when subscribed, and
 * again after its machine's sync changed the space, a session or thread placed in it, or one not
 * seen before (it may be placed in it).
 */
export const spaceAtom = Atom.family((key: string) => {
	const [machineId = "", spaceId = ""] = key.split("/");
	return Server.runtime
		.atom(
			Stream.unwrap(
				Server.use((client) =>
					Effect.sync(() => {
						const seen = new Set<string>();
						let placed = new Set<string>();
						const concerns = (notice: SyncChanged) => {
							if (notice.machineId !== machineId) return false;
							const ids = [...notice.session, ...notice.thread, ...notice.removed];
							const fresh = ids.filter((id) => !seen.has(id));
							for (const id of fresh) seen.add(id);
							return (
								notice.full ||
								notice.space.includes(spaceId) ||
								fresh.length > 0 ||
								ids.some((id) => placed.has(id))
							);
						};
						return client("event.subscribe", { topics: [syncTopics.changed] }).pipe(
							Stream.filter((item) => "_tag" in item || Option.exists(decodeChanged(item.payload), concerns)),
							// Debounced, but not the first read.
							Stream.switchMap((item) =>
								Stream.fromEffect("_tag" in item ? Effect.void : Effect.sleep("1 second")),
							),
							Stream.mapEffect(() => client("changes.space", { machineId, spaceId })),
							Stream.tap((space) =>
								Effect.sync(() => {
									placed = new Set(space?.threads.flatMap((thread) => [thread.id, thread.sessionId]));
									for (const id of placed) seen.add(id);
								}),
							),
						);
					}),
				),
			).pipe(Stream.retry(Schedule.spaced("1 second"))),
		)
		.pipe(Atom.setIdleTTL(IDLE));
});
