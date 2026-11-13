import type { ChangesSpace, SpaceChanges, SpaceThread } from "@codeworksh/contract";
import { useAtomValue } from "@effect/atom-react";
import { UNTITLED } from "@codeworksh/widget/codework";
import { useShell } from "@codeworksh/widget/view";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
	CaretDownIcon,
	ChatsCircleIcon,
	CloudIcon,
	DesktopIcon,
	FolderIcon,
	GitBranchIcon,
	GitForkIcon,
	type Icon,
} from "@phosphor-icons/react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNowMinute } from "@/hooks/now";
import { capitalized } from "@/lib/utils";
import { threadAddress } from "../session/address";
import { useRunDisplay } from "../session/display";
import { RunMark } from "../session/run";
import { threadKey } from "../session/schema";
import { Ago, ago } from "../time";
import { spaceAtom } from "./data";

/** The end of a branch tells worktrees apart, so a long one is cut in its middle. */
const TAIL = 7;

/** Where a space is: its sandbox by its driver, else how its folder stands on this machine. */
const environmentOf = ({ kind, env }: ChangesSpace): { readonly label: string; readonly icon: Icon } => {
	if (env !== null)
		return { label: env.driver === undefined ? "Sandbox" : `${capitalized(env.driver)} Sandbox`, icon: CloudIcon };
	if (kind === "linked") return { label: "Worktree", icon: GitForkIcon };
	return { label: "Local", icon: DesktopIcon };
};

const refOf = (thread: SpaceThread) =>
	thread.main ? { sessionId: thread.sessionId } : { sessionId: thread.sessionId, threadId: thread.id };

/**
 * The space the changes are of, and the threads sharing its working tree: the changes are every
 * thread's there, not one's.
 */
export function Space({ space, status }: { readonly space: string; readonly status: SpaceChanges }) {
	const where = Option.getOrNull(AsyncResult.value(useAtomValue(spaceAtom(space))));
	const span = ago(status.observedAt, useNowMinute());
	const branch = status.branch ?? status.head?.slice(0, 7);
	const cut = branch !== undefined && branch.length > TAIL * 2 ? branch.length - TAIL : branch?.length;
	const environment = where === null ? undefined : environmentOf(where);
	return (
		// Narrow, the freshness goes first, then the environment's name; the branch is cut; the folder stays.
		<div className="flex h-7 shrink-0 items-center gap-3 border-b border-edge px-3 text-2xs whitespace-nowrap text-ink-muted">
			{where !== null && (
				<span title={where.location} className="flex shrink-0 items-center gap-1.5 font-medium text-ink">
					<FolderIcon className="size-3 shrink-0 text-ink-muted" aria-hidden />
					{where.location.split(/[\\/]/).findLast((part) => part !== "") ?? where.location}
				</span>
			)}
			{branch !== undefined && (
				<span title={branch} className="flex min-w-0 items-center gap-1.5 text-ink-secondary">
					<GitBranchIcon className="size-3 shrink-0 text-ink-muted" aria-hidden />
					<span className="flex min-w-0">
						<span className="truncate">{branch.slice(0, cut)}</span>
						<span className="shrink-0">{branch.slice(cut)}</span>
					</span>
				</span>
			)}
			{environment !== undefined && (
				<span title={environment.label} className="flex shrink-0 items-center gap-1.5">
					<environment.icon className="size-3 shrink-0" aria-hidden />
					<span className="@max-lg:sr-only">{environment.label}</span>
				</span>
			)}
			<span className="shrink-0 tabular-nums @max-lg:hidden">
				Updated {span === "now" ? "Just Now" : `${span} Ago`}
			</span>
			{where !== null && where.threads.length > 0 && <Threads threads={where.threads} />}
		</div>
	);
}

function Threads({ threads }: { readonly threads: ReadonlyArray<SpaceThread> }) {
	const [open, setOpen] = useState(false);
	const shell = useShell();
	const shared = threads.length > 1;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger className="relative ml-auto flex h-5 shrink-0 items-center gap-1.5 rounded-md bg-ink/5 pr-1 pl-1.5 font-medium text-ink-secondary outline-none transition-[scale,background-color,color] duration-150 ease-out before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] hover:bg-ink/10 hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/25 active:scale-[0.96] data-[state=open]:bg-ink/10 data-[state=open]:text-ink">
				<ChatsCircleIcon className="size-3 shrink-0" aria-hidden />
				<span className="tabular-nums">{shared ? `Shared by ${threads.length} Threads` : "1 Thread"}</span>
				<CaretDownIcon className="size-2.5 shrink-0 text-ink-muted" aria-hidden />
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="max-h-80 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto p-1 data-[state=closed]:zoom-out-[0.96] data-[state=open]:zoom-in-[0.96]"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<p className="truncate px-2 pt-1 pb-1 text-2xs text-ink-muted">
					{shared ? "Changes from Every Thread in This Space" : "The Only Thread in This Space"}
				</p>
				{threads.map((thread) => (
					<Row
						key={thread.id}
						thread={thread}
						onClick={() => {
							setOpen(false);
							shell.open(threadAddress(refOf(thread)), { placement: "next" });
						}}
					/>
				))}
			</PopoverContent>
		</Popover>
	);
}

/** A thread as dense as the sidebar's: its run, its title (then its session's when they differ), its last activity. */
function Row({ thread, onClick }: { readonly thread: SpaceThread; readonly onClick: () => void }) {
	const display = useRunDisplay([{ key: threadKey(refOf(thread)), runState: thread.runState }]);
	const title = thread.title ?? UNTITLED;
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex h-[26px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui text-ink outline-none transition-colors duration-150 ease-out hover:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
		>
			<span className="grid w-3 shrink-0 place-items-center text-ink-muted">
				<RunMark display={display} idle={<span className="size-1.5 rounded-full bg-ink-muted/40" aria-hidden />} />
			</span>
			<span title={title} className="min-w-0 truncate">
				{title}
				{thread.sessionName !== title && <span className="text-ink-muted"> · {thread.sessionName}</span>}
			</span>
			<span
				className={`ml-auto shrink-0 text-2xs tabular-nums ${display === "idle" ? "text-ink-muted" : "text-ink-secondary"}`}
			>
				{display === "idle" ? <Ago time={thread.updatedAt} /> : "Running"}
			</span>
		</button>
	);
}
