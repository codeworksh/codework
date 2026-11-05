import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
	type Dashboard as Board,
	type DashboardBy,
	type DashboardList,
	type DashboardThread,
	type Grouping,
	PERSONAL_ORGANIZATION,
	type Priority,
	type ThreadStatus,
} from "@codeworksh/contract";
import { isMac, openMode, useKv, useShell, type WidgetProps } from "@codeworksh/widget/view";
import { AsyncResult } from "effect/reactivity";
import {
	CircleAlert,
	CircleCheck,
	CircleDot,
	CircleX,
	GripVertical,
	type LucideIcon,
	Minus,
	MoreHorizontal,
	Plus,
	SignalHigh,
	SignalLow,
	SignalMedium,
	TriangleAlert,
} from "lucide-react";
import { type DragEvent, type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { threadAddress } from "../session/address";
import { useRunDisplay } from "../session/display";
import { RunMark } from "../session/run";
import { type ThreadRef, threadKey } from "../session/schema";
import { ago } from "../time";
import {
	createGroup,
	dashboardAtom,
	deleteGroup,
	groupPosition,
	listKey,
	moveGroup,
	moveThread,
	setGroup,
	setPriority,
	setStatus,
	threadPosition,
	updateGroup,
} from "./data";

const STATUS: Record<ThreadStatus, { readonly label: string; readonly icon: LucideIcon }> = {
	working: { label: "Working", icon: CircleDot },
	attention: { label: "Needs attention", icon: CircleAlert },
	settled: { label: "Settled", icon: CircleCheck },
	cancelled: { label: "Cancelled", icon: CircleX },
};
const STATUSES = Object.keys(STATUS) as ReadonlyArray<ThreadStatus>;

const PRIORITY: Record<Priority, { readonly label: string; readonly icon: LucideIcon }> = {
	1: { label: "Urgent", icon: TriangleAlert },
	2: { label: "High", icon: SignalHigh },
	3: { label: "Medium", icon: SignalMedium },
	4: { label: "Low", icon: SignalLow },
	0: { label: "No priority", icon: Minus },
};
const PRIORITIES: ReadonlyArray<Priority> = [1, 2, 3, 4, 0];

/** The colors a group can take, Linear's label hues. */
const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#d6409f", "#8b8d98"];

const SPLITS: ReadonlyArray<{ readonly by: DashboardBy; readonly label: string }> = [
	{ by: "status", label: "Status" },
	{ by: "priority", label: "Priority" },
	{ by: "grouping", label: "Group" },
];

const byKey = (instanceId: string) => `widget/${instanceId}/by`;
const isBy = (value: unknown): value is DashboardBy => SPLITS.some((split) => split.by === value);

const failed = (error: unknown) =>
	toast.error("Not saved", {
		description:
			typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
				? error.message
				: undefined,
	});

/**
 * The organization's threads as a Linear-like board: lists by status, priority or group, each in the
 * one manual order. Dragging a thread moves it in that order, and into the list it is dropped on.
 */
export function Dashboard({ instanceId }: WidgetProps<unknown>) {
	const kv = useKv();
	const [by, setBy] = useState<DashboardBy>("status");
	useEffect(() => {
		let active = true;
		void kv.get(byKey(instanceId)).then((saved) => {
			if (active && isBy(saved)) setBy(saved);
		});
		return () => {
			active = false;
		};
	}, [kv, instanceId]);
	const choose = (next: DashboardBy) => {
		setBy(next);
		void kv.set(byKey(instanceId), next);
	};
	const result = useAtomValue(dashboardAtom(by));
	const create = useAtomSet(createGroup, { mode: "promise" });
	const [renaming, setRenaming] = useState<string>();
	const newGroup = () =>
		create({ payload: { organizationId: PERSONAL_ORGANIZATION, name: "New group" } }).then(
			(group) => setRenaming(group.id),
			failed,
		);

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5">
				<div role="radiogroup" aria-label="Group by" className="flex rounded-md bg-ink/5 p-0.5">
					{SPLITS.map((split) => (
						<button
							key={split.by}
							type="button"
							role="radio"
							aria-checked={split.by === by}
							onClick={() => choose(split.by)}
							className="rounded-[5px] px-2 py-0.5 text-xs text-ink-muted aria-checked:bg-frame aria-checked:text-ink aria-checked:shadow-sm"
						>
							{split.label}
						</button>
					))}
				</div>
				{by === "grouping" && (
					<button
						type="button"
						onClick={() => void newGroup()}
						className="ml-auto flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-ink-muted hover:bg-ink/5 hover:text-ink"
					>
						<Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
						New group
					</button>
				)}
			</div>
			{AsyncResult.match(result, {
				onInitial: () => null,
				onFailure: () => <p className="p-3 text-ink-muted">Could not load the dashboard.</p>,
				onSuccess: ({ value }) => (
					<Lists
						board={value}
						renaming={renaming}
						onRenamed={() => setRenaming(undefined)}
						onRename={setRenaming}
					/>
				),
			})}
		</div>
	);
}

