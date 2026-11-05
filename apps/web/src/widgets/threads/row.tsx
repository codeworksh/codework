import { useAtomSet } from "@effect/atom-react";
import type { Grouping, ListedThread } from "@codeworksh/contract";
import { isMac } from "@codeworksh/widget/view";
import { Box, Tag } from "lucide-react";
import type { DragEvent, MouseEvent, ReactNode } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRunDisplay } from "../session/display";
import { RunMark } from "../session/run";
import { threadKey } from "../session/schema";
import { failed, refOf } from "./common";
import { setColor, setGroup, setPriority, setStatus } from "./data";
import {
	COLORS,
	Dot,
	MachineAvatar,
	PRIORITIES,
	PRIORITY,
	PriorityIcon,
	STATUS,
	STATUSES,
	StatusIcon,
	shortDate,
} from "./marks";

/** The pickers a row has, each opened by its key from the keyboard. */
export type Picker = "status" | "priority" | "group" | "color";
export const PICKER_KEYS: Record<string, Picker> = { s: "status", p: "priority", l: "group", c: "color" };

export function Row({
	thread,
	groups,
	showMachine,
	selected,
	menu,
	onMenu,
	dragging,
	above,
	onSelect,
	onOpen,
	onDragStart,
	onDragOver,
}: {
	readonly thread: ListedThread;
	readonly groups: ReadonlyArray<Grouping>;
	readonly showMachine: boolean;
	readonly selected: boolean;
	/** The picker open on this row. */
	readonly menu: Picker | undefined;
	readonly onMenu: (menu: Picker | undefined) => void;
	readonly dragging: boolean;
	/** The drop would land just above it. */
	readonly above: boolean;
	readonly onSelect: () => void;
	readonly onOpen: (thread: ListedThread, event: MouseEvent) => void;
	readonly onDragStart: () => void;
	readonly onDragOver: (event: DragEvent) => void;
}) {
	const status = useAtomSet(setStatus, { mode: "promise" });
	const priority = useAtomSet(setPriority, { mode: "promise" });
	const group = useAtomSet(setGroup, { mode: "promise" });
	const color = useAtomSet(setColor, { mode: "promise" });
	const display = useRunDisplay([{ key: threadKey(refOf(thread)), runState: thread.runState }]);
	const grouping = groups.find((candidate) => candidate.id === thread.groupingId);
	const picker = (kind: Picker) => ({
		open: menu === kind,
		onOpenChange: (open: boolean) => onMenu(open ? kind : undefined),
	});
	return (
		<li
			draggable
			onDragStart={(event) => {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData("text/plain", thread.title);
				onDragStart();
			}}
			onDragOver={onDragOver}
			onMouseDown={onSelect}
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
				<Pick
					{...picker("color")}
					label={`Color: ${thread.color ?? "Session Color"}`}
					shortcut="C"
					icon={
						<span
							aria-hidden
							className="h-4 w-1 rounded-full"
							style={{ backgroundColor: thread.color ?? "transparent" }}
						/>
					}
					value={thread.color ?? "none"}
					options={[
						...COLORS.map((value) => ({ value, label: value, mark: <Dot color={value} /> })),
						{ value: "none", label: "Session Color", mark: <Dot color={null} /> },
					]}
					onPick={(value) =>
						void color({ payload: { threadId: thread.id, color: value === "none" ? null : value } }).catch(failed)
					}
					narrow
				/>
				<Pick
					{...picker("priority")}
					label={`Priority: ${PRIORITY[thread.priority].label}`}
					shortcut="P"
					icon={<PriorityIcon priority={thread.priority} />}
					value={String(thread.priority)}
					options={PRIORITIES.map((value) => ({
						value: String(value),
						label: PRIORITY[value].label,
						mark: <PriorityIcon priority={value} />,
					}))}
					onPick={(value) =>
						void priority({ payload: { threadId: thread.id, priority: Number(value) } }).catch(failed)
					}
				/>
				<Pick
					{...picker("status")}
					label={`Status: ${STATUS[thread.status].label}`}
					shortcut="S"
					icon={<StatusIcon status={thread.status} />}
					value={thread.status}
					options={STATUSES.map((value) => ({
						value,
						label: STATUS[value].label,
						mark: <StatusIcon status={value} />,
					}))}
					onPick={(value) => {
						const next = STATUSES.find((candidate) => candidate === value);
						if (next !== undefined) void status({ payload: { threadId: thread.id, status: next } }).catch(failed);
					}}
				/>
				<button
					type="button"
					tabIndex={-1}
					title={`Open thread (${isMac ? "⌘" : "Ctrl"}-click or middle-click opens a new one)`}
					onClick={(event) => onOpen(thread, event)}
					onAuxClick={(event) => onOpen(thread, event)}
					className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
				>
					<span className="min-w-0 truncate text-body text-ink">{thread.title}</span>
					{thread.originKind !== "main" && (
						<span className="shrink-0 rounded-sm bg-ink/6 px-1 text-2xs text-ink-muted">{thread.originKind}</span>
					)}
					<span className="text-ink-muted">
						<RunMark display={display} />
					</span>
				</button>
				<Pick
					{...picker("group")}
					label={`Group: ${grouping?.name ?? "No Group"}`}
					shortcut="L"
					icon={
						grouping === undefined ? (
							<Tag className="size-3.5 opacity-0 group-hover/row:opacity-100" strokeWidth={1.75} aria-hidden />
						) : (
							<span className="flex max-w-32 items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-2xs text-ink-secondary">
								<Dot color={grouping.color} />
								<span className="truncate">{grouping.name}</span>
							</span>
						)
					}
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
						void group({ payload: { threadId: thread.id, groupingId: value === "none" ? null : value } }).catch(
							failed,
						)
					}
				/>
				<span
					title={thread.project.name}
					className="hidden max-w-36 shrink-0 items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-2xs text-ink-secondary @2xl:flex"
				>
					<Box className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
					<span className="truncate">{thread.project.name}</span>
				</span>
				{showMachine && <MachineAvatar id={thread.machine.id} name={thread.machine.name} />}
				<span
					title={new Date(thread.updatedAt).toLocaleString()}
					className="w-12 shrink-0 text-right text-2xs text-ink-muted tabular-nums"
				>
					{shortDate(thread.updatedAt)}
				</span>
			</div>
		</li>
	);
}

