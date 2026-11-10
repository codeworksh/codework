import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
	type AllThreads as Board,
	type ListedThread,
	PERSONAL_ORGANIZATION,
	type Priority,
} from "@codeworksh/contract";
import { isMac, openMode, useShell, type WidgetProps } from "@codeworksh/widget/view";
import { AsyncResult } from "effect/reactivity";
import { type DragEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { threadAddress } from "../session/address";
import { failed, refOf } from "./common";
import {
	createGroup,
	groupPosition,
	listKey,
	moveGroup,
	moveThread,
	orderingAt,
	patched,
	setColor,
	setGroup,
	setPriority,
	setStatus,
	threadPosition,
	threadsAtom,
} from "./data";
import { heading, SectionHeader } from "./header";
import { byOf, filtering, type Options, type Section, sections, useOptions } from "./options";
import {
	COLORS,
	Dot,
	isManual,
	MANUAL_STATUSES,
	PRIORITIES,
	PRIORITY,
	PriorityIcon,
	STATUS,
	StatusIcon,
} from "./marks";
import { Picker } from "./picker";
import { PICKER_KEYS, type Picker as Kind, Row, type RowActions } from "./row";
import { Toolbar } from "./toolbar";

/**
 * The organization's threads as a Linear-like list: sections by status, priority or group, each in
 * the chosen order. Dragging a thread moves it in the one manual order, and into the section it is
 * dropped on.
 */
export function AllThreads({ instanceId }: WidgetProps<unknown>) {
	const [options, change] = useOptions(instanceId);
	const result = useAtomValue(threadsAtom(byOf(options)));
	const create = useAtomSet(createGroup, { mode: "promise" });
	const [renaming, setRenaming] = useState<string>();
	// Drawn at once while the writes go out, until the read after them arrives.
	const [optimistic, setOptimistic] = useState<{ readonly base: Board; readonly value: Board }>();
	const board = AsyncResult.isSuccess(result) ? result.value : undefined;
	const shown = board !== undefined && optimistic?.base === board ? optimistic.value : board;
	const drawn = shown === undefined ? [] : sections(shown, options, listKey);
	const machines = [
		...new Map(
			shown?.lists.flatMap((list) => list.threads.map((thread) => [thread.machine.id, thread.machine])),
		).values(),
	];
	const newGroup = () =>
		create({ payload: { organizationId: PERSONAL_ORGANIZATION, name: "Untitled Group" } }).then(
			(group) => setRenaming(group.id),
			failed,
		);

	return (
		<div className="@container flex h-full flex-col">
			<Toolbar
				options={options}
				onChange={change}
				machines={machines}
				count={drawn.reduce((sum, section) => sum + section.threads.length, 0)}
				onNewGroup={() => void newGroup()}
			/>
			{AsyncResult.isFailure(result) && board === undefined ? (
				<p className="p-3 text-ink-muted">Could not load the threads.</p>
			) : shown === undefined ? null : (
				<List
					board={shown}
					sections={drawn}
					options={options}
					showMachine={machines.length > 1}
					onOptimistic={(value) => board !== undefined && setOptimistic(value && { base: board, value })}
					renaming={renaming}
					onRename={setRenaming}
					onRenamed={() => setRenaming(undefined)}
				/>
			)}
		</div>
	);
}

type Drag = { readonly kind: "thread" | "group"; readonly id: string };
/** Where a dragged thread lands: a section, and an index in it (without the thread) when the order is manual. */
type Drop = { readonly key: string; readonly index: number };

function List({
	board,
	sections,
	options,
	showMachine,
	onOptimistic,
	renaming,
	onRename,
	onRenamed,
}: {
	readonly board: Board;
	readonly sections: ReadonlyArray<Section>;
	readonly options: Options;
	readonly showMachine: boolean;
	readonly onOptimistic: (value: Board | undefined) => void;
	readonly renaming: string | undefined;
	readonly onRename: (groupingId: string) => void;
	readonly onRenamed: () => void;
}) {
	const shell = useShell();
	const status = useAtomSet(setStatus, { mode: "promise" });
	const priority = useAtomSet(setPriority, { mode: "promise" });
	const group = useAtomSet(setGroup, { mode: "promise" });
	const move = useAtomSet(moveThread, { mode: "promise" });
	const reorder = useAtomSet(moveGroup, { mode: "promise" });
	const [drag, setDrag] = useState<Drag>();
	const [drop, setDrop] = useState<Drop>();
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [selected, setSelected] = useState<string>();
	const [menu, setMenu] = useState<{ readonly id: string; readonly kind: Kind; readonly anchor: HTMLElement }>();
	const body = useRef<HTMLDivElement>(null);
	const manual = options.order === "manual";
	const groups = new Map(board.groups.map((candidate) => [candidate.id, candidate]));
	const visible = sections.flatMap((section) => (collapsed.has(section.key) ? [] : section.threads));
	/** Every thread in the one manual order, sorted only when a drop needs it. */
	const ordered = () => board.lists.flatMap((list) => list.threads).toSorted((a, b) => a.ordering - b.ordering);

	/** Opens `kind` at its button in the thread's row, or closes it when it is the one open. */
	const openMenu = (id: string, kind: Kind) => {
		setSelected(id);
		if (menu?.id === id && menu.kind === kind) return setMenu(undefined);
		const anchor = body.current?.querySelector<HTMLElement>(
			`[data-thread="${CSS.escape(id)}"] [data-picker="${kind}"]`,
		);
		if (anchor !== null && anchor !== undefined) setMenu({ id, kind, anchor });
	};

	// A row that moved to another section while its picker is open is a new button: follow it, or
	// close when it is gone (filtered out, collapsed).
	useLayoutEffect(() => {
		if (menu === undefined || menu.anchor.isConnected) return;
		const anchor = body.current?.querySelector<HTMLElement>(
			`[data-thread="${CSS.escape(menu.id)}"] [data-picker="${menu.kind}"]`,
		);
		setMenu(anchor === null || anchor === undefined ? undefined : { ...menu, anchor });
	});

	// Every drag ends here, inside the list or out (Escape, a drop elsewhere).
	useEffect(() => {
		const clear = () => {
			setDrag(undefined);
			setDrop(undefined);
		};
		window.addEventListener("dragend", clear);
		return () => window.removeEventListener("dragend", clear);
	}, []);

	// A closed picker hands the keyboard back to the list.
	const hadMenu = useRef(false);
	useEffect(() => {
		if (menu === undefined && hadMenu.current) body.current?.focus();
		hadMenu.current = menu !== undefined;
	}, [menu]);
	useEffect(() => {
		if (selected === undefined) return;
		body.current?.querySelector(`[data-thread="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	const open = (thread: ListedThread, mode: "new" | "replace") => shell.open(threadAddress(refOf(thread)), { mode });

	const keyDown = (event: KeyboardEvent) => {
		if (event.target instanceof HTMLInputElement || event.altKey) return;
		const at = visible.findIndex((thread) => thread.id === selected);
		const step = (by: number) => {
			event.preventDefault();
			const next =
				visible[at === -1 ? (by > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, at + by))];
			if (next !== undefined) setSelected(next.id);
		};
		if (event.key === "ArrowDown" || event.key === "j") return step(1);
		if (event.key === "ArrowUp" || event.key === "k") return step(-1);
		const thread = visible[at];
		if (thread === undefined) return;
		if (event.key === "Enter") {
			event.preventDefault();
			return open(thread, (isMac ? event.metaKey : event.ctrlKey) ? "new" : "replace");
		}
		if (event.key === "Escape") return setSelected(undefined);
		const kind = event.metaKey || event.ctrlKey ? undefined : PICKER_KEYS[event.key.toLowerCase()];
		if (kind !== undefined) {
			event.preventDefault();
			openMenu(thread.id, kind);
		}
	};

	/** Puts the thread in `section`: the setter of the column the view splits by. */
	const assign = (thread: ListedThread, section: Section) => {
		const list = section.list;
		if (list === undefined) return Promise.resolve();
		return list._tag === "Status"
			? isManual(list.status)
				? status({ payload: { threadId: thread.id, status: list.status } })
				: Promise.resolve()
			: list._tag === "Priority"
				? priority({ payload: { threadId: thread.id, priority: list.priority } })
				: group({ payload: { threadId: thread.id, groupingId: list.groupingId } });
	};

	const dropThread = async (target: Section, index: number) => {
		const all = ordered();
		const thread = all.find((candidate) => candidate.id === drag?.id);
		if (thread === undefined) return;
		const source = sections.find((section) => section.threads.some((candidate) => candidate.id === thread.id));
		const same = source?.key === target.key;
		// Enqueued and Working follow the thread's runs, so a drop cannot put a thread there.
		if (!same && target.list?._tag === "Status" && !isManual(target.list.status)) return;
		if (same && (!manual || source.threads.findIndex((candidate) => candidate.id === thread.id) === index)) return;
		const others = all.filter((candidate) => candidate.id !== thread.id);
		const to = manual
			? threadPosition(
					others,
					target.threads.filter((candidate) => candidate.id !== thread.id),
					index,
				)
			: undefined;
		const list = target.list;
		onOptimistic(
			patched(board, thread.id, {
				...(same || list === undefined
					? {}
					: list._tag === "Status"
						? { status: list.status }
						: list._tag === "Priority"
							? { priority: list.priority }
							: { groupingId: list.groupingId }),
				...(to === undefined ? {} : { ordering: orderingAt(others, to) }),
			}),
		);
		try {
			if (!same) await assign(thread, target);
			if (to !== undefined) await move({ payload: { threadId: thread.id, to } });
		} catch (error) {
			onOptimistic(undefined);
			failed(error);
		}
	};

	/** Drops the dragged group above or below the group whose header is under the pointer. */
	const dropGroup = (event: DragEvent, onto: string) => {
		const dragged = drag?.id;
		const others = board.groups.filter((candidate) => candidate.id !== dragged);
		const rect = event.currentTarget.getBoundingClientRect();
		const index =
			others.findIndex((candidate) => candidate.id === onto) + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
		if (
			dragged === undefined ||
			dragged === onto ||
			board.groups.findIndex((candidate) => candidate.id === dragged) === index
		)
			return;
		void reorder({ payload: { groupingId: dragged, to: groupPosition(others, index) } }).catch(failed);
	};

	/** Where a drag over a row of `section` at `at` lands, as an index of the section without the dragged thread. */
	const over = (event: DragEvent, sectionKey: string, at: number) => {
		const section = sections.find((candidate) => candidate.key === sectionKey);
		if (drag?.kind !== "thread" || section === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		const from = section.threads.findIndex((candidate) => candidate.id === drag.id);
		const index = at + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
		const next = { key: section.key, index: from !== -1 && from < index ? index - 1 : index };
		if (drop?.key !== next.key || drop.index !== next.index) setDrop(next);
	};

	const end = () => {
		setDrag(undefined);
		setDrop(undefined);
	};

	// Rows get one actions object for good; it calls this render's handlers, so a memoized row never
	// renders again just for a new closure.
	const latest = useRef({ openMenu, over, open });
	useLayoutEffect(() => {
		latest.current = { openMenu, over, open };
	});
	const actions = useMemo<RowActions>(
		() => ({
			select: (id) => setSelected(id),
			open: (thread, event) => {
				if (event.button <= 1) latest.current.open(thread, openMode(event));
			},
			menu: (id, kind) => latest.current.openMenu(id, kind),
			dragStart: (id) => setDrag({ kind: "thread", id }),
			over: (event, sectionKey, at) => latest.current.over(event, sectionKey, at),
		}),
		[],
	);

	if (
		sections.every((section) => section.threads.length === 0) &&
		!sections.some((section) => section.list?._tag === "Grouping")
	)
		return (
			<p className="p-6 text-center text-xs text-ink-muted">
				{filtering(options) ? "No threads match the filters." : "No threads yet."}
			</p>
		);

	return (
		<div
			ref={body}
			// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the list takes the keyboard, as Linear's does.
			tabIndex={0}
			role="listbox"
			aria-label="Threads"
			aria-activedescendant={selected === undefined ? undefined : `thread-${selected}`}
			onKeyDown={keyDown}
			className="min-h-0 flex-1 overflow-auto pb-3 outline-none"
		>
			{sections.map((section) => {
				const key = section.key;
				const groupId = section.list?._tag === "Grouping" ? section.list.groupingId : null;
				// The dragged thread's index here, found once: each row's place without it follows from it.
				const from =
					drag?.kind === "thread" ? section.threads.findIndex((candidate) => candidate.id === drag.id) : -1;
				const length = from === -1 ? section.threads.length : section.threads.length - 1;
				const isCollapsed = collapsed.has(key);
				const target = drag?.kind === "thread" && drop?.key === key;
				const source = from !== -1;
				// Outside the manual order a drop only moves a thread between sections: the section shows it.
				const highlight = target && !manual && !source;
				return (
					<section
						key={key}
						aria-label={heading(section, groups).name}
						className={highlight ? "bg-ring/10" : undefined}
						onDragOver={(event) => {
							if (drag?.kind !== "thread") return;
							event.preventDefault();
							if (drop?.key !== key) setDrop({ key, index: length });
						}}
						onDrop={(event) => {
							event.preventDefault();
							if (drag?.kind === "thread" && drop?.key === key) void dropThread(section, drop.index);
							end();
						}}
					>
						<SectionHeader
							section={section}
							groups={groups}
							collapsed={isCollapsed}
							onCollapse={() =>
								setCollapsed((current) => {
									const next = new Set(current);
									if (!next.delete(key)) next.add(key);
									return next;
								})
							}
							renaming={renaming}
							onRename={onRename}
							onRenamed={onRenamed}
							onDragStart={() => groupId !== null && setDrag({ kind: "group", id: groupId })}
							onDragOver={(event) => {
								// A thread over the header lands at the top of the section; its drop is the section's.
								if (drag?.kind === "thread") {
									event.preventDefault();
									event.stopPropagation();
									if (drop?.key !== key || drop.index !== 0) setDrop({ key, index: 0 });
									return;
								}
								if (drag?.kind !== "group" || groupId === null) return;
								event.preventDefault();
								event.stopPropagation();
							}}
							onDrop={(event) => {
								if (drag?.kind !== "group" || groupId === null) return;
								event.preventDefault();
								event.stopPropagation();
								dropGroup(event, groupId);
								end();
							}}
						/>
						{!isCollapsed && (
							<ul>
								{section.threads.map((thread, at) => {
									const index = from === -1 || at < from ? at : at === from ? -1 : at - 1;
									return (
										<Row
											key={thread.id}
											thread={thread}
											grouping={thread.groupingId === null ? undefined : groups.get(thread.groupingId)}
											showMachine={showMachine}
											selected={selected === thread.id}
											dragging={drag?.id === thread.id}
											above={manual && target && index !== -1 && drop.index === index}
											sectionKey={key}
											at={at}
											actions={actions}
										/>
									);
								})}
								{manual && target && drop.index === length && (
									<li aria-hidden className="mx-3 h-0.5 rounded bg-ring" />
								)}
							</ul>
						)}
					</section>
				);
			})}
			{menu !== undefined && (
				<ThreadPicker
					key={`${menu.id}:${menu.kind}`}
					thread={board.lists.flatMap((list) => list.threads).find((candidate) => candidate.id === menu.id)}
					kind={menu.kind}
					anchor={menu.anchor}
					groups={board.groups}
					onClose={() => setMenu(undefined)}
				/>
			)}
		</div>
	);
}

/** The open picker's options and writes, built for its one thread only when it opens. */
function ThreadPicker({
	thread,
	kind,
	anchor,
	groups,
	onClose,
}: {
	readonly thread: ListedThread | undefined;
	readonly kind: Kind;
	readonly anchor: HTMLElement;
	readonly groups: Board["groups"];
	readonly onClose: () => void;
}) {
	const set = {
		status: useAtomSet(setStatus, { mode: "promise" }),
		priority: useAtomSet(setPriority, { mode: "promise" }),
		group: useAtomSet(setGroup, { mode: "promise" }),
		color: useAtomSet(setColor, { mode: "promise" }),
		create: useAtomSet(createGroup, { mode: "promise" }),
	};
	if (thread === undefined) return null;
	const threadId = thread.id;
	const common = { anchor, onClose };
	if (kind === "status")
		return (
			<Picker
				{...common}
				placeholder="Change status…"
				digits
				value={thread.status}
				options={MANUAL_STATUSES.map((value) => ({
					value,
					label: STATUS[value].label,
					mark: <StatusIcon status={value} />,
				}))}
				onPick={(value) => {
					const next = MANUAL_STATUSES.find((candidate) => candidate === value);
					if (next !== undefined) void set.status({ payload: { threadId, status: next } }).catch(failed);
				}}
			/>
		);
	if (kind === "priority")
		return (
			<Picker
				{...common}
				placeholder="Change priority…"
				digits
				value={String(thread.priority)}
				options={PRIORITIES.map((value: Priority) => ({
					value: String(value),
					label: PRIORITY[value].label,
					mark: <PriorityIcon priority={value} />,
				}))}
				onPick={(value) => void set.priority({ payload: { threadId, priority: Number(value) } }).catch(failed)}
			/>
		);
	if (kind === "color")
		return (
			<Picker
				{...common}
				placeholder="Change color…"
				digits
				value={thread.color ?? ""}
				options={[
					...COLORS.map(({ name, hex }) => ({ value: hex, label: name, mark: <Dot color={hex} /> })),
					// An action, not a state: offered only while there is a color to remove, and never checked.
					...(thread.color === null ? [] : [{ value: "none", label: "Remove", mark: <Dot color={null} /> }]),
				]}
				onPick={(value) =>
					void set.color({ payload: { threadId, color: value === "none" ? null : value } }).catch(failed)
				}
			/>
		);
	return (
		<Picker
			{...common}
			placeholder="Change or add group…"
			heading={groups.length > 0 ? "Groups" : undefined}
			value={thread.groupingId ?? "none"}
			options={[
				...groups.map((candidate) => ({
					value: candidate.id,
					label: candidate.name,
					mark: <Dot color={candidate.color} />,
				})),
				{ value: "none", label: "No Group", mark: <Dot color={null} /> },
			]}
			onPick={(value) =>
				void set.group({ payload: { threadId, groupingId: value === "none" ? null : value } }).catch(failed)
			}
			onCreate={{
				noun: "group",
				create: (name) =>
					void set
						.create({ payload: { organizationId: PERSONAL_ORGANIZATION, name } })
						.then((created) => set.group({ payload: { threadId, groupingId: created.id } }))
						.catch(failed),
			}}
		/>
	);
}
