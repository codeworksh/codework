import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { Effect, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { messageOf } from "@/lib/utils";
import { approveAtom } from "../kernel/relay";
import { Server } from "../kernel/rpc";

/** This machine (the default CodeWork server) and the workspaces it is connected to. */
export const machineAtom = Server.query("machine.info", undefined);

/**
 * A connect of this machine to one workspace, running while something reads it: the latest of its
 * events, the code to approve and then the link. Closing the dialog that reads it cancels the connect.
 */
const connectAtom = Atom.family((workspaceId: string) =>
	Server.runtime.atom(
		Stream.unwrap(Server.use((client) => Effect.succeed(client("machine.connect", { workspaceId })))),
	),
);

/** A connect failure in people's words: a network failure reads as one; the CLI's own message otherwise. */
const unreachable = /transport error|fetch failed|econnrefused|enotfound|etimedout|network/i;
const connectFailure = (message: string) =>
	unreachable.test(message) ? "Can't reach CodeWork's servers. Check your connection, then try again." : message;

/**
 * Connects this machine to a workspace while mounted, and approves its code as the signed-in member.
 * After Approve it holds as `approved` until the link arrives, which the relay reports on its next poll
 * a few seconds later, so the code is never approved twice. Unmounting cancels the connect.
 */
export function useConnect(workspaceId: string) {
	const progress = useAtomValue(connectAtom(workspaceId));
	const restart = useAtomRefresh(connectAtom(workspaceId));
	const refreshMachine = useAtomRefresh(machineAtom);
	const approve = useAtomSet(approveAtom, { mode: "promise" });
	const [sent, setSent] = useState<"approving" | "approved" | null>(null);
	// The approved code stays on screen once the stream moves past it, until the link folds the step.
	const [approved, setApproved] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const event = AsyncResult.isSuccess(progress) ? progress.value : undefined;
	const failure = AsyncResult.isFailure(progress) ? connectFailure(messageOf(progress.cause)) : null;
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
					setError(connectFailure(messageOf(cause)));
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

/** Connects this machine to `workspace`: shows the code it gets, and approves it as the signed-in member. */
export function ConnectDialog({
	workspace,
	onClose,
}: {
	workspace: { readonly id: string; readonly name: string };
	onClose: () => void;
}) {
	const connect = useConnect(workspace.id);
	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-5 text-sm sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Connect This Machine</DialogTitle>
					<DialogDescription>Link this machine to {workspace.name}.</DialogDescription>
				</DialogHeader>
				{connect.linked === undefined ? (
					<div className="flex flex-col items-center gap-2 py-2">
						<span className="text-ink-muted">Code</span>
						<CodeSlot code={connect.code} />
					</div>
				) : (
					<p className="flex items-center gap-2 text-ink">
						<CheckCircleIcon size={18} className="shrink-0 text-ink" aria-hidden />
						Connected to {connect.linked.workspace.name}.
					</p>
				)}
				{connect.error !== null && <p className="text-destructive">{connect.error}</p>}
				<DialogFooter>
					{connect.linked === undefined ? (
						<>
							<Button variant="ghost" onClick={onClose}>
								Cancel
							</Button>
							<Button className="min-w-28" disabled={!canAct(connect.phase)} onClick={connect.act}>
								{approveLabel(connect.phase)}
							</Button>
						</>
					) : (
						<Button onClick={onClose}>Done</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Approves a code another machine showed after `codework connect`, for `workspace`. */
export function ApproveDialog({
	workspace,
	onClose,
}: {
	workspace: { readonly id: string; readonly name: string };
	onClose: () => void;
}) {
	const approve = useAtomSet(approveAtom, { mode: "promise" });
	const [code, setCode] = useState("");
	const [approving, setApproving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [approved, setApproved] = useState<string | null>(null);

	const submit = () => {
		setApproving(true);
		setError(null);
		approve({ userCode: code.trim().toUpperCase(), workspaceId: workspace.id })
			.then((machine) => setApproved(machine.givenName ?? machine.localHostName))
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => setApproving(false));
	};

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-5 text-sm sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Approve a Machine</DialogTitle>
					<DialogDescription>
						Enter the code `codework connect` showed, to add that machine to {workspace.name}.
					</DialogDescription>
				</DialogHeader>
				{approved === null ? (
					<Input
						autoFocus
						value={code}
						placeholder="ABCD-EFGH"
						aria-label="Code"
						className="font-mono tracking-widest"
						onChange={(event) => setCode(event.target.value)}
						onKeyDown={(event) => event.key === "Enter" && code.trim() !== "" && !approving && submit()}
					/>
				) : (
					<p className="flex items-center gap-2 text-ink">
						<CheckCircleIcon size={18} className="shrink-0 text-ink" aria-hidden />
						{approved} joined {workspace.name}.
					</p>
				)}
				{error !== null && <p className="text-destructive">{error}</p>}
				<DialogFooter>
					{approved === null ? (
						<>
							<Button variant="ghost" onClick={onClose}>
								Cancel
							</Button>
							<Button disabled={code.trim() === "" || approving} onClick={submit}>
								{approving ? "Approving…" : "Approve"}
							</Button>
						</>
					) : (
						<Button onClick={onClose}>Done</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
