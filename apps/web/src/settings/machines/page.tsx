import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { RemoteServerStatus } from "@codeworksh/contract";
import { DevicesIcon, DotsThreeIcon, PlusIcon, UsersThreeIcon } from "@phosphor-icons/react";
import type { Relay } from "@codeworksh/schema";
import { Link } from "@tanstack/react-router";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { CopyCommand } from "@/components/copyable";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { messageOf } from "@/lib/utils";
import { isSignedInApp } from "../../auth";
import { machinesAtom, meAtom, reachAtom, relayFailure } from "../../kernel/relay";
import { Server } from "../../kernel/rpc";
import { useMachineAtom } from "../../shell/connect";
import { Group, Page, Placeholder, quietField, Row, SavingInput, Section } from "../blocks";
import { Done, EmptyState, SeenStatus, StatusDot } from "../controls";
import { Badge } from "../servers/local";
import { isPlain, PairDialog } from "./pair";
import {
	linkText,
	Loaded,
	MachineRow,
	membershipNote,
	RELAY_REFRESH_MS,
	Status,
	useMembership,
	usePaired,
	isReachable,
	useRefreshMachines,
	useWorkspace,
} from "./shared";
import { type Target, UnlinkDialog } from "./unlink";
import { Waiting } from "./waiting";

const renameAtom = Server.mutation("machine.rename");

/** This machine, the machines this computer is paired with, and those of the workspace the app works in. */
export function MachinesSettings() {
	const { ready, workspace } = useWorkspace();
	const paired = usePaired();
	return (
		<Page
			title="Machines"
			description={
				workspace === undefined
					? "Machines this computer is paired with"
					: `Machines this computer is paired with, and machines linked to ${workspace.name}`
			}
		>
			<ThisMachine workspace={workspace} ready={ready} />
			<Paired workspace={workspace} ready={ready} />
			{workspace !== undefined ? (
				<>
					<Waiting key={`waiting-${workspace.id}`} workspace={workspace} />
					<Linked
						key={`linked-${workspace.id}`}
						workspace={workspace}
						paired={AsyncResult.isSuccess(paired) ? paired.value : undefined}
					/>
				</>
			) : (
				// Signed in, the workspace's sections hold their place until the account is known.
				isSignedInApp &&
				!ready && (
					<>
						<Section title=" " description={"\u00a0"}>
							<Placeholder rows={1} />
						</Section>
						<Section title=" " description={"\u00a0"}>
							<Placeholder rows={2} />
						</Section>
					</>
				)
			)}
		</Page>
	);
}

