import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { CaretRightIcon, CheckCircleIcon, DesktopTowerIcon, DotsThreeIcon } from "@phosphor-icons/react";
import type { Relay } from "@codeworksh/schema";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useRef, useState } from "react";

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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { messageOf } from "@/lib/utils";
import { approveAtom, declineAtom, machinesAtom, meAtom, pairingsAtom, removeMachineAtom } from "../kernel/relay";
import { Server } from "../kernel/rpc";
import { disconnectAtom, machineAtom } from "../shell/connect";
import { Ago } from "../widgets/time";
import { Group, Page, quietField, Row, SavingInput, Section } from "./blocks";
import { EmptyState, StatusDot } from "./controls";
import { Badge } from "./servers/local";

const renameAtom = Server.mutation("machine.rename");

/** How often the list asks the relay again, so online and offline stay current while it is open. */
const REFRESH_MS = 15_000;
/** How often pending connects are asked for: a person is usually waiting at the other machine. */
const PENDING_MS = 5_000;

/** The machines of the workspace in the URL, this machine, and machines waiting to join. */
export function MachinesSettings({ workspaceId }: { readonly workspaceId: string }) {
	const me = useAtomValue(meAtom);
	const workspace = AsyncResult.isSuccess(me)
		? me.value.workspaces.find((option) => option.id === workspaceId)
		: undefined;
	return (
		<Page
			title="Machines"
			description={
				workspace === undefined
					? "Machines Connected to your Workspace"
					: `Machines Connected to ${workspace.name}, and this Machine's name`
			}
		>
			<ThisMachine workspace={workspace} />
			{workspace === undefined ? (
				<EmptyState
					icon={<DesktopTowerIcon size={22} aria-hidden />}
					title="No Workspace"
					description="Your Workspace couldn't be loaded, so its Machines are unknown."
				/>
			) : (
				<>
					<Waiting workspace={workspace} />
					<WorkspaceMachines workspace={workspace} />
				</>
			)}
		</Page>
	);
}

function ThisMachine({ workspace }: { readonly workspace: Relay.Workspace | undefined }) {
	const machine = useAtomValue(machineAtom);
	const refresh = useAtomRefresh(machineAtom);
	const rename = useAtomSet(renameAtom, { mode: "promise" });
	const [error, setError] = useState<string | null>(null);
	if (AsyncResult.isInitial(machine)) {
		return (
			<Section title="This Machine">
				<Placeholder rows={2} />
			</Section>
		);
	}
	if (!AsyncResult.isSuccess(machine)) {
		return (
			<Section title="This Machine">
				<EmptyState title="Not Running" description="Start the local CodeWork Server to name this Machine." />
			</Section>
		);
	}
	const status = machine.value;
	const linked = workspace !== undefined && status.workspaces.some((option) => option.id === workspace.id);
	return (
		<Section title="This Machine">
			<Loaded>
				<Group>
					<Row
						title="Name"
						description={
							error ?? `Shown to your Workspaces. Empty uses the Computer's name, ${status.localHostName}.`
						}
					>
						<SavingInput
							label="Machine name"
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
					<Row title="ID" description="How the Workspace tells this Machine apart; it never changes.">
						<code className="font-mono text-xs text-ink-muted">{status.id ?? "Assigned on first connect"}</code>
					</Row>
					{workspace !== undefined && !linked && (
						<Row title="Not Connected" description={`This Machine isn't in ${workspace.name} yet.`}>
							<Button size="sm" asChild>
								<Link
									to="/workspaces/$workspaceId/settings/machines/setup"
									params={{ workspaceId: workspace.id }}
								>
									Set Up
								</Link>
							</Button>
						</Row>
					)}
				</Group>
			</Loaded>
		</Section>
	);
}

