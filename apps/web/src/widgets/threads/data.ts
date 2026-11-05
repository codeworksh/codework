import {
	type AllThreads,
	type Grouping,
	type ListedThread,
	PERSONAL_ORGANIZATION,
	type Position,
	readTopics,
	SyncChanged,
	syncTopics,
	type ThreadList,
	type ThreadsBy,
} from "@codeworksh/contract";
import type { Event } from "@codeworksh/widget/event";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { Server } from "../../kernel/rpc";

const decodeChanged = Schema.decodeUnknownOption(SyncChanged);

/** Whether an event changes what the list shows: a thread, its project, a removed session, or any desktop edit. */
const touches = (event: Event) =>
	event.topic !== syncTopics.changed ||
	Option.exists(
		decodeChanged(event.payload),
		(notice) => notice.thread.length + notice.project.length + notice.removed.length > 0,
	);

/** The organization's threads split by `by`: read when subscribed, and again after each change to them. */
export const threadsAtom = Atom.family((by: ThreadsBy) =>
	Server.runtime.atom(
		Stream.unwrap(
			Server.use((client) =>
				Effect.succeed(
					client("event.subscribe", { topics: readTopics.threads }).pipe(
						// `Synced` first, once subscribed: the first read can miss no change.
						Stream.filter((item) => "_tag" in item || touches(item)),
						Stream.debounce("50 millis"),
						Stream.mapEffect(() => client("threads.list", { organizationId: PERSONAL_ORGANIZATION, by })),
					),
				),
			),
		).pipe(Stream.retry(Schedule.spaced("1 second"))),
	),
);

export const setStatus = Server.mutation("threads.setStatus");
export const setPriority = Server.mutation("threads.setPriority");
export const setGroup = Server.mutation("threads.setGroup");
export const setColor = Server.mutation("threads.setColor");
export const moveThread = Server.mutation("threads.move");
export const createGroup = Server.mutation("groups.create");
export const updateGroup = Server.mutation("groups.update");
export const moveGroup = Server.mutation("groups.move");
export const deleteGroup = Server.mutation("groups.delete");

/** What names a list: its status, priority or group (`none` is ungrouped). */
export const listKey = (list: ThreadList) =>
	list._tag === "Status"
		? list.status
		: list._tag === "Priority"
			? String(list.priority)
			: (list.groupingId ?? "none");

/** Whether `thread` belongs in `list`, by the column the list splits by. */
const holds = (list: ThreadList, thread: ListedThread) =>
	list._tag === "Status"
		? list.status === thread.status
		: list._tag === "Priority"
			? list.priority === thread.priority
			: list.groupingId === thread.groupingId;

/** `all` with one thread changed, each list re-split and in `ordering`: drawn while the writes go out. */
export const patched = (all: AllThreads, threadId: string, patch: Partial<ListedThread>): AllThreads => {
	const thread = all.lists.flatMap((list) => list.threads).find((candidate) => candidate.id === threadId);
	if (thread === undefined) return all;
	const next = { ...thread, ...patch };
	return {
		...all,
		lists: all.lists.map((list) => {
			const threads = list.threads.filter((candidate) => candidate.id !== threadId);
			if (!holds(list, next)) return { ...list, threads };
			return { ...list, threads: [...threads, next].toSorted((a, b) => a.ordering - b.ordering) };
		}),
	};
};

/** Where `to` puts a thread in the whole order, as the server computes it. */
export const orderingAt = (all: ReadonlyArray<ListedThread>, to: Position) => {
	if (to === "first") return (all[0]?.ordering ?? 0) - 1;
	if (to === "last") return (all.at(-1)?.ordering ?? 0) + 1;
	const of = (id: string) => all.find((thread) => thread.id === id)?.ordering ?? 0;
	return (of(to.after) + of(to.before)) / 2;
};

/**
 * Where a thread goes to land at `index` of `list`, both without it. Every view splits one order, so
 * at a list's edge the neighbour beyond is the next thread in the whole order (`all`, in `ordering`,
 * without it too). An empty list needs no move.
 */
export const threadPosition = (
	all: ReadonlyArray<ListedThread>,
	list: ReadonlyArray<ListedThread>,
	index: number,
): Position | undefined => {
	const after = list[index - 1];
	const before = list[index];
	if (after !== undefined && before !== undefined) return { after: after.id, before: before.id };
	if (before !== undefined) {
		const beyond = all[all.findIndex((thread) => thread.id === before.id) - 1];
		return beyond === undefined ? "first" : { after: beyond.id, before: before.id };
	}
	if (after !== undefined) {
		const beyond = all[all.findIndex((thread) => thread.id === after.id) + 1];
		return beyond === undefined ? "last" : { after: after.id, before: beyond.id };
	}
	return undefined;
};

/** Where a group goes to land at `index` of `groups`, without it. */
export const groupPosition = (groups: ReadonlyArray<Grouping>, index: number): Position => {
	const after = groups[index - 1];
	const before = groups[index];
	if (after !== undefined && before !== undefined) return { after: after.id, before: before.id };
	return before !== undefined ? "first" : "last";
};