function ThisMachine({
	workspace,
	ready,
}: {
	readonly workspace: Relay.Workspace | undefined;
	/** Whether the workspace is known yet: the last row depends on it, so the section waits for it. */
	readonly ready: boolean;
}) {
	const machineAtom = useMachineAtom();
	const machine = useAtomValue(machineAtom);
	const refresh = useAtomRefresh(machineAtom);
	const rename = useAtomSet(renameAtom, { mode: "promise" });
	const [error, setError] = useState<string | null>(null);
	const [unlinking, setUnlinking] = useState<Target | null>(null);
	const action = useRef<HTMLDivElement>(null);
	const membership = useMembership(
		AsyncResult.isSuccess(machine) ? machine.value.id : null,
		AsyncResult.isSuccess(machine) ? machine.value.workspaces : [],
		workspace,
	);
	const refreshMachines = useRefreshMachines(workspace);
	// The rows the answer brings, held from the start so nothing below moves when it lands.
	if (AsyncResult.isInitial(machine) || !ready || membership?.state === "loading") {
		return (
			<Section title="This Machine" description="The computer this app runs on">
				<Placeholder rows={workspace === undefined && ready ? 3 : 4} />
			</Section>
		);
	}
	if (!AsyncResult.isSuccess(machine)) {
		return (
			<Section title="This Machine" description="The computer this app runs on">
				<EmptyState title="Not Running" description="Start the local CodeWork server to name this machine" />
			</Section>
		);
	}
	const status = machine.value;
	const machineId = status.id;
	const name = status.givenName ?? status.localHostName;
	return (
		<Section title="This Machine" description="The computer this app runs on">
			<Loaded>
				<Group>
					<Row title="Label" description={error ?? "Shown to your linked workspaces"}>
						<SavingInput
							label="Machine label"
							value={status.givenName ?? ""}
							placeholder={status.localHostName}
							className={`w-full @min-[560px]:w-64 ${quietField}`}
							onCommit={(givenName) => {
								setError(null);
								rename({ payload: { givenName } })
									.then(refresh)
									.catch((cause: unknown) => setError(messageOf(cause)));
							}}
						/>
					</Row>
					<Row title="Hostname" description="Used when the label is empty">
						<div className="w-full min-w-0 shrink-0 @min-[560px]:w-auto @min-[560px]:max-w-64">
							<CopyCommand command={status.localHostName} label="Copy Hostname" />
						</div>
					</Row>
					<Row
						title="ID"
						description={status.id === null ? "Assigned when it first connects" : "It never changes"}
					>
						{status.id === null ? (
							<Badge tone="muted">Not Assigned</Badge>
						) : (
							<div className="w-full shrink-0 @min-[560px]:w-auto">
								<CopyCommand command={status.id} label="Copy ID" />
							</div>
						)}
					</Row>
					{workspace !== undefined && membership !== undefined && (
						<Row
							title={
								<span className="block truncate" title={linkText(membership, workspace)}>
									{linkText(membership, workspace)}
								</span>
							}
							description={
								membershipNote(membership) ??
								(membership.state === "linked"
									? "The workspace this machine belongs to"
									: `This machine isn’t linked to ${workspace.name} yet`)
							}
						>
							{/* Its control changes with the link; focus comes back to whichever is here. */}
							<div ref={action} className="contents">
								{membership.state === "linked" && machineId !== null ? (
									<Button
										size="sm"
										variant="secondary"
										className="min-w-28"
										disabled={membership.stale}
										onClick={() =>
											setUnlinking({
												name,
												workspace,
												machineId,
												keyId: membership.keyId,
												// A key it no longer holds is removed at the relay.
												via: membership.held ? { kind: "local" } : { kind: "relay" },
											})
										}
									>
										Unlink…
									</Button>
								) : (
									membership.state === "unlinked" && (
										<Button size="sm" className="min-w-28" asChild>
											<Link to="/settings/machines/setup">Link</Link>
										</Button>
									)
								)}
							</div>
						</Row>
					)}
				</Group>
			</Loaded>
			<UnlinkDialog
				target={unlinking}
				onClose={() => setUnlinking(null)}
				onDone={refreshMachines}
				returnFocus={() => action.current?.querySelector<HTMLElement>("a, button")}
			/>
		</Section>
	);
}

/** The machines this computer reaches with a pairing code, each opening its own page. */
function Paired({ workspace, ready }: { readonly workspace: Relay.Workspace | undefined; readonly ready: boolean }) {
	const paired = usePaired();
	const [pairing, setPairing] = useState(false);
	const section = useRef<HTMLDivElement>(null);
	// The dialog unmounts rather than closing, so focus is handed back by hand: to the button that opened
	// it, or once the empty card's button is gone, to the section's own.
	const opener = useRef<HTMLElement | null>(null);
	const close = () => {
		setPairing(false);
		requestAnimationFrame(() => {
			const target = opener.current?.isConnected
				? opener.current
				: section.current?.querySelector<HTMLElement>("[data-pair]:not([aria-hidden])");
			target?.focus();
		});
	};
	const open = (event: { readonly currentTarget: HTMLElement }) => {
		opener.current = event.currentTarget;
		setPairing(true);
	};
	// The machine paired a moment ago, marked where it landed.
	const [fresh, setFresh] = useState<string | null>(null);
	useEffect(() => {
		if (fresh === null) return;
		const timer = setTimeout(() => setFresh(null), 2400);
		return () => clearTimeout(timer);
	}, [fresh]);
	const list = AsyncResult.isSuccess(paired) && ready ? paired.value : undefined;
	return (
		<div ref={section}>
			<Section
				title="Paired Machines"
				count={list?.length}
				description="Reached directly from this computer"
				action={<PairButton hidden={list === undefined || list.length === 0} onClick={open} />}
			>
				{list === undefined ? (
					AsyncResult.isFailure(paired) ? (
						<p role="alert" className="text-xs font-book text-ink-muted">
							The app server did not answer.
						</p>
					) : (
						<Placeholder rows={2} />
					)
				) : list.length === 0 ? (
					<EmptyState
						icon={<DevicesIcon size={22} aria-hidden />}
						title="No Paired Machines"
						description="A machine you pair shows up here, and its threads in the sidebar"
						action={<PairButton primary onClick={open} />}
					/>
				) : (
					<Loaded>
						<Group>
							{list.map((server) => (
								<PairedRow key={server.id} server={server} workspace={workspace} fresh={server.id === fresh} />
							))}
						</Group>
					</Loaded>
				)}
				{pairing && (
					<PairDialog
						onClose={close}
						onPaired={(id) => {
							close();
							setFresh(id);
						}}
					/>
				)}
			</Section>
		</div>
	);
}