/** Machines that ran `codework connect --workspace` for this workspace, each with the code to check. */
function Waiting({ workspace }: { readonly workspace: Relay.Workspace }) {
	const pairings = useAtomValue(pairingsAtom(workspace.id));
	const refreshPairings = useAtomRefresh(pairingsAtom(workspace.id));
	const refreshMachines = useAtomRefresh(machinesAtom(workspace.id));
	const approve = useAtomSet(approveAtom, { mode: "promise" });
	const decline = useAtomSet(declineAtom, { mode: "promise" });
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const timer = setInterval(refreshPairings, PENDING_MS);
		return () => clearInterval(timer);
	}, [refreshPairings]);

	const list = AsyncResult.isSuccess(pairings) ? pairings.value : [];
	const act = (pairing: Relay.PendingPairing, how: "approve" | "decline") => {
		setBusy((codes) => new Set(codes).add(pairing.userCode));
		setError(null);
		const input = { userCode: pairing.userCode, workspaceId: workspace.id };
		(how === "approve" ? approve(input) : decline(input))
			.then(() => {
				refreshPairings();
				refreshMachines();
			})
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() =>
				setBusy((codes) => {
					const next = new Set(codes);
					next.delete(pairing.userCode);
					return next;
				}),
			);
	};
	const command = `codework connect --workspace ${workspace.id}`;
	return (
		<section className="flex flex-col gap-2">
			<div className="flex min-h-7 items-center justify-between gap-3">
				<h2 className="text-section font-medium">
					Waiting to Join{list.length > 0 && <span className="text-ink-muted"> · {list.length}</span>}
				</h2>
				{list.length > 1 && (
					<Button size="sm" variant="outline" onClick={() => list.forEach((pairing) => act(pairing, "approve"))}>
						Approve All
					</Button>
				)}
			</div>
			<Group>
				{list.map((pairing) => {
					const working = busy.has(pairing.userCode);
					return (
						<div
							key={pairing.userCode}
							className="animate-in duration-300 ease-(--ease-out) fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
						>
							<Row
								title={pairing.machine.givenName ?? pairing.machine.localHostName}
								description={
									<>
										{pairing.machine.os} {pairing.machine.arch} · Code{" "}
										<code className="font-mono tracking-wider text-ink">{pairing.userCode}</code>
									</>
								}
							>
								<div className="flex shrink-0 items-center gap-1">
									<Button size="sm" variant="ghost" disabled={working} onClick={() => act(pairing, "decline")}>
										Decline
									</Button>
									<Button
										size="sm"
										className="min-w-24"
										disabled={working}
										onClick={() => act(pairing, "approve")}
									>
										{working ? "Approving…" : "Approve"}
									</Button>
								</div>
							</Row>
						</div>
					);
				})}
				<div className="flex flex-col gap-2 px-4 py-3.5">
					<span className="text-xs font-book text-ink-muted">
						Run this on a Machine to add it. It shows up here with its Code; check it matches before approving.
					</span>
					<CopyCommand command={command} />
					{error !== null && <p className="text-xs text-destructive">{error}</p>}
					<ManualCode workspace={workspace} onAdded={refreshMachines} />
				</div>
			</Group>
		</section>
	);
}

/**
 * The way in for a machine that isn't listed (its connect didn't name this workspace): type the code it
 * shows. Enter adds it; the field clears and keeps focus for the next.
 */
