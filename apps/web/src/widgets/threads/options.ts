import {
	type AllThreads,
	type ListedThread,
	Priority,
	type ThreadList,
	type ThreadsBy,
	ThreadStatus,
} from "@codeworksh/contract";
import { useKv } from "@codeworksh/widget/view";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

/** How the view is drawn, per instance: its sections, their order, and what it filters to. */
export const Options = Schema.Struct({
	group: Schema.Literals(["status", "priority", "grouping", "none"]),
	order: Schema.Literals(["manual", "updated", "priority"]),
	/** Status and priority sections with no thread show too; group sections always do. */
	empty: Schema.Boolean,
	status: Schema.Array(ThreadStatus),
	priority: Schema.Array(Priority),
	machine: Schema.Array(Schema.String),
	text: Schema.String,
});
export type Options = typeof Options.Type;

const DEFAULTS: Options = {
	group: "status",
	order: "manual",
	empty: false,
	status: [],
	priority: [],
	machine: [],
	text: "",
};

const decode = Schema.decodeUnknownOption(Options);
const optionsKey = (instanceId: string) => `widget/${instanceId}/display`;

/** The instance's options, read from kv once and written back shortly after each change. */
export function useOptions(instanceId: string) {
	const kv = useKv();
	const [options, setOptions] = useState<Options>(DEFAULTS);
	const loaded = useRef(false);
	useEffect(() => {
		let active = true;
		void kv.get(optionsKey(instanceId)).then((saved) => {
			if (!active) return;
			const value = decode(saved);
			if (value._tag === "Some") setOptions(value.value);
			loaded.current = true;
		});
		return () => {
			active = false;
		};
	}, [kv, instanceId]);
	useEffect(() => {
		if (!loaded.current) return;
		const timer = setTimeout(() => void kv.set(optionsKey(instanceId), Schema.encodeSync(Options)(options)), 300);
		return () => clearTimeout(timer);
	}, [kv, instanceId, options]);
	const change = (patch: Partial<Options>) => setOptions((current) => ({ ...current, ...patch }));
	return [options, change] as const;
}

/** What the server splits by for these options: ungrouped reads any split and joins it. */
export const byOf = (options: Options): ThreadsBy => (options.group === "none" ? "status" : options.group);

/** Whether any filter narrows the list. */
export const filtering = (options: Options) =>
	options.status.length + options.priority.length + options.machine.length > 0 || options.text.trim() !== "";

/** One section as drawn: a list of the split, or the whole list ungrouped. */
export interface Section {
	readonly key: string;
	readonly list: ThreadList | undefined;
	readonly threads: ReadonlyArray<ListedThread>;
}

/** Urgent first, none last, as Linear. */
export const priorityRank = (priority: Priority) => (priority === 0 ? 5 : priority);

const compare: Record<Options["order"], (a: ListedThread, b: ListedThread) => number> = {
	manual: (a, b) => a.ordering - b.ordering,
	updated: (a, b) => b.updatedAt - a.updatedAt,
	priority: (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.ordering - b.ordering,
};

/** `all` as the view draws it: filtered, split into sections, each in the chosen order. */
export const sections = (all: AllThreads, options: Options, keyOf: (list: ThreadList) => string): Section[] => {
	const text = options.text.trim().toLowerCase();
	const keep = (thread: ListedThread) =>
		(options.status.length === 0 || options.status.includes(thread.status)) &&
		(options.priority.length === 0 || options.priority.includes(thread.priority)) &&
		(options.machine.length === 0 || options.machine.includes(thread.machine.id)) &&
		(text === "" || thread.title.toLowerCase().includes(text));
	const shape = (threads: ReadonlyArray<ListedThread>) => threads.filter(keep).toSorted(compare[options.order]);
	if (options.group === "none")
		return [{ key: "all", list: undefined, threads: shape(all.lists.flatMap((list) => list.threads)) }];
	return all.lists
		.map((list) => ({ key: keyOf(list), list, threads: shape(list.threads) }))
		.filter(
			(section) =>
				options.empty ||
				section.threads.length > 0 ||
				(section.list._tag === "Grouping" && section.list.groupingId !== null),
		);
};