function PairButton({
	primary = false,
	hidden = false,
	onClick,
}: {
	readonly primary?: boolean;
	/** Held invisible, so the header keeps its height while the empty card offers the button. */
	readonly hidden?: boolean;
	readonly onClick: (event: { readonly currentTarget: HTMLElement }) => void;
}) {
	return (
		<Button
			size="sm"
			variant={primary ? "default" : "secondary"}
			data-pair
			className={hidden ? "invisible" : undefined}
			aria-hidden={hidden || undefined}
			tabIndex={hidden ? -1 : undefined}
			onClick={onClick}
		>
			<PlusIcon aria-hidden />
			Pair a Machine
		</Button>
	);
}

function PairedRow({
	server,
	workspace,
	fresh,
}: {
	readonly server: RemoteServerStatus;
	readonly workspace: Relay.Workspace | undefined;
	readonly fresh: boolean;
}) {
	const membership = useMembership(server.machineId, server.workspaces, workspace);
	const link = workspace === undefined ? undefined : linkText(membership, workspace);
	// Its page shows the address; the row keeps only whether the route is plain.
	const insecure = isPlain(server.url) ? "Insecure" : undefined;
	return (
		<MachineRow
			name={server.name}
			description={[link, insecure].filter((part) => part !== undefined).join(" · ")}
			status={fresh ? <Done>Paired</Done> : <Status server={server} />}
			open={server.id}
			className={`transition-colors duration-700 ease-out hover:duration-150 motion-reduce:transition-none ${fresh ? "bg-selection-subtle" : ""}`}
		/>
	);
}

/** Every machine Relay lists in the workspace: this machine first, then the newest. */
function Linked({
	workspace,
	paired,
}: {
	readonly workspace: Relay.Workspace;
	/** The paired machines; unknown until the app server answers, and the list waits for them. */
	readonly paired: ReadonlyArray<RemoteServerStatus> | undefined;
}) {
	const machines = useAtomValue(machinesAtom(workspace.id));
	const refresh = useAtomRefresh(machinesAtom(workspace.id));
	const machineAtom = useMachineAtom();
	const local = useAtomValue(machineAtom);
	const refreshLocal = useAtomRefresh(machineAtom);
	const me = useAtomValue(meAtom);
	const localId = AsyncResult.isSuccess(local) ? local.value.id : null;

	const accountId = AsyncResult.isSuccess(me) ? me.value.account.id : null;
	// Machines seen when the page opened; any other is new and arrives with a highlight.
	const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
	// The relay's list moves with changes made elsewhere; this machine's own record with a terminal's
	// connect or disconnect, and with a leaving link the relay confirmed.
	useEffect(() => {
		const timer = setInterval(() => {
			refresh();
			refreshLocal();
		}, RELAY_REFRESH_MS);
		return () => clearInterval(timer);
	}, [refresh, refreshLocal]);
	// Back in reach: ask now instead of on the next tick.
	const reach = useAtomValue(reachAtom);
	useEffect(() => {
		if (reach === "ok") refresh();
	}, [reach, refresh]);

	const title = `Linked to ${workspace.name}`;
	const about = `Machines that belong to ${workspace.name}`;
	if (AsyncResult.isInitial(machines) || AsyncResult.isInitial(local) || paired === undefined) {
		return (
			<Section title={title} description={about}>
				<Placeholder rows={2} />
			</Section>
		);
	}
	// Out of reach, the list the relay last gave stays, marked as such; with none yet, there is nothing to show.
	const last = AsyncResult.isFailure(machines) ? Option.getOrUndefined(machines.previousSuccess) : undefined;
	if (AsyncResult.isFailure(machines) && last === undefined) {
		return (
			<Section title={title} description={about}>
				<EmptyState title="Unavailable" description={relayFailure(machines.cause)} />
			</Section>
		);
	}
	const stale = last !== undefined;
	const all = AsyncResult.isSuccess(machines) ? machines.value : (last?.value ?? []);
	if (seen === null && AsyncResult.isSuccess(machines)) setSeen(new Set(all.map((machine) => machine.id)));
	// This machine first, then the newest: a machine just added appears where you are looking.
	const list = [
		...all.filter((machine) => machine.id === localId),
		...all.filter((machine) => machine.id !== localId).reverse(),
	];
	const byMachine = new Map(
		paired.flatMap((server) => (server.machineId === null ? [] : [[server.machineId, server] as const])),
	);
	const own = AsyncResult.isSuccess(local) ? local.value.workspaces : [];
	const holds = (links: ReadonlyArray<{ readonly id: string; readonly keyId: string }>, machine: Relay.Machine) =>
		links.some((link) => link.id === workspace.id && link.keyId === machine.keyId);
	// This machine, or a paired one that answers and holds the key, ends its own link; Relay removes any other.
	const unlinkOf = (machine: Relay.Machine): { relation: string; via: Target["via"]; allowed: boolean } => {
		if (machine.id === localId)
			return {
				relation: "This Machine",
				via: holds(own, machine) ? { kind: "local" } : { kind: "relay" },
				allowed: true,
			};
		const server = byMachine.get(machine.id);
		if (server !== undefined)
			return {
				relation: "Paired",
				via:
					isReachable(server) && holds(server.workspaces, machine)
						? { kind: "paired", serverId: server.id }
						: { kind: "relay", serverId: server.id },
				allowed: true,
			};
		return {
			relation: "Not Paired",
			via: { kind: "relay" },
			allowed: workspace.role !== "member" || machine.ownerId === accountId,
		};
	};
	return (
		<Section
			title={title}
			count={list.length}
			description={stale ? "Relay can’t be reached; this is its last status" : about}
		>
			<Loaded>
				{list.length === 0 ? (
					<EmptyState
						icon={<UsersThreeIcon size={22} aria-hidden />}
						title="No Linked Machines"
						description={`Machines that join ${workspace.name} show up here`}
					/>
				) : (
					<Group>
						{list.map((machine) => (
							<LinkedRow
								key={machine.keyId}
								machine={machine}
								workspace={workspace}
								{...unlinkOf(machine)}
								fresh={seen !== null && !seen.has(machine.id)}
								stale={stale}
								onGone={refresh}
							/>
						))}
					</Group>
				)}
			</Loaded>
		</Section>
	);
}