/** A small menu button that picks one of `options`; open from outside so the keyboard reaches it. */
function Pick({
	label,
	shortcut,
	icon,
	value,
	options,
	onPick,
	open,
	onOpenChange,
	narrow = false,
}: {
	readonly label: string;
	readonly shortcut: string;
	readonly icon: ReactNode;
	readonly value: string;
	readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly mark: ReactNode }>;
	readonly onPick: (value: string) => void;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly narrow?: boolean;
}) {
	return (
		<DropdownMenu open={open} onOpenChange={onOpenChange}>
			<DropdownMenuTrigger
				aria-label={label}
				title={`${label} (${shortcut})`}
				tabIndex={-1}
				onMouseDown={(event) => event.stopPropagation()}
				className={`flex h-6 shrink-0 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-ink/8 hover:text-ink ${
					narrow ? "w-2" : "min-w-6 px-1"
				}`}
			>
				{icon}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				// The list takes focus back, so the keyboard stays on it.
				onCloseAutoFocus={(event) => event.preventDefault()}
				onKeyDown={(event) => {
					const option = /^[1-9]$/.test(event.key) ? options[Number(event.key) - 1] : undefined;
					if (option === undefined) return;
					event.preventDefault();
					if (option.value !== value) onPick(option.value);
					onOpenChange(false);
				}}
			>
				<DropdownMenuRadioGroup value={value} onValueChange={(next) => next !== value && onPick(next)}>
					{options.map((option, index) => (
						<DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2">
							{option.mark}
							{option.label}
							{index < 9 && <DropdownMenuShortcut>{index + 1}</DropdownMenuShortcut>}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