type Drag = { readonly kind: "thread" | "group"; readonly id: string };
type Drop = { readonly list: string; readonly index: number };

/** `list` with `thread` taken out of wherever it was and put at `index` of the list keyed `to`, as it will be. */
const moved = (lists: ReadonlyArray<DashboardList>, thread: DashboardThread, to: string, index: number) =>
	lists.map((list): DashboardList => {
		const threads = list.threads.filter((candidate) => candidate.id !== thread.id);
		if (listKey(list) !== to) return { ...list, threads };
		const placed =
			list._tag === "Status"
				? { ...thread, status: list.status }
				: list._tag === "Priority"
					? { ...thread, priority: list.priority }
					: { ...thread, groupingId: list.groupingId };
		return { ...list, threads: threads.toSpliced(index, 0, placed) };
	});

/** The thread as the session view names it: its session alone for the main thread. */
const refOf = (thread: DashboardThread): ThreadRef =>
	thread.originKind === "main"
		? { sessionId: thread.sessionId }
		: { sessionId: thread.sessionId, threadId: thread.id };

function Lists({
	board,
	renaming,
	onRename,
	onRenamed,
}: {
	readonly board: Board;
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
	// Drawn at once while the writes go out, until the read after them arrives.
	const [optimistic, setOptimistic] = useState<{
		readonly base: Board;
		readonly lists: ReadonlyArray<DashboardList>;
	}>();
	const lists = optimistic?.base === board ? optimistic.lists : board.lists;
	const [drag, setDrag] = useState<Drag>();
	const [drop, setDrop] = useState<Drop>();
	const groups = new Map(board.groups.map((candidate) => [candidate.id, candidate]));
	const all = lists.flatMap((list) => list.threads).toSorted((a, b) => a.ordering - b.ordering);

	const open = (thread: DashboardThread, event: MouseEvent) => {
		if (event.button <= 1) shell.open(threadAddress(refOf(thread)), { mode: openMode(event) });
	};

	/** Puts the thread in the list keyed `to`: the setter of the column the board splits by. */
	const assign = (thread: DashboardThread, list: DashboardList) =>
		list._tag === "Status"
			? status({ payload: { threadId: thread.id, status: list.status } })
			: list._tag === "Priority"
				? priority({ payload: { threadId: thread.id, priority: list.priority } })
				: group({ payload: { threadId: thread.id, groupingId: list.groupingId } });

	const dropThread = async (target: DashboardList, index: number) => {
		const thread = all.find((candidate) => candidate.id === drag?.id);
		if (thread === undefined) return;
		const source = lists.find((list) => list.threads.some((candidate) => candidate.id === thread.id));
		const same = source !== undefined && listKey(source) === listKey(target);
		if (same && source.threads.findIndex((candidate) => candidate.id === thread.id) === index) return;
		setOptimistic({ base: board, lists: moved(lists, thread, listKey(target), index) });
		const to = threadPosition(
			all.filter((candidate) => candidate.id !== thread.id),
			target.threads.filter((candidate) => candidate.id !== thread.id),
			index,
		);
		try {
			if (!same) await assign(thread, target);
			if (to !== undefined) await move({ payload: { threadId: thread.id, to } });
		} catch (error) {
			setOptimistic(undefined);
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

	/** Where a drag over a row of `list` at `at` lands, as an index of the list without the dragged thread. */
	const over = (event: DragEvent, list: DashboardList, at: number) => {
		if (drag?.kind !== "thread") return;
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		const below = event.clientY > rect.top + rect.height / 2;
		const from = list.threads.findIndex((candidate) => candidate.id === drag.id);
		const index = at + (below ? 1 : 0);
		const next = { list: listKey(list), index: from !== -1 && from < index ? index - 1 : index };
		if (drop?.list !== next.list || drop.index !== next.index) setDrop(next);
	};

	const end = () => {
		setDrag(undefined);
		setDrop(undefined);
	};

	return (
		<div className="min-h-0 flex-1 overflow-auto pb-3" onDragEnd={end}>
			{lists.map((list) => {
				const key = listKey(list);
				// A group's own list: its header drags to reorder the groups.
				const groupId = list._tag === "Grouping" ? list.groupingId : null;
				const without = list.threads.filter((candidate) => candidate.id !== drag?.id);
				return (
					<section
						key={key}
						aria-label={heading(list, groups).name}
						onDragOver={(event) => {
							if (drag?.kind !== "thread") return;
							event.preventDefault();
							if (drop?.list !== key) setDrop({ list: key, index: without.length });
						}}
						onDrop={(event) => {
							event.preventDefault();
							if (drag?.kind === "thread" && drop?.list === key) void dropThread(list, drop.index);
							end();
						}}
					>
						<ListHeader
							list={list}
							groups={groups}
							renaming={renaming}
							onRename={onRename}
							onRenamed={onRenamed}
							draggable={groupId !== null}
							onDragStart={() => groupId !== null && setDrag({ kind: "group", id: groupId })}
							onDragOver={(event) => {
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
						<ul className="min-h-2">
							{list.threads.map((thread, at) => {
								const index = without.findIndex((candidate) => candidate.id === thread.id);
								return (
									<Row
										key={thread.id}
										thread={thread}
										groups={board.groups}
										dragging={drag?.id === thread.id}
										above={drop?.list === key && index !== -1 && drop.index === index}
										onOpen={open}
										onDragStart={() => setDrag({ kind: "thread", id: thread.id })}
										onDragOver={(event) => over(event, list, at)}
									/>
								);
							})}
							{drop?.list === key && drop.index === without.length && (
								<li aria-hidden className="mx-3 h-0.5 rounded bg-ring" />
							)}
						</ul>
					</section>
				);
			})}
		</div>
	);
}

/** What a list is called and how it is marked. */
const heading = (list: DashboardList, groups: ReadonlyMap<string, Grouping>): { name: string; mark: ReactNode } => {
	if (list._tag === "Status") {
		const { label, icon: Icon } = STATUS[list.status];
		return { name: label, mark: <Icon className="size-3.5 text-ink-muted" strokeWidth={1.75} aria-hidden /> };
	}
	if (list._tag === "Priority") {
		const { label, icon: Icon } = PRIORITY[list.priority];
		return { name: label, mark: <Icon className="size-3.5 text-ink-muted" strokeWidth={1.75} aria-hidden /> };
	}
	const group = list.groupingId === null ? undefined : groups.get(list.groupingId);
	return { name: group?.name ?? "No group", mark: <Dot color={group?.color ?? null} /> };
};

function Dot({ color }: { readonly color: string | null }) {
	return (
		<span
			aria-hidden
			className="size-2.5 shrink-0 rounded-full border border-ink/15"
			style={color === null ? undefined : { backgroundColor: color, borderColor: color }}
		/>
	);
}

function ListHeader({
	list,
	groups,
	renaming,
	onRename,
	onRenamed,
	draggable,
	onDragStart,
	onDragOver,
	onDrop,
}: {
	readonly list: DashboardList;
	readonly groups: ReadonlyMap<string, Grouping>;
	readonly renaming: string | undefined;
	readonly onRename: (groupingId: string) => void;
	readonly onRenamed: () => void;
	readonly draggable: boolean;
	readonly onDragStart: () => void;
	readonly onDragOver: (event: DragEvent) => void;
	readonly onDrop: (event: DragEvent) => void;
}) {
	const update = useAtomSet(updateGroup, { mode: "promise" });
	const remove = useAtomSet(deleteGroup, { mode: "promise" });
	const { name, mark } = heading(list, groups);
	const group = list._tag === "Grouping" && list.groupingId !== null ? groups.get(list.groupingId) : undefined;
	const rename = (value: string) => {
		onRenamed();
		if (group !== undefined && value.trim() !== "" && value.trim() !== group.name)
			void update({ payload: { groupingId: group.id, name: value } }).catch(failed);
	};
	return (
		<div
			draggable={draggable && renaming !== group?.id}
			onDragStart={(event) => {
				event.dataTransfer.effectAllowed = "move";
				onDragStart();
			}}
			onDragOver={onDragOver}
			onDrop={onDrop}
			className="group/header sticky top-0 z-10 flex items-center gap-2 bg-frame px-3 pt-3 pb-1 text-xs font-medium"
		>
			{draggable && (
				<GripVertical
					className="-ml-2 size-3 cursor-grab text-ink-muted opacity-0 group-hover/header:opacity-100"
					aria-hidden
				/>
			)}
			{mark}
			{group !== undefined && renaming === group.id ? (
				<input
					// oxlint-disable-next-line jsx-a11y/no-autofocus -- a new or renamed group is named at once.
					autoFocus
					defaultValue={group.name}
					aria-label="Group name"
					onFocus={(event) => event.currentTarget.select()}
					onBlur={(event) => rename(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") onRenamed();
					}}
					className="min-w-0 rounded-sm bg-ink/5 px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
				/>
			) : (
				<span className="truncate">{name}</span>
			)}
			<span className="text-ink-muted tabular-nums">{list.threads.length}</span>
			{group !== undefined && (
				<DropdownMenu>
					<DropdownMenuTrigger
						aria-label={`${group.name} actions`}
						className="ml-auto grid size-5 place-items-center rounded-md text-ink-muted opacity-0 group-hover/header:opacity-100 hover:bg-ink/8 focus-visible:opacity-100 data-[state=open]:opacity-100"
					>
						<MoreHorizontal className="size-3.5" aria-hidden />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => onRename(group.id)}>Rename</DropdownMenuItem>
						<DropdownMenuSeparator />
						<div className="flex flex-wrap gap-1 px-2 py-1" role="group" aria-label="Color">
							{[...COLORS, null].map((color) => (
								<DropdownMenuItem
									key={color ?? "none"}
									aria-label={color ?? "No color"}
									onSelect={() => void update({ payload: { groupingId: group.id, color } }).catch(failed)}
									className="grid size-6 min-h-0 place-items-center p-0"
								>
									<Dot color={color} />
								</DropdownMenuItem>
							))}
						</div>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onSelect={() => void remove({ payload: { groupingId: group.id } }).catch(failed)}
						>
							Delete group
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

function Row({
	thread,
	groups,
	dragging,
	above,
	onOpen,
	onDragStart,
	onDragOver,
}: {
	readonly thread: DashboardThread;
	readonly groups: ReadonlyArray<Grouping>;
	readonly dragging: boolean;
	/** The drop would land just above it. */
	readonly above: boolean;
	readonly onOpen: (thread: DashboardThread, event: MouseEvent) => void;
	readonly onDragStart: () => void;
	readonly onDragOver: (event: DragEvent) => void;
}) {
	const status = useAtomSet(setStatus, { mode: "promise" });
	const priority = useAtomSet(setPriority, { mode: "promise" });
	const group = useAtomSet(setGroup, { mode: "promise" });
	const display = useRunDisplay([{ key: threadKey(refOf(thread)), runState: thread.runState }]);
	const grouping = groups.find((candidate) => candidate.id === thread.groupingId);
	const PriorityIcon = PRIORITY[thread.priority].icon;
	const StatusIcon = STATUS[thread.status].icon;
	return (
		<li
			draggable
			onDragStart={(event) => {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData("text/plain", thread.title);
				onDragStart();
			}}
			onDragOver={onDragOver}
			data-thread={thread.id}
			className={`relative ${dragging ? "opacity-40" : ""}`}
		>
			{above && <span aria-hidden className="absolute inset-x-3 -top-px h-0.5 rounded bg-ring" />}
			<div className="group/row mx-1.5 flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-ink/5">
				<span
					aria-hidden
					className="h-4 w-0.5 shrink-0 rounded-full"
					style={{ backgroundColor: thread.color ?? "transparent" }}
				/>
				<Pick
					label={`Priority: ${PRIORITY[thread.priority].label}`}
					icon={<PriorityIcon className="size-3.5" strokeWidth={1.75} aria-hidden />}
					value={String(thread.priority)}
					options={PRIORITIES.map((value) => ({ value: String(value), label: PRIORITY[value].label }))}
					onPick={(value) =>
						void priority({ payload: { threadId: thread.id, priority: Number(value) } }).catch(failed)
					}
				/>
				<button
					type="button"
					title={`Open thread (${isMac ? "⌘" : "Ctrl"}-click or middle-click opens a new one)`}
					onClick={(event) => onOpen(thread, event)}
					onAuxClick={(event) => onOpen(thread, event)}
					className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="min-w-0 truncate text-body text-ink">{thread.title}</span>
					{thread.originKind !== "main" && (
						<span className="shrink-0 text-2xs text-ink-muted">{thread.originKind}</span>
					)}
					<span className="min-w-0 shrink truncate text-2xs text-ink-muted">{thread.project.name}</span>
				</button>
				<span className="text-ink-muted">
					<RunMark display={display} />
				</span>
				<Pick
					label={`Group: ${grouping?.name ?? "No group"}`}
					icon={
						<span className="flex max-w-28 items-center gap-1 text-2xs">
							<Dot color={grouping?.color ?? null} />
							{grouping !== undefined && <span className="truncate">{grouping.name}</span>}
						</span>
					}
					value={thread.groupingId ?? "none"}
					options={[
						...groups.map((candidate) => ({ value: candidate.id, label: candidate.name })),
						{ value: "none", label: "No group" },
					]}
					onPick={(value) =>
						void group({ payload: { threadId: thread.id, groupingId: value === "none" ? null : value } }).catch(
							failed,
						)
					}
				/>
				<Pick
					label={`Status: ${STATUS[thread.status].label}`}
					icon={<StatusIcon className="size-3.5" strokeWidth={1.75} aria-hidden />}
					value={thread.status}
					options={STATUSES.map((value) => ({ value, label: STATUS[value].label }))}
					onPick={(value) => {
						const next = STATUSES.find((candidate) => candidate === value);
						if (next !== undefined) void status({ payload: { threadId: thread.id, status: next } }).catch(failed);
					}}
				/>
				<span className="w-8 shrink-0 text-right text-2xs tabular-nums text-ink-muted">
					{ago(thread.updatedAt)}
				</span>
			</div>
		</li>
	);
}

/** A small menu button that picks one of `options`. */
function Pick({
	label,
	icon,
	value,
	options,
	onPick,
}: {
	readonly label: string;
	readonly icon: ReactNode;
	readonly value: string;
	readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
	readonly onPick: (value: string) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={label}
				title={label}
				className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1 text-ink-muted hover:bg-ink/8 hover:text-ink"
			>
				{icon}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup value={value} onValueChange={(next) => next !== value && onPick(next)}>
					{options.map((option) => (
						<DropdownMenuRadioItem key={option.value} value={option.value}>
							{option.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
