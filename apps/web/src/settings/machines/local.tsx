import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { LocalServerStatus } from "@codeworksh/contract";
import type { Machine, Relay } from "@codeworksh/schema";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { BusyLabel } from "@/components/busy";
import { CopyCommand } from "@/components/copyable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { messageOf } from "@/lib/utils";
import { Server } from "../../kernel/rpc";
import { defaultServerAtom, INSTALL } from "../../kernel/servers";
import { useMachineAtom } from "../../shell/connect";
import { Group, Placeholder, quietField, Row, SavingInput, Section } from "../blocks";
import { StatusDot } from "../controls";
import { Badge, Install, LaunchCommand, SettingInput, stateOf, tilde, useConfigure, useServerAction } from "./service";
import { Variables } from "./variables";
import {
	linkText,
	type Membership,
	membershipNote,
	Sub,
	useMembership,
	useRefreshMachines,
	useWorkspace,
} from "./shared";
import { type Target, UnlinkDialog } from "./unlink";

const renameAtom = Server.mutation("machine.rename");

type Identity = Machine.Status;

/**
 * This machine's page, as a paired machine has one: who it is, its workspace, and the CodeWork server the
 * app runs here. Its identity comes from that server, so with the server stopped the page still opens on
 * what the app knows, and the way to start it.
 */
export function ThisMachine() {
	const status = useAtomValue(defaultServerAtom);
	const machineAtom = useMachineAtom();
	const machine = useAtomValue(machineAtom);
	const refresh = useAtomRefresh(machineAtom);
	const { ready, workspace } = useWorkspace();
	const identity = AsyncResult.isSuccess(machine) ? machine.value : undefined;
	const membership = useMembership(identity?.id ?? null, identity?.workspaces ?? [], workspace);
	if (status === undefined || AsyncResult.isInitial(machine))
		return (
			// The sections the page brings, each the size of its rows, so nothing moves when it lands. A
			// no-break space holds the title and status lines, which plain whitespace collapses.
			<Sub title={"\u00a0"} description={"\u00a0"}>
				<Section title="Machine">
					<Placeholder rows={4} />
				</Section>
				{(!ready || workspace !== undefined) && (
					<Section title="Workspace">
						<Placeholder rows={1} />
					</Section>
				)}
				<Section title="Server" description="Changes apply the next time it starts">
					<Placeholder rows={5} />
				</Section>
				<Section title="Environment" description="API keys, base URLs, and other per-service CLI settings">
					<Placeholder rows={1} />
				</Section>
			</Sub>
		);
	const name = identity === undefined ? status.name : (identity.givenName ?? identity.localHostName);
	const link = workspace === undefined ? undefined : linkText(membership, workspace);
	const { tone, text } = stateOf(status);
	return (
		<Sub
			title={name}
			description={
				<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
					<StatusDot tone={tone}>{text}</StatusDot>
					<span aria-hidden>·</span>
					<span>{link ?? "This Machine"}</span>
				</span>
			}
		>
			<Section title="Machine">
				<Group>
					<Identity status={status} identity={identity} onRenamed={refresh} />
				</Group>
			</Section>
			{identity !== undefined && workspace !== undefined && (
				<Section title="Workspace">
					{!ready || membership === undefined || membership.state === "loading" ? (
						<Placeholder rows={1} />
					) : (
						<Group>
							<WorkspaceLink
								name={name}
								identity={identity}
								workspace={workspace}
								membership={membership}
								// Start leads while the server is stopped; Link steps back so one action stands out.
								quiet={status.server._tag !== "Running"}
							/>
						</Group>
					)}
				</Section>
			)}
			<Service status={status} />
			<Section title="Environment" description="API keys, base URLs, and other per-service CLI settings">
				<Group>
					<div className="px-4 py-3">
						<Environment status={status} />
					</div>
				</Group>
			</Section>
		</Sub>
	);
}

