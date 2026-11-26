import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Clone } from "@codeworksh/contract";
import { Effect, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { toast } from "sonner";

import type { Notice } from "@/components/banner";
import { useRowId } from "@/components/machine";
import { messageOf } from "@/lib/utils";
import { Server } from "../kernel/rpc";
import { placeAtom } from "../landing/place";

/**
 * Every clone a machine's server tracks (`""` is the default machine), as one list: the current one
 * first, then each change. Streamed only while something reads it, so a machine left or removed stops.
 */
const clonesAtom = Atom.family((machineId: string) =>
	Server.runtime.atom(
		Stream.unwrap(
			Server.use((client) => Effect.succeed(client("host.clones", machineId === "" ? {} : { machineId }))),
		).pipe(
			// A dropped stream is a reconnect; the next list is whole again.
			Stream.retry(Schedule.spaced("1 second")),
		),
	),
);

/** The machines a clone was started on while the app runs (`""` is the default machine); the toasts follow each. */
export const cloneMachinesAtom = Atom.make<ReadonlySet<string>>(new Set([""])).pipe(Atom.keepAlive);

/** Records that a clone starts on `machineId`, so its toasts follow it from then on. */
export function useWatchClones() {
	const set = useAtomSet(cloneMachinesAtom);
	return (machineId: string | undefined) =>
		set((machines) => (machines.has(machineId ?? "") ? machines : new Set([...machines, machineId ?? ""])));
}

const NONE: ReadonlyArray<Clone> = [];

/** The clones on `machineId`, else the default machine. */
export function useClones(machineId?: string) {
	const result = useAtomValue(clonesAtom(machineId ?? ""));
	return AsyncResult.isSuccess(result) ? result.value : NONE;
}

/** The clone into `path` on `machineId`, while its server tracks one. */
export function useClone(path: string | undefined, machineId?: string) {
	const clones = useClones(machineId);
	return path === undefined ? undefined : clones.find((clone) => clone.path === path);
}

const stageLabel = (stage: Clone["stage"]) => {
	switch (stage) {
		case "connecting":
			return "Connecting";
		case "counting":
			return "Counting objects";
		case "receiving":
			return "Receiving objects";
		case "resolving":
			return "Resolving deltas";
		case "checkout":
			return "Checking out files";
	}
};

/** The folder a clone goes into, by name. */
export const cloneDisplayName = (clone: Clone) => clone.path.split("/").findLast(Boolean) ?? clone.path;

/** Stage, percent, then stalled or git's own detail: "Receiving objects · 42% · 3.1 MiB | 2.0 MiB/s". */
export function cloneProgressSummary(clone: Clone) {
	const parts = [stageLabel(clone.stage)];
	if (clone.percent !== null) parts.push(`${clone.percent}%`);
	if (clone.stalled) parts.push("Stalled");
	else if (clone.detail) parts.push(clone.detail);
	return parts.join(" · ");
}

const cancelAtom = Server.mutation("host.cancel");
const retryAtom = Server.mutation("host.retry");
const discardAtom = Server.mutation("host.discard");

/**
 * Cancel, retry, and remove the project a clone was for: its partial checkout goes, and the start
 * page lets go of the folder when it is the one in front.
 */
export function useCloneActions(machineId?: string) {
	const cancel = useAtomSet(cancelAtom, { mode: "promise" });
	const retry = useAtomSet(retryAtom, { mode: "promise" });
	const discard = useAtomSet(discardAtom, { mode: "promise" });
	const setPlace = useAtomSet(placeAtom);
	const rowId = useRowId(machineId);
	const on = machineId === undefined ? {} : { machineId };
	return {
		cancel: (path: string) => cancel({ payload: { ...on, path } }),
		retry: (path: string) => retry({ payload: { ...on, path } }),
		remove: async (path: string) => {
			await discard({ payload: { ...on, path } });
			setPlace((place) =>
				place.kind === "folder" && place.path === path && place.machineId === rowId ? { kind: "none" } : place,
			);
		},
	};
}

/** A failed Cancel or Retry, said in a toast. */
export const failedAction = (title: string) => (cause: unknown) =>
	void toast.error(title, { description: messageOf(cause) || "An error occurred." });

/** Why a session can't start in `path` yet; undefined once its clone is done, or when there is none. */
export function cloneBlock(clone: Clone | undefined) {
	if (clone === undefined || clone.phase === "done") return undefined;
	return clone.phase === "running" ? "Cloning repository" : "Repository not cloned";
}

/** The composer's banner for the clone into `path` on `machineId`, while it isn't done. */
export function useCloneNotice(path: string | undefined, machineId?: string): Notice | undefined {
	const clone = useClone(path, machineId);
	const actions = useCloneActions(machineId);
	if (clone === undefined || clone.phase === "done") return undefined;
	const name = cloneDisplayName(clone);
	if (clone.phase === "running")
		return {
			tone: "info",
			title: `Cloning ${name}`,
			description: cloneProgressSummary(clone),
			actions: [
				{
					label: "Cancel",
					onClick: () => void actions.cancel(clone.path).catch(failedAction("Failed to cancel clone")),
				},
			],
		};
	const failed = clone.phase === "failed";
	return {
		tone: failed ? "error" : "warning",
		title: failed ? `Failed to clone ${name}` : `Cancelled cloning ${name}`,
		...(failed
			? clone.error === null
				? {}
				: { description: clone.error }
			: { description: "Retry to bring in the repository." }),
		actions: [
			{
				label: "Remove project",
				onClick: () => void actions.remove(clone.path).catch(failedAction("Failed to remove project")),
			},
			{
				label: "Retry",
				onClick: () => void actions.retry(clone.path).catch(failedAction("Failed to retry clone")),
			},
		],
	};
}