function ManualCode({ workspace, onAdded }: { readonly workspace: Relay.Workspace; readonly onAdded: () => void }) {
	const input = useRef<HTMLInputElement>(null);
	const approve = useAtomSet(approveAtom, { mode: "promise" });
	const [open, setOpen] = useState(false);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<string | null>(null);
	const submit = () => {
		if (busy) return;
		if (code.trim() === "") {
			setError("Enter the Code the Machine shows.");
			return;
		}
		setBusy(true);
		setError(null);
		approve({ userCode: code.trim().toUpperCase(), workspaceId: workspace.id })
			.then((machine) => {
				setAdded(machine.givenName ?? machine.localHostName);
				setCode("");
				onAdded();
			})
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => {
				setBusy(false);
				input.current?.focus();
			});
	};
	return (
		<div className="flex flex-col gap-2">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => {
					setOpen((shown) => !shown);
					requestAnimationFrame(() => input.current?.focus());
				}}
				className="flex w-fit items-center gap-1 rounded-md text-xs text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
			>
				<CaretRightIcon
					size={10}
					weight="bold"
					className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
					aria-hidden
				/>
				Enter a Code Instead
			</button>
			<Collapse open={open}>
				<form
					className="flex items-start gap-2 pt-1"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<div className="flex min-w-0 flex-1 flex-col gap-1.5">
						<Input
							ref={input}
							value={code}
							placeholder="ABCD-EFGH"
							aria-label="Code from codework connect"
							aria-invalid={error !== null}
							autoComplete="off"
							spellCheck={false}
							className="font-mono tracking-widest uppercase"
							readOnly={busy}
							onChange={(event) => {
								setCode(event.target.value);
								setError(null);
							}}
						/>
						{error !== null && <p className="text-xs text-destructive">{error}</p>}
						{added !== null && error === null && (
							<p
								key={added}
								className="flex animate-in items-center gap-1.5 text-xs text-ink-secondary duration-200 fade-in-0 motion-reduce:animate-none"
							>
								<CheckCircleIcon size={14} weight="fill" className="text-success" aria-hidden />
								Added {added}
							</p>
						)}
					</div>
					<Button type="submit" size="sm" className="min-w-20" disabled={busy}>
						{busy ? "Adding…" : "Add"}
					</Button>
				</form>
			</Collapse>
		</div>
	);
}

