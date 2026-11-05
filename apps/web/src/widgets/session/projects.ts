import { useAtomValue } from "@effect/atom-react";
import { PERSONAL_ORGANIZATION, readTopics, SyncChanged, SyncTracking, syncTopics } from "@codeworksh/contract";
import type { Event } from "@codeworksh/widget/event";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { Server } from "../../kernel/rpc";

const decodeChanged = Schema.decodeUnknownOption(SyncChanged);
const decodeTracking = Schema.decodeUnknownOption(SyncTracking);

/** Whether an event changes what the sidebar shows: an index row, a removed session, or a session's color. */
const touches = (event: Event) =>
	event.topic === syncTopics.changed
		? Option.exists(
				decodeChanged(event.payload),
				(notice) =>
					notice.project.length +
						notice.space.length +
						notice.session.length +
						notice.thread.length +
						notice.removed.length >
					0,
			)
		: Option.exists(decodeTracking(event.payload), (edit) => edit._tag === "Session");

/**
 * Every active project with its sessions, on every machine, as the sidebar lists them: read from the
 * app's synced copy when subscribed, and again after each change to it.
 */
export const projectsAtom = Server.runtime
	.atom(
		Stream.unwrap(
			Server.use((client) =>
				Effect.succeed(
					client("event.subscribe", { topics: readTopics.sidebar }).pipe(
						// `Synced` first, once subscribed: the first read can miss no change.
						Stream.filter((item) => "_tag" in item || touches(item)),
						Stream.debounce("50 millis"),
						Stream.mapEffect(() =>
							client("sidebar.list", { organizationId: PERSONAL_ORGANIZATION, machines: "all" }),
						),
					),
				),
			),
		).pipe(
			// The app server is local, so a dropped stream is only a moment's gap.
			Stream.retry(Schedule.spaced("1 second")),
		),
	)
	.pipe(Atom.keepAlive);

/** The sessions whose main thread has a run going, as synced. */
export const runningAtom = Atom.make((get) => {
	const result = get(projectsAtom);
	if (!AsyncResult.isSuccess(result)) return new Set<string>();
	return new Set(
		result.value.flatMap((project) =>
			project.sessions.flatMap((session) => (session.runState === "idle" ? [] : [session.id])),
		),
	);
});

const listedAtom = Atom.family((id: string) =>
	Atom.make((get) => {
		const result = get(projectsAtom);
		if (!AsyncResult.isSuccess(result)) return undefined;
		for (const project of result.value) {
			const session = project.sessions.find((candidate) => candidate.id === id);
			if (session !== undefined) return { title: session.title, project: { id: project.id, name: project.name } };
		}
		return undefined;
	}),
);

/** What the list already says about a session: its title and project name, before it is loaded. */
export const useListedSession = (id: string) => useAtomValue(listedAtom(id));
