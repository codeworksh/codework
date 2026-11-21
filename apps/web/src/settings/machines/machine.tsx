import { useAtomSet } from "@effect/atom-react";
import type { RemoteServerStatus } from "@codeworksh/contract";
import type { Relay } from "@codeworksh/schema";
import { CaretLeftIcon, LinkBreakIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useRef, useState } from "react";

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
import { Server } from "../../kernel/rpc";
import { removeAtom, updateAtom } from "../../kernel/servers";
import { useConnect } from "../../shell/connect";
import { Group, Page, Placeholder, quietField, Row, SavingInput, Section } from "../blocks";
import { EmptyState } from "../controls";
import { Badge } from "../servers/local";
import { addressOf, isPlain, NOT_ENCRYPTED, PairAgain, urlOf } from "./pair";
import { isLinked, linkText, Status, usePaired, useWorkspace } from "./shared";
import { type Target, UnlinkDialog } from "./unlink";

const labelAtom = Server.mutation("servers.label");

/** One paired machine, by its id. */
export function PairedMachine({ id }: { readonly id: string }) {
	const paired = usePaired();
	const { ready, workspace } = useWorkspace();
	if (!AsyncResult.isSuccess(paired) || !ready) {
		return (
			// A blank title holds its line, so nothing moves when the machine arrives.
			<Sub title={" "}>
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
	return <Detail server={server} workspace={workspace} />;
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

/** The way back to the list, in the panel's top-left corner, outside the content column. */
function Back({ focus = false }: { readonly focus?: boolean }) {
	const back = useRef<HTMLAnchorElement>(null);
	// The link that led here is gone with the list; focus lands on the way back instead of the page.
	useEffect(() => {
		if (focus) back.current?.focus({ preventScroll: true });
	}, [focus]);
	return (
		<Link
			ref={back}
			to="/settings/machines"
			className="absolute top-2.5 left-2 flex h-7 items-center gap-1 rounded-full pr-2.5 pl-1.5 text-ui font-medium text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
		>
			<CaretLeftIcon size={14} className="shrink-0" aria-hidden />
			Machines
		</Link>
	);
}

/**
 * A page under the list. The way back sits in the panel's top-left corner, outside the column, so the
 * title stays where the list's title is.
 */
function Sub({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description?: ReactNode;
	readonly children?: ReactNode;
}) {
	return (
		<div className="relative">
			<Back focus />
			<Page title={title} description={description}>
				{children}
			</Page>
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
	const linked = workspace !== undefined && isLinked(server, workspace);
	const readdress = (typed: string) => {
		setAddressError(null);
		const url = urlOf(typed);
		if (url === "") return setAddressError("Enter the Machine’s address.");
		if (url === server.url) return;
		update({ payload: { id: server.id, url } }).catch((cause: unknown) => setAddressError(messageOf(cause)));
	};
	return (
		<Sub
			title={server.name}
			description={
				<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					<Status server={server} />
					{workspace !== undefined && <span className="text-xs">{linkText(linked, workspace)}</span>}
				</span>
			}
		>
			{(!server.paired || server.mismatch === "machine") && (
				<Section
					title="Pair Again"
					description={
						server.paired
							? "This address answers as a different Machine"
							: "This computer is no longer paired with it"
					}
				>
					<Group>
						<PairAgain server={server} />
					</Group>
				</Section>
			)}
			{server.paired && server.mismatch === "clock" && (
				<Section title="Clock Is Off" description="This computer’s clock differs from the Machine’s">
					{null}
				</Section>
			)}
			<Section title="Machine">
				<Group>
					<Row title="Label" description={labelError ?? "Stored on the Machine and shown wherever it appears"}>
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
					<Row title="Hostname" description="The computer’s own name">
						{server.host ? (
							<div className="w-full min-w-0 shrink-0 @min-[560px]:w-auto @min-[560px]:max-w-64">
								<CopyCommand command={server.host} label="Copy Hostname" />
							</div>
						) : (
							<Badge tone="muted">Unknown</Badge>
						)}
					</Row>
					<Row
						title="Address"
						description={addressError ?? (isPlain(server.url) ? NOT_ENCRYPTED : "Where this computer reaches it")}
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
							<code className="w-full font-mono text-xs break-all text-ink-muted @min-[560px]:w-64">
								{server.fingerprint}
							</code>
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
			{workspace !== undefined && (
				<Section title="Workspace">
					<Group>
						<Membership server={server} workspace={workspace} linked={linked} />
					</Group>
				</Section>
			)}
			<Section title="Remove">
				<Group>
					<Row
						title="Remove from This Computer"
						description={
							linked && workspace !== undefined
								? `It stays Linked to ${workspace.name}, and nothing on the Machine is deleted`
								: "Its threads leave the sidebar, and nothing on the Machine is deleted"
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
	linked,
}: {
	readonly server: RemoteServerStatus;
	readonly workspace: Relay.Workspace;
	readonly linked: boolean;
}) {
	const [unlinking, setUnlinking] = useState<Target | null>(null);
	const [linking, setLinking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const action = useRef<HTMLDivElement>(null);
	const link = server.workspaces.find((each) => each.id === workspace.id);
	const target: Target | undefined =
		link === undefined || server.machineId === null
			? undefined
			: {
					name: server.name,
					workspace,
					machineId: server.machineId,
					keyId: link.keyId,
					// Without its pairing it can't be asked; its link is removed at the relay instead.
					via: server.paired ? { kind: "paired", serverId: server.id } : { kind: "relay" },
				};
	const title = linkText(linked, workspace);
	return (
		<>
			<Row
				title={
					<span className="block truncate" title={title}>
						{title}
					</span>
				}
				description={
					error !== null ? (
						<span role="alert" className="text-destructive">
							{error}
						</span>
					) : linked ? (
						`It shows up for everyone in ${workspace.name}`
					) : server.paired ? (
						`Link it to add it to ${workspace.name}`
					) : (
						"Pair it again to Link it"
					)
				}
			>
				{/* Its control changes with the link; focus comes back to whichever is here. */}
				<div ref={action} className="contents">
					{target !== undefined ? (
						<Button size="sm" variant="secondary" className="min-w-28" onClick={() => setUnlinking(target)}>
							Unlink…
						</Button>
					) : (
						<Button
							size="sm"
							className="min-w-28"
							disabled={!server.paired || linking}
							onClick={() => {
								setError(null);
								setLinking(true);
							}}
						>
							<BusyLabel busy={linking} idle={`Link to ${workspace.name}`} working="Linking…" />
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
					}}
				/>
			)}
			<UnlinkDialog
				target={unlinking}
				onClose={() => setUnlinking(null)}
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
							Its threads leave this computer’s sidebar. Nothing on the Machine is deleted, and it can be paired
							again.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error !== null && <p className="text-xs text-destructive">{error}</p>}
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
