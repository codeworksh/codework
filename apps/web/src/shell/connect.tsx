import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { approveAtom, relayFailure } from "../kernel/relay";
import { Server } from "../kernel/rpc";
import { defaultServerAtom } from "../kernel/servers";

/** This machine (the default CodeWork server) and the workspaces it is connected to. */
export function useMachineAtom() {
	const home = useAtomValue(defaultServerAtom)?.home.path;
	return Server.query("machine.info", undefined, { reactivityKeys: ["codework", home] });
}

/** Disconnects this machine, or a paired one by its `serverId`, from a workspace. */
export const disconnectAtom = Server.mutation("machine.disconnect");

/**
 * A connect of a machine to one workspace, running while something reads it: the latest of its events,
 * the code to approve and then the link. Closing the dialog that reads it cancels the connect. Keyed by
 * `<serverId>/<workspaceId>`, with no server id for this machine.
 */
const connectAtom = Atom.family((key: string) => {
	const [serverId = "", workspaceId = ""] = key.split("/");
	const payload = serverId === "" ? { workspaceId } : { workspaceId, serverId };
	return Server.runtime.atom(
		Stream.unwrap(Server.use((client) => Effect.succeed(client("machine.connect", payload)))),
	);
});

/**
 * Connects this machine, or the paired machine `serverId`, to a workspace while mounted, and approves
 * its code as the signed-in member. After Approve it holds as `approved` until the link arrives, which
 * the relay reports on its next poll a few seconds later, so the code is never approved twice.
 * Unmounting cancels the connect.
 */
export function useConnect(workspaceId: string, serverId?: string) {
	const key = `${serverId ?? ""}/${workspaceId}`;
	const progress = useAtomValue(connectAtom(key));
	const restart = useAtomRefresh(connectAtom(key));
	const refreshMachine = useAtomRefresh(useMachineAtom());
	const approve = useAtomSet(approveAtom, { mode: "promise" });
	const [sent, setSent] = useState<"approving" | "approved" | null>(null);
	// The approved code stays on screen once the stream moves past it, until the link folds the step.
	const [approved, setApproved] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const event = AsyncResult.isSuccess(progress) ? progress.value : undefined;
	const failure = AsyncResult.isFailure(progress) ? relayFailure(progress.cause) : null;
	const linked = event?._tag === "Connected" ? event.connected : undefined;
	const code = event?._tag === "Code" ? event.userCode : approved;
	// The machine's own record of its workspaces changed; the menu and setup read it.
	useEffect(() => {
		if (linked !== undefined) refreshMachine();
	}, [linked, refreshMachine]);
	const phase =
		linked !== undefined
			? "connected"
			: failure !== null
				? "failed"
				: (sent ?? (code === undefined ? "starting" : "code"));
	return {
		phase,
		code,
		/** Whether Cancel can still stop it: not once approved. */
		cancellable: phase !== "approved" && phase !== "connected",
		linked,
		error: failure ?? error,
		/** Approves the code, or after a failure starts the connect again for a new one. */
		act: () => {
			if (failure !== null) {
				setSent(null);
				setApproved(undefined);
				setError(null);
				restart();
				return;
			}
			if (code === undefined || sent !== null) return;
			setSent("approving");
			setApproved(code);
			setError(null);
			approve({ userCode: code, workspaceId }).then(
				() => setSent("approved"),
				(cause: unknown) => {
					setError(relayFailure(cause));
					setSent(null);
				},
			);
		},
	};
}

/** What the approve button says in each phase; its width is held so the row doesn't move. */
export const approveLabel = (phase: ReturnType<typeof useConnect>["phase"]) =>
	phase === "approving"
		? "Approving…"
		: phase === "approved"
			? "Connecting…"
			: phase === "connected"
				? "Connected"
				: phase === "failed"
					? "Try Again"
					: "Approve";

/** Whether the approve button does anything now: Approve with a code, or Try Again after a failure. */
export const canAct = (phase: ReturnType<typeof useConnect>["phase"]) => phase === "code" || phase === "failed";

/** A code's slot: dots until the code comes, at the same width, so nothing shifts when it does. */
export function CodeSlot({ code }: { readonly code: string | undefined }) {
	return (
		<code
			aria-live="polite"
			aria-label={code === undefined ? "Getting a code" : `Code ${code}`}
			className={`font-mono text-base tracking-widest ${code === undefined ? "text-ink-muted/40" : "text-ink"}`}
		>
			{code ?? "····-····"}
		</code>
	);
}
