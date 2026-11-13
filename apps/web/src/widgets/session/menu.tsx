import type { Priority } from "@codeworksh/contract";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

import { MENU_ROW, MenuChoice } from "@/components/menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ChatTextIcon, GearSixIcon, GitDiffIcon } from "@phosphor-icons/react";
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
import { threadKey } from "./schema";

/**
 * The list the menu reads its thread from. Its frame keeps it mounted, so the menu opens with its
 * rows instead of growing by them a read later.
 */
export const menuThreads = threadsAtom("status");

/** The session frames showing their project's settings in place of their thread, by instance id. */
const settingsAtom = Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive);

/**
 * The address of the changes in each thread's space, by thread key: known once a view has loaded the
 * thread, which the menu, outside the view, cannot do itself.
 */
export const changesAtom = Atom.family((_key: string) => Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive));

/** Whether a session frame shows its project's settings, and the switch between them and its thread. */
export function useSettings(instanceId: string) {
	const [frames, setFrames] = useAtom(settingsAtom);
	const set = (shown: boolean) =>
		setFrames((current) => [...current.filter((id) => id !== instanceId), ...(shown ? [instanceId] : [])]);
	return [frames.includes(instanceId), set] as const;
}

/**
 * A session frame's menu rows: its thread's, then its space's changes and its project's settings
 * below a divider. `onOpen` opens an address beside the frame.
 */
export function ThreadMenu({
	address,
	instanceId,
	onOpen,
}: {
	readonly address: string | undefined;
	readonly instanceId: string;
	readonly onOpen: (address: string) => void;
}) {
	const [settings, setSettings] = useSettings(instanceId);
	const ref = threadRef(address);
	const changes = useAtomValue(changesAtom(ref === undefined ? "" : threadKey(ref)));
	return (
		<>
			<ThreadRows address={address} />
			<DropdownMenuSeparator />
			{changes !== undefined && (
				<DropdownMenuItem className={MENU_ROW} onSelect={() => onOpen(changes)}>
					<span className="grid size-[15px] shrink-0 place-items-center">
						<GitDiffIcon aria-hidden />
					</span>
					Git Changes
				</DropdownMenuItem>
			)}
			<DropdownMenuItem className={MENU_ROW} onSelect={() => setSettings(!settings)}>
				<span className="grid size-[15px] shrink-0 place-items-center">
					{settings ? <ChatTextIcon aria-hidden /> : <GearSixIcon aria-hidden />}
				</span>
				{settings ? "Back to Thread" : "Settings"}
			</DropdownMenuItem>
		</>
	);
}

/** The thread's status, priority, group and color, each showing the current one. */
function ThreadRows({ address }: { readonly address: string | undefined }) {
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
