import { useAtomSet } from "@effect/atom-react";
import type { Grouping } from "@codeworksh/contract";
import { ChevronRight, GripVertical, MoreHorizontal } from "lucide-react";
import type { DragEvent, ReactNode } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { failed } from "./common";
import { deleteGroup, updateGroup } from "./data";
import { COLORS, colorName, Dot, PRIORITY, PriorityIcon, STATUS, StatusIcon } from "./marks";
import type { Section } from "./options";

/** What a section is called and how it is marked. */
export const heading = (section: Section, groups: ReadonlyMap<string, Grouping>): { name: string; mark: ReactNode } => {
	const list = section.list;
	if (list === undefined) return { name: "All Threads", mark: null };
	if (list._tag === "Status") return { name: STATUS[list.status].label, mark: <StatusIcon status={list.status} /> };
	if (list._tag === "Priority")
		return { name: PRIORITY[list.priority].label, mark: <PriorityIcon priority={list.priority} /> };
	const group = list.groupingId === null ? undefined : groups.get(list.groupingId);
	return { name: group?.name ?? "No Group", mark: <Dot color={group?.color ?? null} /> };
};

export function SectionHeader({
	section,
	groups,
	collapsed,
	onCollapse,
	renaming,
	onRename,
	onRenamed,
	onDragStart,
	onDragOver,
	onDrop,
}: {
	readonly section: Section;
	readonly groups: ReadonlyMap<string, Grouping>;
	readonly collapsed: boolean;
	readonly onCollapse: () => void;
	readonly renaming: string | undefined;
	readonly onRename: (groupingId: string) => void;
	readonly onRenamed: () => void;
	readonly onDragStart: () => void;
	readonly onDragOver: (event: DragEvent) => void;
	readonly onDrop: (event: DragEvent) => void;
}) {
	const update = useAtomSet(updateGroup, { mode: "promise" });
	const remove = useAtomSet(deleteGroup, { mode: "promise" });
	const { name, mark } = heading(section, groups);
	const list = section.list;
	const group = list?._tag === "Grouping" && list.groupingId !== null ? groups.get(list.groupingId) : undefined;
	const rename = (value: string) => {
		onRenamed();
		if (group !== undefined && value.trim() !== "" && value.trim() !== group.name)
			void update({ payload: { groupingId: group.id, name: value } }).catch(failed);
	};
	return (
		<div
			draggable={group !== undefined && renaming !== group.id}
			onDragStart={(event) => {
				event.dataTransfer.effectAllowed = "move";
				onDragStart();
			}}
			onDragOver={onDragOver}
			onDrop={onDrop}
			className="group/header sticky top-0 z-20 flex h-9 items-center gap-2 border-b border-edge/50 bg-[color-mix(in_oklab,var(--color-frame),var(--color-ink)_4%)] pr-2 pl-1 text-xs font-medium"
		>
			<button
				type="button"
				tabIndex={-1}
				aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
				aria-expanded={!collapsed}
				onClick={onCollapse}
				className="grid size-5 place-items-center rounded-md text-ink-muted hover:bg-ink/8"
			>
				<ChevronRight
					className={`size-3.5 transition-transform motion-reduce:transition-none ${collapsed ? "" : "rotate-90"}`}
					aria-hidden
				/>
			</button>
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
						event.stopPropagation();
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") onRenamed();
					}}
					className="min-w-0 rounded-sm bg-ink/5 px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
				/>
			) : (
				<span className="truncate" onDoubleClick={() => group !== undefined && onRename(group.id)}>
					{name}
				</span>
			)}
			<span className="text-ink-muted tabular-nums">{section.threads.length}</span>
			{group !== undefined && (
				<>
					<GripVertical
						className="ml-auto size-3.5 cursor-grab text-ink-muted opacity-0 group-hover/header:opacity-100"
						aria-hidden
					/>
					<DropdownMenu>
						<DropdownMenuTrigger
							aria-label={`${group.name} actions`}
							className="grid size-5 place-items-center rounded-md text-ink-muted opacity-0 group-hover/header:opacity-100 hover:bg-ink/8 focus-visible:opacity-100 data-[state=open]:opacity-100"
						>
							<MoreHorizontal className="size-3.5" aria-hidden />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem className="text-xs" onSelect={() => onRename(group.id)}>
								Rename
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<div className="flex flex-wrap gap-1 px-2 py-1" role="group" aria-label="Color">
								{[...COLORS.map((color) => color.hex), null].map((color) => (
									<DropdownMenuItem
										key={color ?? "none"}
										aria-label={color === null ? "No Color" : colorName(color)}
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
								className="text-xs"
								onSelect={() => void remove({ payload: { groupingId: group.id } }).catch(failed)}
							>
								Delete group
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</>
			)}
		</div>
	);
}
