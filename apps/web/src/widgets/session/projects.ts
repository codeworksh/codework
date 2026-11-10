import { useAtomValue } from "@effect/atom-react";
import {
	PERSONAL_ORGANIZATION,
	readTopics,
	type SidebarProject,
	type SidebarSession,
	SyncChanged,
	SyncTracking,
	syncTopics,
} from "@codeworksh/contract";
import type { RunState } from "@codeworksh/widget/codework";
import type { Event } from "@codeworksh/widget/event";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { keeper } from "../../kernel/keep";
import { Server } from "../../kernel/rpc";

const decodeChanged = Schema.decodeUnknownOption(SyncChanged);
const decodeTracking = Schema.decodeUnknownOption(SyncTracking);

/** Whether an event changes what the sidebar shows: an index row, a removed session, a session's color, or a thread's status or priority. */
const touches = (event: Event) =>
	event.topic === syncTopics.status ||
	(event.topic === syncTopics.changed
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
		: Option.exists(
				decodeTracking(event.payload),
				(edit) => edit._tag === "Session" || (edit._tag === "Thread" && edit.priority !== undefined),
			));

const sameSession = (a: SidebarSession, b: SidebarSession) =>
	a.title === b.title &&
	a.runState === b.runState &&
	a.status === b.status &&
	a.priority === b.priority &&
	a.updated === b.updated &&
	a.color === b.color &&
	a.path === b.path &&
	a.threadId === b.threadId &&
	a.spaceKind === b.spaceKind &&
	a.model?.provider === b.model?.provider &&
	a.model?.id === b.model?.id;

/** `next` with every session that did not change kept as the object `previous` had, so its sidebar row skips rendering. */
const reuse = (previous: ReadonlyArray<SidebarProject> | undefined, next: ReadonlyArray<SidebarProject>) => {
	if (previous === undefined) return next;
	const session = keeper(
		previous.flatMap((project) => project.sessions),
		(item) => item.id,
		sameSession,
	);
	return next.map((project) => ({ ...project, sessions: project.sessions.map(session) }));
};

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
						Stream.mapAccum(
							(): ReadonlyArray<SidebarProject> | undefined => undefined,
							(previous, next) => {
								const kept = reuse(previous, next);
								return [kept, [kept]] as const;
							},
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

/** Each session's main thread's run state, as synced. */
const mainRunStatesAtom = Atom.make((get) => {
	const result = get(projectsAtom);
	if (!AsyncResult.isSuccess(result)) return new Map<string, RunState>();
	return new Map(
		result.value.flatMap((project) => project.sessions.map((session) => [session.id, session.runState] as const)),
	);
});

/** The run state of a thread other than its session's main one: its own synced row, read again as it changes. */
const threadRunStateAtom = Atom.family((key: string) => {
	const [sessionId = "", threadId = ""] = key.split("/");
	return Server.runtime.atom(
		Stream.unwrap(
			Server.use((client) =>
				Effect.succeed(
					client("event.subscribe", { topics: [syncTopics.changed] }).pipe(
						Stream.filter(
							(item) =>
								"_tag" in item ||
								Option.exists(decodeChanged(item.payload), (notice) => notice.thread.includes(threadId)),
						),
						Stream.mapEffect(() =>
							client("threads.line", { sessionId, threadId, limit: 0 }).pipe(
								Effect.map((line) => line.thread.runState),
								Effect.orElseSucceed((): RunState => "idle"),
							),
						),
						Stream.changes,
					),
				),
			),
		).pipe(Stream.retry(Schedule.spaced("1 second"))),
	);
});

/**
 * The run state of each thread named by these {@link threadKey}s, one per line: a main thread as
 * the sidebar has it, any other by its own row; idle until read.
 */
export const runStatesAtom = Atom.family((keys: string) =>
	Atom.make((get) => {
		const mains = get(mainRunStatesAtom);
		return new Map(
			keys
				.split("\n")
				.filter((key) => key !== "")
				.map((key): [string, RunState] => {
					if (!key.includes("/")) return [key, mains.get(key) ?? "idle"];
					const thread = get(threadRunStateAtom(key));
					return [key, AsyncResult.isSuccess(thread) ? thread.value : "idle"];
				}),
		);
	}),
);

interface Listed {
	readonly title: string;
	readonly project: { readonly id: string; readonly name: string };
}

const sameListed = (a: Listed, b: Listed) =>
	a.title === b.title && a.project.id === b.project.id && a.project.name === b.project.name;

const listedAtom = Atom.family((id: string) =>
	Atom.make((get): Listed | undefined => {
		const result = get(projectsAtom);
		if (!AsyncResult.isSuccess(result)) return undefined;
		for (const project of result.value) {
			const session = project.sessions.find((candidate) => candidate.id === id);
			if (session === undefined) continue;
			const next = { title: session.title, project: { id: project.id, name: project.name } };
			// The sidebar reads again on any session's change; an unchanged answer keeps its object, so the
			// session view reading it renders only for its own session's title or project.
			const previous = Option.getOrUndefined(get.self<Listed | undefined>());
			return previous !== undefined && sameListed(previous, next) ? previous : next;
		}
		return undefined;
	}),
);

/** What the list already says about a session: its title and project name, before it is loaded. */
export const useListedSession = (id: string) => useAtomValue(listedAtom(id));