/** Opens and closes by height and opacity together; closed content stays mounted, inert, to animate out. */
function Collapse({ open, children }: { readonly open: boolean; readonly children: ReactNode }) {
	return (
		<div
			inert={!open}
			className={`grid transition-[grid-template-rows,opacity] duration-250 ease-(--ease-out) motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
		>
			<div className="-mx-1 min-h-0 overflow-hidden px-1">{children}</div>
		</div>
	);
}

function WorkspaceMachines({ workspace }: { readonly workspace: Relay.Workspace }) {
	const machines = useAtomValue(machinesAtom(workspace.id));
	const refresh = useAtomRefresh(machinesAtom(workspace.id));
	const local = useAtomValue(machineAtom);
	const me = useAtomValue(meAtom);
	const localId = AsyncResult.isSuccess(local) ? local.value.id : null;
	const accountId = AsyncResult.isSuccess(me) ? me.value.account.id : null;
	// Machines seen when the page opened; any other is new and arrives with a highlight.
	const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
	useEffect(() => {
		const timer = setInterval(refresh, REFRESH_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	if (AsyncResult.isInitial(machines)) {
		return (
			<Section title={`In ${workspace.name}`}>
				<Placeholder rows={2} />
			</Section>
		);
	}
	if (AsyncResult.isFailure(machines)) {
		return (
			<Section title={`In ${workspace.name}`}>
				<EmptyState title="Unavailable" description={messageOf(machines.cause)} />
			</Section>
		);
	}
	const list = AsyncResult.isSuccess(machines) ? machines.value : [];
	if (seen === null && AsyncResult.isSuccess(machines)) setSeen(new Set(list.map((machine) => machine.id)));
	// This machine first, then the newest: a machine just added appears where you are looking.
	const ordered = [
		...list.filter((machine) => machine.id === localId),
		...list.filter((machine) => machine.id !== localId).reverse(),
	];
	return (
		<Section title={`In ${workspace.name}${list.length > 0 ? ` · ${list.length}` : ""}`}>
			<Loaded>
				{list.length === 0 ? (
					<EmptyState
						icon={<DesktopTowerIcon size={22} aria-hidden />}
						title="No Machines Yet"
						description="Set up this Machine, or run codework connect on another."
					/>
				) : (
					<Group>
						{ordered.map((machine) => (
							<MachineRow
								key={machine.id}
								machine={machine}
								workspace={workspace}
								isLocal={machine.id === localId}
								fresh={seen !== null && !seen.has(machine.id)}
								canRemove={workspace.role !== "member" || machine.ownerId === accountId}
								onGone={refresh}
							/>
						))}
					</Group>
				)}
			</Loaded>
		</Section>
	);
}

function MachineRow({
	machine,
	workspace,
	isLocal,
	fresh,
	canRemove,
	onGone,
}: {
	readonly machine: Relay.Machine;
	readonly workspace: Relay.Workspace;
	readonly isLocal: boolean;
	readonly fresh: boolean;
	readonly canRemove: boolean;
	readonly onGone: () => void;
}) {
	const [leaving, setLeaving] = useState(false);
	const [tint, setTint] = useState(fresh);
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
				<div
					className={`transition-colors duration-700 ease-out ${tint ? "bg-selection-subtle" : ""} ${fresh ? "animate-in duration-300 ease-(--ease-out) fade-in-0 slide-in-from-top-1 motion-reduce:animate-none" : ""}`}
				>
					<Row
						title={
							<span className="flex min-w-0 items-center gap-2">
								<span className="truncate">{name}</span>
								{isLocal && <Badge tone="info">This Machine</Badge>}
							</span>
						}
						description={`${machine.os} ${machine.arch} · v${machine.version} · ${machine.id}`}
					>
						{machine.online ? (
							<StatusDot tone="success">Online</StatusDot>
						) : machine.lastSeenAt === null ? (
							<StatusDot tone="muted">Never Seen</StatusDot>
						) : (
							<StatusDot tone="muted">
								Last Seen <Ago time={Date.parse(machine.lastSeenAt)} />
							</StatusDot>
						)}
						{(isLocal || canRemove) && (
							<MachineMenu
								name={name}
								machineId={machine.id}
								workspace={workspace}
								isLocal={isLocal}
								onDone={() => {
									setLeaving(true);
									setTimeout(onGone, 260);
								}}
							/>
						)}
					</Row>
				</div>
			</div>
		</div>
	);
}

/** This machine disconnects itself; another is removed by its owner or a workspace owner or admin. */
function MachineMenu({
	name,
	machineId,
	workspace,
	isLocal,
	onDone,
}: {
	readonly name: string;
	readonly machineId: string;
	readonly workspace: Relay.Workspace;
	readonly isLocal: boolean;
	readonly onDone: () => void;
}) {
	const disconnect = useAtomSet(disconnectAtom, { mode: "promise" });
	const remove = useAtomSet(removeMachineAtom, { mode: "promise" });
	const refreshLocal = useAtomRefresh(machineAtom);
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirm = () => {
		setBusy(true);
		setError(null);
		(isLocal
			? disconnect({ payload: { workspaceId: workspace.id } }).then(refreshLocal)
			: remove({ workspaceId: workspace.id, machineId })
		)
			.then(() => {
				setAsking(false);
				onDone();
			})
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => setBusy(false));
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${name}`}>
						<DotsThreeIcon weight="bold" aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-52">
					<DropdownMenuItem variant="destructive" onSelect={() => setAsking(true)}>
						{isLocal ? "Disconnect…" : `Remove from ${workspace.name}…`}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<AlertDialog open={asking} onOpenChange={(next) => !busy && setAsking(next)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{isLocal ? `Disconnect ${name}?` : `Remove ${name}?`}</AlertDialogTitle>
						<AlertDialogDescription>
							{isLocal
								? `It leaves ${workspace.name} and stops showing up here. Connect it again from Setup.`
								: `It's disconnected from ${workspace.name}. It can join again with codework connect.`}
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
							{busy ? (isLocal ? "Disconnecting…" : "Removing…") : isLocal ? "Disconnect" : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Content that replaces a placeholder fades in where it stood, instead of cutting over. */
function Loaded({ children }: { readonly children: ReactNode }) {
	return (
		<div className="flex animate-in flex-col duration-200 ease-out fade-in-0 motion-reduce:animate-none">
			{children}
		</div>
	);
}

/** Rows the size of real ones while the first answer is on its way, so nothing jumps when it lands. */
function Placeholder({ rows }: { readonly rows: number }) {
	return (
		<Group>
			{Array.from({ length: rows }, (_, index) => (
				<div key={index} aria-hidden className="flex min-h-15 items-center gap-4 px-4 py-3">
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<Skeleton className="h-3.5 w-40" />
						<Skeleton className="h-3 w-64 max-w-full" />
					</div>
					<Skeleton className="h-3 w-16" />
				</div>
			))}
		</Group>
	);
}
