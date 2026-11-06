import {
	type DashboardBy,
	type DashboardList,
	type DashboardThread,
	type Grouping,
	PERSONAL_ORGANIZATION,
	type Position,
	readTopics,
	SyncChanged,
	syncTopics,
} from "@codeworksh/contract";
import type { Event } from "@codeworksh/widget/event";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { Server } from "../../kernel/rpc";

const decodeChanged = Schema.decodeUnknownOption(SyncChanged);

/** Whether an event changes what the dashboard shows: a thread, its project, a removed session, or any desktop edit. */
const touches = (event: Event) =>
	event.topic !== syncTopics.changed ||
	Option.exists(
		decodeChanged(event.payload),
		(notice) => notice.thread.length + notice.project.length + notice.removed.length > 0,
	);

/** The organization's threads split by `by`: read when subscribed, and again after each change to them. */
export const dashboardAtom = Atom.family((by: DashboardBy) =>
	Server.runtime.atom(
		Stream.unwrap(
			Server.use((client) =>
				Effect.succeed(
					client("event.subscribe", { topics: readTopics.dashboard }).pipe(
						// `Synced` first, once subscribed: the first read can miss no change.
						Stream.filter((item) => "_tag" in item || touches(item)),
						Stream.debounce("50 millis"),
						Stream.mapEffect(() => client("dashboard.list", { organizationId: PERSONAL_ORGANIZATION, by })),
					),
				),
			),
		).pipe(Stream.retry(Schedule.spaced("1 second"))),
	),
);

export const setStatus = Server.mutation("threads.setStatus");
export const setPriority = Server.mutation("threads.setPriority");
export const setGroup = Server.mutation("threads.setGroup");
export const moveThread = Server.mutation("threads.move");
export const createGroup = Server.mutation("groups.create");
export const updateGroup = Server.mutation("groups.update");
export const moveGroup = Server.mutation("groups.move");
export const deleteGroup = Server.mutation("groups.delete");

/** What names a list, for drag and drop: its status, priority or group (`none` is ungrouped). */
export const listKey = (list: DashboardList) =>
	list._tag === "Status"
		? list.status
		: list._tag === "Priority"
			? String(list.priority)
			: (list.groupingId ?? "none");

/**
 * Where a thread goes to land at `index` of `list`, both without it. Every view splits one order, so
 * at a list's edge the neighbour beyond is the next thread in the whole order (`all`, in `ordering`,
 * without it too). An empty list needs no move.
 */
export const threadPosition = (
	all: ReadonlyArray<DashboardThread>,
	list: ReadonlyArray<DashboardThread>,
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
