import type { Priority } from "@codeworksh/contract";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { MENU_ROW, MenuChoice } from "@/components/menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { failed } from "../threads/common";
import { setColor, setGroup, setPriority, setStatus, threadsAtom } from "../threads/data";
import {
	COLORS,
	colorName,
	Dot,
	isManual,
	MANUAL_STATUSES,
	PRIORITIES,
	PRIORITY,
	PriorityIcon,
	STATUS,
	StatusIcon,
} from "../threads/marks";
import { threadRef } from "./address";

/**
 * The list the menu reads its thread from. Its frame keeps it mounted, so the menu opens with its
 * rows instead of growing by them a read later.
 */
export const menuThreads = threadsAtom("status");

/** A session frame's thread rows: its status, priority, group and color, each showing the current one. */
export function ThreadMenu({ address }: { readonly address: string | undefined }) {
	const ref = threadRef(address);
	const result = useAtomValue(menuThreads);
	const status = useAtomSet(setStatus, { mode: "promise" });
	const priority = useAtomSet(setPriority, { mode: "promise" });
	const group = useAtomSet(setGroup, { mode: "promise" });
	const color = useAtomSet(setColor, { mode: "promise" });
	const board = AsyncResult.isSuccess(result) ? result.value : undefined;
	const thread =
		ref === undefined
			? undefined
			: board?.lists
					.flatMap((list) => list.threads)
					.find(
						(candidate) =>
							candidate.sessionId === ref.sessionId &&
							(ref.threadId === undefined ? candidate.originKind === "main" : candidate.id === ref.threadId),
					);
	if (board === undefined || thread === undefined) return null;
	const threadId = thread.id;
	const grouping = board.groups.find((candidate) => candidate.id === thread.groupingId);
	return (
		<>
			<MenuChoice
				label="Status"
				mark={<StatusIcon status={thread.status} />}
				value={isManual(thread.status) ? thread.status : undefined}
				current={STATUS[thread.status].label}
				options={MANUAL_STATUSES.map((value) => ({
					value,
					label: STATUS[value].label,
					mark: <StatusIcon status={value} />,
				}))}
				onChange={(next) => void status({ payload: { threadId, status: next } }).catch(failed)}
			/>
			<MenuChoice
				label="Priority"
				mark={<PriorityIcon priority={thread.priority} />}
				value={String(thread.priority)}
				current={PRIORITY[thread.priority].label}
				options={PRIORITIES.map((value: Priority) => ({
					value: String(value),
					label: PRIORITY[value].label,
					mark: <PriorityIcon priority={value} />,
				}))}
				onChange={(next) => void priority({ payload: { threadId, priority: Number(next) } }).catch(failed)}
			/>
			<MenuChoice
				label="Group"
				mark={<Dot color={grouping?.color ?? null} />}
				value={thread.groupingId ?? "none"}
				current={grouping?.name ?? "—"}
				options={[
					...board.groups.map((candidate) => ({
						value: candidate.id,
						label: candidate.name,
						mark: <Dot color={candidate.color} />,
					})),
					{ value: "none", label: "No Group", mark: <Dot color={null} /> },
				]}
				onChange={(next) =>
					void group({ payload: { threadId, groupingId: next === "none" ? null : next } }).catch(failed)
				}
			/>
			<MenuChoice
				label="Color"
				mark={<Dot color={thread.color} />}
				value={thread.color ?? undefined}
				current={thread.color === null ? "—" : colorName(thread.color)}
				options={COLORS.map(({ name, hex }) => ({ value: hex, label: name, mark: <Dot color={hex} /> }))}
				onChange={(next) => void color({ payload: { threadId, color: next } }).catch(failed)}
				after={
					thread.color === null ? undefined : (
						<DropdownMenuItem
							className={MENU_ROW}
							onSelect={() => void color({ payload: { threadId, color: null } }).catch(failed)}
						>
							<Dot color={null} />
							Remove
						</DropdownMenuItem>
					)
				}
			/>
		</>
	);
}
