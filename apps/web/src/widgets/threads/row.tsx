import type { Grouping, ListedThread } from "@codeworksh/contract";
import { isMac } from "@codeworksh/widget/view";
import { Box, Tag } from "lucide-react";
import { type DragEvent, memo, type MouseEvent, type ReactNode } from "react";

import { useRunDisplay } from "../session/display";
import { RunMark } from "../session/run";
import { threadKey } from "../session/schema";
import { refOf } from "./common";
import {
	colorName,
	Dot,
	fullDate,
	MachineAvatar,
	PRIORITY,
	PriorityIcon,
	STATUS,
	StatusIcon,
	shortDate,
} from "./marks";

/** The pickers a row has, each opened by its key from the keyboard. */
export type Picker = "status" | "priority" | "group" | "color";
export const PICKER_KEYS: Record<string, Picker> = { s: "status", p: "priority", l: "group", c: "color" };

/** What a row asks of its list; one object for every row, so a memoized row keeps it across renders. */
export interface RowActions {
	readonly select: (threadId: string) => void;
	readonly open: (thread: ListedThread, event: MouseEvent) => void;
	readonly menu: (threadId: string, kind: Picker) => void;
	readonly dragStart: (threadId: string) => void;
	readonly over: (event: DragEvent, sectionKey: string, at: number) => void;
}

/**
 * One thread. Memoized and given only values and the shared `actions`, so a key press, a drag over
 * another row or a read that left this thread alone renders nothing here.
 */
export const Row = memo(function Row({
	thread,
	grouping,
	showMachine,
	selected,
	dragging,
	above,
	sectionKey,
	at,
	actions,
}: {
	readonly thread: ListedThread;
	readonly grouping: Grouping | undefined;
	readonly showMachine: boolean;
	readonly selected: boolean;
	readonly dragging: boolean;
	/** The drop would land just above it. */
	readonly above: boolean;
	readonly sectionKey: string;
	readonly at: number;
	readonly actions: RowActions;
}) {
	const pick = (kind: Picker, label: string, shortcut: string, icon: ReactNode, narrow = false) => (
		<button
			type="button"
			tabIndex={-1}
			data-picker={kind}
			aria-label={label}
			title={`${label} (${shortcut})`}
			onClick={() => actions.menu(thread.id, kind)}
			className={`flex h-6 shrink-0 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-ink/8 hover:text-ink ${
				narrow ? "w-3" : "min-w-6 px-1"
			}`}
		>
			{icon}
		</button>
	);
	return (
		<li
			draggable
			onDragStart={(event) => {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData("text/plain", thread.title);
				actions.dragStart(thread.id);
			}}
			onDragOver={(event) => actions.over(event, sectionKey, at)}
			onMouseDown={() => actions.select(thread.id)}
			id={`thread-${thread.id}`}
			role="option"
			data-thread={thread.id}
			aria-selected={selected}
			// Off-screen rows skip layout and paint (it clips, so the drop line sits inside), so a long list needs no virtualizer.
			className={`relative [content-visibility:auto] [contain-intrinsic-size:auto_--spacing(9)] ${dragging ? "opacity-40" : ""}`}
		>
			{above && <span aria-hidden className="absolute inset-x-3 top-0 z-10 h-0.5 rounded bg-ring" />}
			<div
				className={`group/row flex h-9 items-center gap-2 border-b border-edge/50 pr-3 pl-2 ${
					selected ? "bg-ink/7" : "hover:bg-ink/4"
				}`}
			>
				{pick(
					"color",
					`Color: ${thread.color === null ? "Session Color" : colorName(thread.color)}`,
					"C",
					<span
						aria-hidden
						className={`h-4 w-1 rounded-full ${thread.color === null ? "bg-ink/20 opacity-0 group-hover/row:opacity-100" : ""}`}
						style={thread.color === null ? undefined : { backgroundColor: thread.color }}
					/>,
					true,
				)}
				{pick(
					"priority",
					`Priority: ${PRIORITY[thread.priority].label}`,
					"P",
					<PriorityIcon priority={thread.priority} />,
				)}
				{pick("status", `Status: ${STATUS[thread.status].label}`, "S", <StatusIcon status={thread.status} />)}
				<button
					type="button"
					tabIndex={-1}
					title={`Open thread (${isMac ? "⌘" : "Ctrl"}-click or middle-click opens a new one)`}
					onClick={(event) => actions.open(thread, event)}
					onAuxClick={(event) => actions.open(thread, event)}
					className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
				>
					<span className="min-w-0 truncate text-body text-ink">{thread.title}</span>
					{thread.originKind !== "main" && (
						<span className="shrink-0 rounded-sm bg-ink/6 px-1 text-2xs text-ink-muted">{thread.originKind}</span>
					)}
					<Run thread={thread} />
				</button>
				{pick(
					"group",
					`Group: ${grouping?.name ?? "No Group"}`,
					"L",
					grouping === undefined ? (
						<Tag className="size-3.5 opacity-0 group-hover/row:opacity-100" strokeWidth={1.75} aria-hidden />
					) : (
						<span className="flex max-w-32 items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-2xs text-ink-secondary">
							<Dot color={grouping.color} />
							<span className="truncate">{grouping.name}</span>
						</span>
					),
				)}
				<span
					title={thread.project.name}
					className="hidden max-w-36 shrink-0 items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-2xs text-ink-secondary @2xl:flex"
				>
					<Box className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
					<span className="truncate">{thread.project.name}</span>
				</span>
				{showMachine && <MachineAvatar id={thread.machine.id} name={thread.machine.name} />}
				<span
					title={fullDate(thread.updatedAt)}
					className="w-12 shrink-0 text-right text-2xs text-ink-muted tabular-nums"
				>
					{shortDate(thread.updatedAt)}
				</span>
			</div>
		</li>
	);
});

/** The run's mark on its own, so the run's client state renders this alone, not the row. */
function Run({ thread }: { readonly thread: ListedThread }) {
	const display = useRunDisplay([{ key: threadKey(refOf(thread)), runState: thread.runState }]);
	return (
		<span className="text-ink-muted">
			<RunMark display={display} />
		</span>
	);
}
