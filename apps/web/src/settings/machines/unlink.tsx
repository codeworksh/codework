import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import type { Relay } from "@codeworksh/schema";
import { useState } from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { relayFailure, removeMachineAtom } from "../../kernel/relay";

import { disconnectAtom, useMachineAtom } from "../../shell/connect";
import { Failure } from "./shared";

/** A machine's link to a workspace, and who ends it. */
export interface Target {
	readonly name: string;
	readonly workspace: Relay.Workspace;
	readonly machineId: string;
	readonly keyId: string;
	/**
	 * This machine, or one paired with this computer, ends its own link; any other is removed from the
	 * relay by its owner or a workspace owner or admin. A paired one that can't be asked names its server.
	 */
	readonly via:
		| { readonly kind: "local" }
		| { readonly kind: "paired"; readonly serverId: string }
		| { readonly kind: "relay"; readonly serverId?: string };
}

const descriptionOf = ({ workspace, via }: Target) => {
	switch (via.kind) {
		case "local":
			return `It leaves ${workspace.name}. Link it again from here.`;
		case "paired":
			return `It leaves ${workspace.name}. This computer stays paired with it.`;
		case "relay":
			return via.serverId === undefined
				? `It leaves ${workspace.name}. It can join again with codework connect.`
				: `It leaves ${workspace.name}.`;
	}
};

/** Ends a link once confirmed. It stays open with the failure until the link is gone. */
export function UnlinkDialog({
	target,
	onClose,
	onDone,
	returnFocus,
}: {
	readonly target: Target | null;
	readonly onClose: () => void;
	readonly onDone?: () => void;
	/** Where focus goes when it closes: the control that opened it, or what took its place. */
	readonly returnFocus: () => HTMLElement | null | undefined;
}) {
	const disconnect = useAtomSet(disconnectAtom, { mode: "promise" });
	const remove = useAtomSet(removeMachineAtom, { mode: "promise" });

	const refreshLocal = useAtomRefresh(useMachineAtom());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Kept while it closes, so its text doesn't blank out mid-exit.
	const [shown, setShown] = useState(target);
	if (target !== null && target !== shown) {
		setShown(target);
		setError(null);
	}
	const confirm = (target: Target) => {
		const { workspace, machineId, keyId, via } = target;
		const removeAsPerson = (afterDisconnect: boolean) =>
			remove({ workspaceId: workspace.id, machineId, keyId, afterDisconnect });
		const left =
			via.kind === "relay"
				? // A paired machine's link may be gone from the relay already.
					removeAsPerson(via.serverId !== undefined)
				: disconnect({
						payload: {
							workspaceId: workspace.id,
							keyId,
							...(via.kind === "paired" ? { serverId: via.serverId } : {}),
						},
					})
						// The machine couldn't reach the relay: remove it as the signed-in person instead. If that
						// fails too, the machine keeps the link as leaving and revokes it once it reaches the relay.
						.then(({ revoked }) => (revoked ? undefined : removeAsPerson(true).catch(() => undefined)))
						.finally(() => {
							if (via.kind === "local") refreshLocal();
						});
		setBusy(true);
		setError(null);
		left
			.then(() => {
				onClose();
				onDone?.();
			})
			.catch((cause: unknown) => setError(relayFailure(cause)))
			.finally(() => setBusy(false));
	};
	return (
		<AlertDialog open={target !== null} onOpenChange={(next) => !next && !busy && onClose()}>
			<AlertDialogContent
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					requestAnimationFrame(() => returnFocus()?.focus());
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle className="wrap-break-word">Unlink {shown?.name}?</AlertDialogTitle>
					<AlertDialogDescription>{shown === null ? "" : descriptionOf(shown)}</AlertDialogDescription>
					{error !== null && <Failure>{error}</Failure>}
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={busy}
						onClick={(event) => {
							// Held open until the call returns, so a failure shows here.
							event.preventDefault();
							if (target !== null) confirm(target);
						}}
					>
						{busy ? "Unlinking…" : "Unlink"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
