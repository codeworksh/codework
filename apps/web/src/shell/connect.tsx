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

/** Connects this machine to `workspace`: shows the code it gets, and approves it as the signed-in member. */
export function ConnectDialog({
	workspace,
	onClose,
}: {
	workspace: { readonly id: string; readonly name: string };
	onClose: () => void;
}) {
	const progress = useAtomValue(connectAtom(workspace.id));
	const refreshMachine = useAtomRefresh(machineAtom);
	const approve = useAtomSet(approveAtom, { mode: "promise" });
	const [approving, setApproving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const event = AsyncResult.isSuccess(progress) ? progress.value : undefined;
	const failure = AsyncResult.isFailure(progress) ? messageOf(progress.cause) : null;
	const connected = event?._tag === "Connected";
	// The machine's own record of its workspaces changed; the menu reads it.
	useEffect(() => {
		if (connected) refreshMachine();
	}, [connected, refreshMachine]);

	const confirm = (userCode: string) => {
		setApproving(true);
		setError(null);
		approve({ userCode, workspaceId: workspace.id })
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => setApproving(false));
	};

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-5 text-sm sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Connect This Machine</DialogTitle>
					<DialogDescription>Link this machine to {workspace.name}.</DialogDescription>
				</DialogHeader>
				{connected ? (
					<p className="flex items-center gap-2 text-ink">
						<CheckCircleIcon size={18} className="shrink-0 text-ink" aria-hidden />
						Connected to {event.connected.workspace.name}.
					</p>
				) : event?._tag === "Code" ? (
					<div className="flex flex-col items-center gap-2 py-2">
						<span className="text-ink-muted">Code</span>
						<code className="font-mono text-2xl tracking-widest text-ink">{event.userCode}</code>
					</div>
				) : failure === null ? (
					<p className="text-ink-muted">Getting a code…</p>
				) : null}
				{(failure ?? error) !== null && <p className="text-destructive">{failure ?? error}</p>}
				<DialogFooter>
					{connected ? (
						<Button onClick={onClose}>Done</Button>
					) : (
						<>
							<Button variant="ghost" onClick={onClose}>
								Cancel
							</Button>
							<Button
								disabled={event?._tag !== "Code" || approving}
								onClick={() => event?._tag === "Code" && confirm(event.userCode)}
							>
								{approving ? "Approving…" : "Approve"}
							</Button>
						</>
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
