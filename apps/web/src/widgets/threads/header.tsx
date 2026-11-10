import { ChevronRight, MoreHorizontal, GripVertical, Palette, Pencil, Trash } from "@/components/vuesax";
import { useAtomSet } from "@effect/atom-react";
import type { Grouping } from "@codeworksh/contract";
import type { DragEvent, ReactNode } from "react";

import { MENU_ROW, MenuChoice } from "@/components/menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { failed } from "./common";
import { deleteGroup, updateGroup } from "./data";
import { COLORS, Dot, PRIORITY, PriorityIcon, STATUS, StatusIcon } from "./marks";
import type { Section } from "./options";

/** What a section is called and how it is marked. */
export const heading = (section: Section, groups: ReadonlyMap<string, Grouping>): { name: string; mark: ReactNode } => {
	const list = section.list;
	if (list === undefined) return { name: "Threads", mark: null };
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
					// A new or renamed group is named at once. Focused a frame after mount: picked from its menu,
					// the field appears while the closing menu still holds focus.
					ref={(input) => {
						if (input !== null)
							requestAnimationFrame(() => {
								input.focus();
								input.select();
							});
					}}
					defaultValue={group.name}
					aria-label="Group name"
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
						<DropdownMenuContent
							align="end"
							className="min-w-40"
							// Rename opens a field that takes focus; the menu must not take it back as it closes.
							onCloseAutoFocus={(event) => event.preventDefault()}
						>
							<DropdownMenuItem className={MENU_ROW} onSelect={() => onRename(group.id)}>
								<Pencil aria-hidden />
								Rename
							</DropdownMenuItem>
							<MenuChoice
								label="Color"
								mark={<Palette aria-hidden />}
								value={group.color ?? undefined}
								options={COLORS.map(({ name, hex }) => ({
									value: hex,
									label: name,
									mark: <Dot color={hex} />,
								}))}
								onChange={(color) => void update({ payload: { groupingId: group.id, color } }).catch(failed)}
								after={
									group.color === null ? undefined : (
										<DropdownMenuItem
											className={MENU_ROW}
											onSelect={() =>
												void update({ payload: { groupingId: group.id, color: null } }).catch(failed)
											}
										>
											<Dot color={null} />
											Remove
										</DropdownMenuItem>
									)
								}
							/>
							{/* Apart from the rest, so a delete is never one row away from a rename. */}
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								className={MENU_ROW}
								onSelect={() => void remove({ payload: { groupingId: group.id } }).catch(failed)}
							>
								<Trash aria-hidden />
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</>
			)}
		</div>
	);
}