/** The label, hostname, id and version; without the server, what the app itself knows. */
function Identity({
	status,
	identity,
	onRenamed,
}: {
	readonly status: LocalServerStatus;
	readonly identity: Identity | undefined;
	readonly onRenamed: () => void;
}) {
	const rename = useAtomSet(renameAtom, { mode: "promise" });
	const [error, setError] = useState<string | null>(null);
	const hostname = identity?.localHostName ?? status.host;
	const { cli } = status;
	// The last identity stays on show once the server stops, but only a running one can take a new label.
	const editable = identity !== undefined && status.server._tag === "Running";
	return (
		<>
			<Row
				title="Label"
				description={
					error ??
					(editable ? "Stored on the machine and shown wherever it appears" : "Start the server to change it")
				}
			>
				{!editable ? (
					<Input
						aria-label="Machine label"
						disabled
						readOnly
						value={identity?.givenName ?? ""}
						placeholder={hostname ?? undefined}
						className={`w-full @min-[560px]:w-64 ${quietField}`}
					/>
				) : (
					<SavingInput
						label="Machine label"
						value={identity.givenName ?? ""}
						placeholder={identity.localHostName}
						className={`w-full @min-[560px]:w-64 ${quietField}`}
						onCommit={(givenName) => {
							setError(null);
							rename({ payload: { givenName } })
								.then(onRenamed)
								.catch((cause: unknown) => setError(messageOf(cause)));
						}}
					/>
				)}
			</Row>
			<Row title="Hostname" description="Used when the label is empty">
				{hostname ? (
					<div className="w-full min-w-0 shrink-0 @min-[560px]:w-auto @min-[560px]:max-w-64">
						<CopyCommand command={hostname} label="Copy Hostname" />
					</div>
				) : (
					<Badge tone="muted">Unknown</Badge>
				)}
			</Row>
			<Row
				title="ID"
				description={
					identity === undefined
						? "Shown while the server runs"
						: identity.id === null
							? "Assigned when the server starts"
							: "It never changes"
				}
			>
				{identity?.id ? (
					<div className="w-full shrink-0 @min-[560px]:w-auto">
						<CopyCommand command={identity.id} label="Copy ID" />
					</div>
				) : (
					<Badge tone="muted">{identity === undefined ? "Unknown" : "Not Assigned"}</Badge>
				)}
			</Row>
			<Row title="Version">
				{cli !== null && "version" in cli ? (
					<span className="font-mono text-xs text-ink-muted tabular-nums">v{cli.version}</span>
				) : (
					<Badge tone="muted">{cli === null ? "Not Installed" : "Unknown"}</Badge>
				)}
			</Row>
		</>
	);
}

/** Whether it is in the workspace, and the one action that changes it; linking goes through Setup. */
function WorkspaceLink({
	name,
	identity,
	workspace,
	membership,
	quiet,
}: {
	readonly name: string;
	readonly identity: Identity;
	readonly workspace: Relay.Workspace;
	readonly membership: Membership;
	readonly quiet: boolean;
}) {
	const [unlinking, setUnlinking] = useState<Target | null>(null);
	const action = useRef<HTMLDivElement>(null);
	const refreshMachines = useRefreshMachines(workspace);
	const title = linkText(membership, workspace);
	const machineId = identity.id;
	return (
		<>
			<Row
				title={
					<span className="block truncate" title={title}>
						{title}
					</span>
				}
				description={
					membershipNote(membership) ??
					(membership.state === "linked"
						? `It shows up for everyone in ${workspace.name}`
						: `Link it to add it to ${workspace.name}`)
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
							<Button size="sm" variant={quiet ? "secondary" : "default"} className="min-w-28" asChild>
								<Link to="/settings/machines/setup">Link</Link>
							</Button>
						)
					)}
				</div>
			</Row>
			<UnlinkDialog
				target={unlinking}
				onClose={() => setUnlinking(null)}
				onDone={refreshMachines}
				returnFocus={() => action.current?.querySelector<HTMLElement>("a, button")}
			/>
		</>
	);
}