function LinkedRow({
	machine,
	workspace,
	relation,
	via,
	allowed,
	fresh,
	stale,
	onGone,
}: {
	readonly machine: Relay.Machine;
	readonly workspace: Relay.Workspace;
	/** How it relates to this computer, as the Paired section says how a machine relates to the workspace. */
	readonly relation: string;
	readonly via: Target["via"];
	/** Whether this person may unlink it. */
	readonly allowed: boolean;
	readonly fresh: boolean;
	/** The last list the relay gave, while it can't be reached: online state is unknown and nothing acts. */
	readonly stale: boolean;
	readonly onGone: () => void;
}) {
	const [leaving, setLeaving] = useState(false);
	const [tint, setTint] = useState(fresh);
	const [unlinking, setUnlinking] = useState<Target | null>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!tint) return;
		const timer = setTimeout(() => setTint(false), 1600);
		return () => clearTimeout(timer);
	}, [tint]);
	const name = machine.givenName ?? machine.localHostName;
	return (
		<div
			className={`grid transition-[grid-template-rows,opacity] duration-250 ease-(--ease-out) motion-reduce:transition-none ${leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`}
		>
			<div className="min-h-0 overflow-hidden">
				<MachineRow
					name={name}
					description={`${relation} · ${machine.os} ${machine.arch} · v${machine.version}`}
					id={machine.id}
					status={
						stale ? (
							<StatusDot tone="muted">Unknown</StatusDot>
						) : (
							<SeenStatus
								online={machine.online}
								seenAt={machine.lastSeenAt === null ? null : Date.parse(machine.lastSeenAt)}
							/>
						)
					}
					menu={
						!stale &&
						allowed && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										ref={trigger}
										size="icon-sm"
										variant="ghost"
										className="relative before:absolute before:-inset-1.5 before:content-['']"
										aria-label={`Actions for ${name} (${machine.id})`}
									>
										<DotsThreeIcon weight="bold" aria-hidden />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-52">
									<DropdownMenuItem
										variant="destructive"
										onSelect={() =>
											setUnlinking({
												name,
												workspace,
												machineId: machine.id,
												keyId: machine.keyId,
												via,
											})
										}
									>
										Unlink from {workspace.name}…
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)
					}
					className={`transition-colors duration-700 ease-out motion-reduce:transition-none ${tint ? "bg-selection-subtle" : ""} ${fresh ? "animate-in duration-300 ease-(--ease-out) fade-in-0 slide-in-from-top-1 motion-reduce:animate-none" : ""}`}
				/>
			</div>
			<UnlinkDialog
				target={unlinking}
				onClose={() => setUnlinking(null)}
				onDone={() => {
					setLeaving(true);
					setTimeout(onGone, 260);
				}}
				returnFocus={() => trigger.current}
			/>
		</div>
	);
}
