import { useAtomValue } from "@effect/atom-react";
import { GitBranchIcon, GitForkIcon, HardDrivesIcon, LaptopIcon } from "@phosphor-icons/react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";

import { availabilityOf, useMachineName, useReason } from "@/components/machine";
import { serversAtom } from "@/kernel/servers";
import { statusAtom } from "../changes/data";
import { projectsAtom } from "./projects";
import type { Info, ThreadRef } from "./schema";

/** The end of a branch tells worktrees apart, so a long one is cut in its middle. */
const TAIL = 7;

/**
 * Where the session runs, under its composer: the machine and whether it can be reached, then the
 * branch, with a fork for a worktree. A folder without git shows no branch.
 */
export function SessionPlace({ thread, info }: { readonly thread: ThreadRef; readonly info: Info }) {
	const servers = useAtomValue(serversAtom);
	const projects = useAtomValue(projectsAtom);
	const name = useMachineName(info.machineId);
	const status = AsyncResult.isSuccess(servers)
		? servers.value.find((candidate) => candidate.id === info.machineId)
		: undefined;
	const availability = status === undefined ? undefined : availabilityOf(status);
	const reason = useReason({ availability: availability ?? { kind: "ready" } });
	const changes = Option.getOrUndefined(
		AsyncResult.value(useAtomValue(statusAtom(`${info.machineId}/${info.spaceId}`))),
	);
	const branch = changes?.branch ?? changes?.head?.slice(0, 7);
	// The sidebar knows its session's space; a fork may sit in another one, so only the main thread asks.
	const worktree =
		thread.threadId === undefined &&
		AsyncResult.isSuccess(projects) &&
		projects.value.some((project) =>
			project.sessions.some((session) => session.id === thread.sessionId && session.spaceKind === "linked"),
		);

	const Machine = status?.kind === "local" ? LaptopIcon : HardDrivesIcon;
	const Branch = worktree ? GitForkIcon : GitBranchIcon;
	const cut = branch !== undefined && branch.length > TAIL * 2 ? branch.length - TAIL : branch?.length;
	return (
		// Always laid out, so the composer keeps its height while the machine and branch load.
		<div className="flex h-6 min-w-0 flex-1 items-center gap-3 text-[12px] whitespace-nowrap text-ink-muted">
			{name !== undefined && availability !== undefined && (
				<span
					title={[name, status?.host, reason ?? "Online"].filter(Boolean).join("\n")}
					className="flex min-w-0 items-center gap-1.5"
				>
					<Machine className="size-3.5 shrink-0" aria-hidden />
					<span className="truncate text-ink-secondary">{name}</span>
					<span
						aria-hidden
						className={`size-1.5 shrink-0 rounded-full ${reason === null ? "bg-success" : "bg-ink-muted/60"}`}
					/>
					<span className={reason === null ? "sr-only" : "shrink-0"}>{reason ?? "Online"}</span>
				</span>
			)}
			{branch !== undefined && (
				<span
					title={worktree ? `${branch}\nWorktree` : branch}
					className="flex max-w-[45%] min-w-0 items-center gap-1.5"
				>
					<Branch className="size-3 shrink-0" aria-hidden />
					{worktree && <span className="sr-only">Worktree, </span>}
					<span className="flex min-w-0">
						<span className="truncate">{branch.slice(0, cut)}</span>
						<span className="shrink-0">{branch.slice(cut)}</span>
					</span>
				</span>
			)}
		</div>
	);
}
