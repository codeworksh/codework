import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { DesktopTowerIcon } from "@phosphor-icons/react";
import type { Relay } from "@codeworksh/schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import { messageOf } from "@/lib/utils";
import { machinesAtom, workspaceAtom } from "../kernel/relay";
import { Server } from "../kernel/rpc";
import { ApproveDialog, ConnectDialog, machineAtom } from "../shell/connect";
import { Ago } from "../widgets/time";
import { Group, Page, quietField, Row, SavingInput, Section } from "./blocks";
import { EmptyState, StatusDot } from "./controls";
import { Badge } from "./servers/local";

const renameAtom = Server.mutation("machine.rename");

/** How often the list asks the relay again, so online and offline stay current while it is open. */
const REFRESH_MS = 15_000;

export function MachinesSettings() {
	const current = useAtomValue(workspaceAtom);
	const workspace = AsyncResult.isSuccess(current) ? current.value : undefined;
	return (
		<Page
			title="Machines"
			description={
				workspace === undefined
					? "Machines connected to your workspace."
					: `Machines connected to ${workspace.name}, and this machine's name.`
			}
			actions={workspace === undefined ? undefined : <MachineActions workspace={workspace} />}
		>
			<ThisMachine />
			{workspace === undefined ? (
				<EmptyState
					icon={<DesktopTowerIcon size={22} aria-hidden />}
					title="No Workspace"
					description="The relay could not be reached, so the workspace's machines are unknown."
				/>
			) : (
				<WorkspaceMachines workspace={workspace} />
			)}
		</Page>
	);
}

/** Connecting this machine to the workspace, and approving another machine's code. */
function MachineActions({ workspace }: { workspace: Relay.Workspace }) {
	const machine = useAtomValue(machineAtom);
	const [dialog, setDialog] = useState<"connect" | "approve" | null>(null);
	// Unknown while the local server is unreachable; connecting then fails in the dialog and says so.
	const linked =
		AsyncResult.isSuccess(machine) && machine.value.workspaces.some((option) => option.id === workspace.id);
	return (
		<div className="flex shrink-0 items-center gap-2">
			<Button variant="outline" size="sm" onClick={() => setDialog("approve")}>
				Approve a Machine…
			</Button>
			<Button size="sm" disabled={linked} onClick={() => setDialog("connect")}>
				{linked ? "This Machine Is Connected" : "Connect This Machine"}
			</Button>
			{dialog === "connect" && <ConnectDialog workspace={workspace} onClose={() => setDialog(null)} />}
			{dialog === "approve" && <ApproveDialog workspace={workspace} onClose={() => setDialog(null)} />}
		</div>
	);
}

function ThisMachine() {
	const machine = useAtomValue(machineAtom);
	const refresh = useAtomRefresh(machineAtom);
	const rename = useAtomSet(renameAtom, { mode: "promise" });
	const [error, setError] = useState<string | null>(null);
	if (!AsyncResult.isSuccess(machine)) {
		return (
			<Section title="This Machine">
				<EmptyState title="Not Running" description="Start the local CodeWork server to name this machine." />
			</Section>
		);
	}
	const status = machine.value;
	return (
		<Section title="This Machine">
			<Group>
				<Row
					title="Name"
					description={
						error ?? `Shown to your workspaces. Empty uses the computer's name, ${status.localHostName}.`
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
				<Row title="ID" description="How the workspace tells this machine apart; it never changes.">
					<code className="font-mono text-xs text-ink-muted">{status.id ?? "Assigned on first connect"}</code>
				</Row>
			</Group>
		</Section>
	);
}

function WorkspaceMachines({ workspace }: { workspace: { readonly id: string; readonly name: string } }) {
	const machines = useAtomValue(machinesAtom(workspace.id));
	const refresh = useAtomRefresh(machinesAtom(workspace.id));
	const local = useAtomValue(machineAtom);
	const localId = AsyncResult.isSuccess(local) ? local.value.id : null;
	// The relay is the clock for online: asking again is how the page sees a machine come or go.
	useEffect(() => {
		const timer = setInterval(refresh, REFRESH_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	if (AsyncResult.isFailure(machines)) {
		return (
			<Section title={`In ${workspace.name}`}>
				<EmptyState title="Unavailable" description={messageOf(machines.cause)} />
			</Section>
		);
	}
	const list = AsyncResult.isSuccess(machines) ? machines.value : [];
	return (
		<Section title={`In ${workspace.name}`}>
			{list.length === 0 ? (
				<EmptyState
					icon={<DesktopTowerIcon size={22} aria-hidden />}
					title="No Machines Yet"
					description="Connect this machine, or run codework connect on another."
				/>
			) : (
				<Group>
					{list.map((machine) => (
						<MachineRow key={machine.id} machine={machine} isLocal={machine.id === localId} />
					))}
				</Group>
			)}
		</Section>
	);
}

function MachineRow({ machine, isLocal }: { machine: Relay.Machine; isLocal: boolean }) {
	return (
		<Row
			title={
				<span className="flex items-center gap-2">
					<span className="truncate">{machine.givenName ?? machine.localHostName}</span>
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
		</Row>
	);
}
