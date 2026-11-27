import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import type { RemoteServerStatus } from "@codeworksh/contract";
import type { Relay } from "@codeworksh/schema";
import { LinkBreakIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { BusyLabel } from "@/components/busy";
import { CopyCommand } from "@/components/copyable";
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
import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import { machinesAtom } from "../../kernel/relay";
import { Server } from "../../kernel/rpc";
import { removeAtom, updateAtom } from "../../kernel/servers";
import { useConnect } from "../../shell/connect";
import { Group, Placeholder, quietField, Row, SavingInput, Section } from "../blocks";
import { EmptyState } from "../controls";
import { Badge } from "./service";
import { Notice } from "./notice";
import { addressOf, isPlain, NOT_ENCRYPTED, urlOf } from "./pair";
import {
	Back,
	Failure,
	isReachable,
	linkText,
	type Membership,
	membershipNote,
	RELAY_REFRESH_MS,
	Status,
	Sub,
	useMembership,
	usePaired,
	useWorkspace,
} from "./shared";
import { type Target, UnlinkDialog } from "./unlink";

const labelAtom = Server.mutation("servers.label");

/** One paired machine, by its id. */
export function PairedMachine({ id }: { readonly id: string }) {
	const paired = usePaired();
	const { ready, workspace } = useWorkspace();
	if (!AsyncResult.isSuccess(paired) || !ready) {
		return (
			// A no-break space holds the title and status lines, so nothing moves when the machine arrives;
			// plain whitespace collapses.
			<Sub title={"\u00a0"} description={"\u00a0"}>
				{AsyncResult.isFailure(paired) ? (
					<p role="alert" className="text-xs font-book text-ink-muted">
						The app server did not answer.
					</p>
				) : (
					<Placeholder rows={4} />
				)}
			</Sub>
		);
	}
	const server = paired.value.find((each) => each.id === id);
	if (server === undefined) return <Missing />;
	// Keyed, so a failure or a half-done action on one machine never shows on the next one opened.
	return <Detail key={server.id} server={server} workspace={workspace} />;
}

/**
 * No paired machine has the id in the address: it was removed, or the link is old. It says so and
 * offers the list, in the card the list itself uses when it is empty.
 */
function Missing() {
	return (
		<div className="relative">
			<Back />
			<div className="mx-auto flex w-full max-w-settings flex-col px-5 pt-16 pb-16 text-ui sm:px-8">
				<h1 className="sr-only">Machine Not Found</h1>
				<EmptyState
					icon={<LinkBreakIcon size={22} aria-hidden />}
					title="Machine Not Found"
					description="It is no longer paired with this computer, or does not exist"
					action={
						<Button size="sm" variant="secondary" asChild>
							<Link to="/settings/machines">View Machines</Link>
						</Button>
					}
				/>
			</div>
		</div>
	);
}

function Detail({
	server,
	workspace,
}: {
	readonly server: RemoteServerStatus;
	readonly workspace: Relay.Workspace | undefined;
}) {
	const label = useAtomSet(labelAtom, { mode: "promise" });
	const update = useAtomSet(updateAtom, { mode: "promise" });
	const [labelError, setLabelError] = useState<string | null>(null);
	const [addressError, setAddressError] = useState<string | null>(null);
	const address = addressOf(server.url);
	const membership = useMembership(server.machineId, server.workspaces, workspace);
	const readdress = (typed: string) => {
		setAddressError(null);
		const url = urlOf(typed);
		if (url === "") return setAddressError("Enter the machine’s address.");
		if (url === server.url) return;
		update({ payload: { id: server.id, url } }).catch((cause: unknown) => setAddressError(messageOf(cause)));
	};
	return (
		<Sub
			title={server.name}
			description={
				<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
					<Status server={server} />
					{workspace !== undefined && linkText(membership, workspace) !== undefined && (
						<>
							<span aria-hidden>·</span>
							<span>{linkText(membership, workspace)}</span>
						</>
					)}
				</span>
			}
		>
			<Notice server={server} />
			<Section title="Machine">
				<Group>
					<Row title="Label" description={labelError ?? "Stored on the machine and shown wherever it appears"}>
						<SavingInput
							label="Machine label"
							value={server.label ?? ""}
							placeholder={server.host ?? undefined}
							className={`w-full @min-[560px]:w-64 ${quietField}`}
							onCommit={(next) => {
								setLabelError(null);
								label({ payload: { id: server.id, label: next } }).catch((cause: unknown) =>
									setLabelError(messageOf(cause)),
								);
							}}
						/>
					</Row>
					<Row title="Hostname" description="Used when the label is empty">
						{server.host ? (
							<div className="w-full min-w-0 shrink-0 @min-[560px]:w-auto @min-[560px]:max-w-64">
								<CopyCommand command={server.host} label="Copy Hostname" />
							</div>
						) : (
							<Badge tone="muted">Unknown</Badge>
						)}
					</Row>
					<Row
						title="ID"
						description={server.machineId === null ? "Shown once the machine answers" : "It never changes"}
					>
						{server.machineId === null ? (
							<Badge tone="muted">Unknown</Badge>
						) : (
							<div className="w-full shrink-0 @min-[560px]:w-auto">
								<CopyCommand command={server.machineId} label="Copy ID" />
							</div>
						)}
					</Row>
					<Row
						title="Address"
						description={
							addressError ??
							(isPlain(server.url) ? (
								<span className="text-warning">{NOT_ENCRYPTED}</span>
							) : (
								"Where this computer reaches it"
							))
						}
					>
						<SavingInput
							label="Machine address"
							value={address}
							placeholder="host or host:port"
							className={`w-full font-mono text-xs text-ellipsis @min-[560px]:w-64 md:text-xs ${quietField}`}
							onCommit={readdress}
						/>
					</Row>
					{server.paired && server.fingerprint !== null && (
						<Row title="Machine Key" description="Printed by codework service pair">
							<div className="w-full min-w-0 shrink-0 @min-[560px]:w-64">
								<CopyCommand command={server.fingerprint} label="Copy Machine Key" />
							</div>
						</Row>
					)}
					<Row title="Version">
						{server.version ? (
							<span className="font-mono text-xs text-ink-muted tabular-nums">v{server.version}</span>
						) : (
							<span className="text-xs text-ink-muted">Unknown</span>
						)}
					</Row>
				</Group>
			</Section>
			{workspace !== undefined && membership !== undefined && (
				<Section title="Workspace">
					{membership.state === "loading" ? (
						<Placeholder rows={1} />
					) : (
						<Group>
							<Membership server={server} workspace={workspace} membership={membership} />
						</Group>
					)}
				</Section>
			)}
			<Section title="Remove">
				<Group>
					<Row
						title="Remove from This Computer"
						description={
							membership?.state === "linked" && workspace !== undefined
								? `It stays linked to ${workspace.name}, and nothing on the machine is deleted`
								: "Its threads leave the sidebar, and nothing on the machine is deleted"
						}
					>
						<Remove server={server} />
					</Row>
				</Group>
			</Section>
		</Sub>
	);
}

/** Whether the machine is in the workspace, and the one action that changes it. */
function Membership({
	server,
	workspace,
	membership,
}: {
	readonly server: RemoteServerStatus;
	readonly workspace: Relay.Workspace;
	readonly membership: Membership;
}) {
	const [unlinking, setUnlinking] = useState<Target | null>(null);
	const [linking, setLinking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const action = useRef<HTMLDivElement>(null);
	// The relay decides the link: read it again after each change, and every so often for changes elsewhere.
	const refreshMachines = useAtomRefresh(machinesAtom(workspace.id));
	useEffect(() => {
		const timer = setInterval(refreshMachines, RELAY_REFRESH_MS);
		return () => clearInterval(timer);
	}, [refreshMachines]);
	const linked = membership.state === "linked";
	// Nothing acts on a membership the relay can't confirm now.
	const known = (membership.state === "linked" || membership.state === "unlinked") && !membership.stale;
	// Only a Machine that answers as itself can link, or end its own link.
	const reachable = isReachable(server);
	const target: Target | undefined =
		membership.state !== "linked" || server.machineId === null
			? undefined
			: {
					name: server.name,
					workspace,
					machineId: server.machineId,
					keyId: membership.keyId,
					// Only a machine that answers and holds the key ends the link itself; the relay removes any other.
					via:
						reachable && membership.held
							? { kind: "paired", serverId: server.id }
							: { kind: "relay", serverId: server.id },
				};
	const title = linkText(membership, workspace);
	// Why it can't link now, if it can't.
	const blocked =
		!server.paired || server.mismatch?.kind === "machine"
			? "Pair it again to link it"
			: server.mismatch?.kind === "clock"
				? "Fix the clocks to link it"
				: server.online
					? null
					: "Link it once it’s online";
	return (
		<>
			<Row
				title={
					<span className="block truncate" title={title}>
						{title}
					</span>
				}
				description={
					error === null && membershipNote(membership) !== undefined ? (
						membershipNote(membership)
					) : !linked && blocked !== null ? (
						blocked
					) : error !== null ? (
						<span role="alert" className="text-destructive">
							{error}
						</span>
					) : linked ? (
						`It shows up for everyone in ${workspace.name}`
					) : (
						`Link it to add it to ${workspace.name}`
					)
				}
			>
				{/* Its control changes with the link; focus comes back to whichever is here. */}
				<div ref={action} className="contents">
					{target !== undefined ? (
						<Button
							size="sm"
							variant="secondary"
							className="min-w-28"
							disabled={!known}
							onClick={() => setUnlinking(target)}
						>
							Unlink…
						</Button>
					) : (
						<Button
							size="sm"
							className="min-w-28"
							disabled={!known || blocked !== null || linking}
							onClick={() => {
								setError(null);
								setLinking(true);
							}}
						>
							<BusyLabel busy={linking} idle="Link" working="Linking…" />
						</Button>
					)}
				</div>
			</Row>
			{linking && (
				<Linking
					workspaceId={workspace.id}
					serverId={server.id}
					onEnd={(failure) => {
						setLinking(false);
						setError(failure);
						refreshMachines();
					}}
				/>
			)}
			<UnlinkDialog
				target={unlinking}
				onClose={() => setUnlinking(null)}
				onDone={refreshMachines}
				returnFocus={() => action.current?.querySelector<HTMLElement>("button")}
			/>
		</>
	);
}

/**
 * Links a paired machine while mounted: starts the connect on it, approves its code as the signed-in
 * member, and ends once the link arrives, or with the failure. Unmounting cancels the connect.
 */
function Linking({
	workspaceId,
	serverId,
	onEnd,
}: {
	readonly workspaceId: string;
	readonly serverId: string;
	readonly onEnd: (failure: string | null) => void;
}) {
	const { phase, error, act } = useConnect(workspaceId, serverId);
	const ended = error !== null ? error : phase === "connected" ? null : undefined;
	useEffect(() => {
		if (ended !== undefined) onEnd(ended);
		else if (phase === "code") act();
	});
	return null;
}

/** Forgets the machine here, once confirmed, and goes back to the list. */
function Remove({ server }: { readonly server: RemoteServerStatus }) {
	const remove = useAtomSet(removeAtom, { mode: "promise" });
	const navigate = useNavigate();
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirm = () => {
		setBusy(true);
		setError(null);
		remove({ payload: { id: server.id } })
			.then(() => navigate({ to: "/settings/machines" }))
			.catch((cause: unknown) => {
				setBusy(false);
				setError(messageOf(cause));
			});
	};
	return (
		<>
			<Button
				size="sm"
				variant="secondary"
				className="text-destructive hover:text-destructive"
				onClick={() => {
					setError(null);
					setAsking(true);
				}}
			>
				Remove…
			</Button>
			<AlertDialog open={asking} onOpenChange={(next) => !busy && setAsking(next)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="wrap-break-word">Remove {server.name}?</AlertDialogTitle>
						<AlertDialogDescription>
							Its threads leave this computer’s sidebar. Nothing on the machine is deleted. Pairing it again
							takes a new code.
						</AlertDialogDescription>
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
								confirm();
							}}
						>
							{busy ? "Removing…" : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