/** Where the server is, or why it isn't there, in a line. */
function whereOf({ cli, server }: LocalServerStatus) {
	if (cli === null) return "No codework found on your login shell’s PATH. Install it, or enter its path below";
	if ("failure" in cli) return cli.failure;
	const host = server._tag === "Stopped" ? "" : new URL(server.url).host;
	switch (server._tag) {
		case "Running":
			return `${host} · pid ${server.pid}`;
		case "Unreachable":
			return `Registered at ${host} (pid ${server.pid}) but not answering`;
		case "Incompatible":
			return `Another build answers at ${host}. Update the CLI, or run a server built with this app`;
		case "Stopped":
			return "Once started, it keeps running after the app quits";
	}
}

/** The server's state and controls, then how it starts. */
function Service({ status }: { readonly status: LocalServerStatus }) {
	const { running, error, act } = useServerAction();
	const configure = useConfigure(status.id);
	const { cli, home, server } = status;
	const usable = cli !== null && "version" in cli;
	const { tone, text } = stateOf(status);
	const field = "w-full min-w-0 @min-[560px]:w-64";
	return (
		<Section title="Server" description="Changes apply the next time it starts">
			<Group>
				<Row
					title={
						<span className="flex items-center gap-2">
							<StatusDot tone={tone}>
								<span className="text-ui font-medium text-ink">{text}</span>
							</StatusDot>
						</span>
					}
					description={
						error === null ? (
							// The port and pid change with each start; fixed-width digits keep the line still.
							<span className="tabular-nums">{whereOf(status)}</span>
						) : (
							<span role="alert" className="text-destructive">
								{error}
							</span>
						)
					}
				>
					{cli === null && <Install id={status.id} />}
					{usable && server._tag === "Stopped" && (
						<Button
							size="sm"
							className="min-w-20"
							disabled={running !== null}
							onClick={() => act(status.id, "start")}
						>
							<BusyLabel busy={running === "start"} idle="Start" working="Starting…" />
						</Button>
					)}
					{usable && server._tag !== "Stopped" && (
						<span className="flex shrink-0 gap-1">
							<Button
								size="sm"
								variant="secondary"
								disabled={running !== null}
								onClick={() => act(status.id, "restart")}
							>
								<BusyLabel busy={running === "restart"} idle="Restart" working="Restarting…" />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={running !== null}
								onClick={() => act(status.id, "stop")}
							>
								<BusyLabel busy={running === "stop"} idle="Stop" working="Stopping…" />
							</Button>
						</span>
					)}
				</Row>
				{cli === null && (
					<Row title="Install in a Terminal">
						<div className={field}>
							<CopyCommand command={INSTALL} />
						</div>
					</Row>
				)}
				<Row
					title="Executable"
					description={cli !== null && !cli.custom ? `Found at ${tilde(cli.path)}` : "Path to the codework binary"}
				>
					<div className={field}>
						<SettingInput
							label="Executable"
							value={cli?.custom ? cli.path : ""}
							placeholder={cli !== null && !cli.custom ? cli.path : "codework"}
							onSave={(next) => configure({ executable: next || null })}
						/>
					</div>
				</Row>
				<Row title="Home Directory" description="Where codework keeps its configuration">
					<div className={field}>
						<SettingInput
							label="Home Directory"
							// An added server always has its own home, so only the built-in one shows a default to reset to.
							value={home.fallback === null || home.custom ? home.path : ""}
							placeholder={home.fallback ?? "~/.codework"}
							resettable={home.fallback !== null}
							onSave={(next) => configure({ home: next || null })}
						/>
					</div>
				</Row>
				<Row title="Launch Arguments" description="Passed to codework on service start">
					<div className={field}>
						<SettingInput
							label="Launch Arguments"
							value={status.args}
							placeholder="--port 7433"
							// Its placeholder is an example, not a default.
							hover={status.args}
							onSave={(next) => configure({ args: next })}
						/>
					</div>
				</Row>
				<div className="flex flex-col gap-2 px-4 py-3">
					<span className="text-xs font-book text-ink-muted">Starts with</span>
					<LaunchCommand status={status} />
				</div>
			</Group>
		</Section>
	);
}

function Environment({ status }: { readonly status: LocalServerStatus }) {
	const configure = useConfigure(status.id);
	return <Variables key={JSON.stringify(status.env)} saved={status.env} onSave={(env) => configure({ env })} />;
}
