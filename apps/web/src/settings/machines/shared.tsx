import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { RemoteServerStatus, ServerStatus } from "@codeworksh/contract";
import type { Relay } from "@codeworksh/schema";
import { CaretRightIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode, useCallback, useContext } from "react";

import { isSignedInApp } from "../../auth";
import { machinesAtom, relayFailure, workspaceAtom } from "../../kernel/relay";
import { serversAtom } from "../../kernel/servers";
import { SeenStatus, StatusDot } from "../controls";

const isPaired = (server: ServerStatus): server is RemoteServerStatus => server.kind === "remote";

/** This computer's paired machines, kept current. */
export function usePaired() {
	return AsyncResult.map(useAtomValue(serversAtom), (servers) => servers.filter(isPaired));
}

/**
 * The workspace the app works in, and whether that is known yet. An app without sign-in has none, at
 * once; signed in, it waits for the account.
 */
export function useWorkspace(): { readonly ready: boolean; readonly workspace: Relay.Workspace | undefined } {
	const current = useAtomValue(workspaceAtom);
	if (!isSignedInApp) return { ready: true, workspace: undefined };
	return {
		ready: !AsyncResult.isInitial(current),
		workspace: AsyncResult.isSuccess(current) ? current.value : undefined,
	};
}

/** Whether a paired machine answers as itself, so what it says about its links holds. */
export const isReachable = (server: RemoteServerStatus) => server.paired && server.mismatch === null && server.online;

type Machines = Atom.Type<ReturnType<typeof machinesAtom>>;

const noMachines = Atom.make<Machines>(AsyncResult.initial());

/** How often a page showing links asks the relay again, so a change made elsewhere shows. */
export const RELAY_REFRESH_MS = 15_000;

/** A machine's own record of a link, as it reports it. */
interface Own {
	readonly id: string;
	readonly keyId: string;
	readonly leaving?: boolean;
}

/**
 * Whether a machine is in a workspace. The relay alone decides; while it can't be reached, its last
 * answer stands, marked stale. The machine's own record only says whether it holds the listed key, and
 * whether it is leaving.
 */
export type Membership =
	| { readonly state: "loading" }
	| { readonly state: "unknown"; readonly reason: string }
	| { readonly state: "unlinked"; readonly stale: boolean }
	| {
			readonly state: "linked";
			readonly keyId: string;
			readonly held: boolean;
			readonly leaving: boolean;
			readonly stale: boolean;
	  };

export function membershipOf(
	machines: Machines,
	machineId: string | null,
	links: ReadonlyArray<Own>,
	workspaceId: string,
): Membership {
	if (AsyncResult.isInitial(machines)) return { state: "loading" };
	const last = AsyncResult.isFailure(machines) ? Option.getOrUndefined(machines.previousSuccess) : undefined;
	if (AsyncResult.isFailure(machines) && last === undefined)
		return { state: "unknown", reason: relayFailure(machines.cause) };
	const list = AsyncResult.isSuccess(machines) ? machines.value : (last?.value ?? []);
	const stale = !AsyncResult.isSuccess(machines);
	// The relay holds one link per machine and workspace; linking again replaces its key.
	const listed = list.find((machine) => machine.id === machineId);
	if (listed === undefined) return { state: "unlinked", stale };
	const own = links.find((link) => link.id === workspaceId);
	const held = listed.keyId === own?.keyId;
	return { state: "linked", keyId: listed.keyId, held, leaving: held && own?.leaving === true, stale };
}

/** A machine's membership in the workspace the app works in; none without a workspace. */
export function useMembership(
	machineId: string | null,
	links: ReadonlyArray<Own>,
	workspace: Relay.Workspace | undefined,
): Membership | undefined {
	const machines = useAtomValue(workspace === undefined ? noMachines : machinesAtom(workspace.id));
	return workspace === undefined ? undefined : membershipOf(machines, machineId, links, workspace.id);
}

/** Asks the relay for the workspace's machines again. */
export function useRefreshMachines(workspace: Relay.Workspace | undefined) {
	const registry = useContext(RegistryContext);
	return useCallback(() => {
		if (workspace !== undefined) registry.refresh(machinesAtom(workspace.id));
	}, [registry, workspace]);
}

/** The membership in a few words; none while the relay's first answer is on its way. */
export const linkText = (membership: Membership | undefined, workspace: Relay.Workspace) => {
	switch (membership?.state) {
		case "linked":
			return `Linked to ${workspace.name}`;
		case "unlinked":
			return "Not Linked";
		case "unknown":
			return "Unknown Link";
		default:
			return undefined;
	}
};

/** Every fact that qualifies a membership: an answer gone stale, a key lost, an unlink on its way. */
export const membershipNote = (membership: Membership | undefined) => {
	if (membership === undefined || membership.state === "loading") return undefined;
	if (membership.state === "unknown") return membership.reason;
	const notes = [
		membership.stale && "Relay can’t be reached; this is its last status",
		membership.state === "linked" && !membership.held && "The machine no longer holds its key",
		membership.state === "linked" && membership.leaving && "Unlinking; it finishes once the machine reaches Relay",
	].filter((note) => note !== false);
	return notes.length === 0 ? undefined : notes.join(" · ");
};

/** Whether it is paired, then what keeps it from connecting, then whether it answers. */
export function Status({ server }: { readonly server: RemoteServerStatus }) {
	if (!server.paired) return <StatusDot tone="warning">Not Paired</StatusDot>;
	if (server.mismatch?.kind === "machine") return <StatusDot tone="warning">Different Machine</StatusDot>;
	if (server.mismatch?.kind === "clock") return <StatusDot tone="warning">Clock Is Off</StatusDot>;
	return <SeenStatus online={server.online} seenAt={server.seenAt} />;
}

/**
 * One machine in a list. A paired one opens its page from anywhere on the row; any other has only its
 * menu. Status and the chevron or menu sit in fixed columns, so the lists line up.
 */
export function MachineRow({
	name,
	marks,
	description,
	status,
	open,
	menu,
	className = "",
}: {
	readonly name: string;
	readonly marks?: ReactNode;
	readonly description: string;
	readonly status: ReactNode;
	/** The paired machine whose page the row opens. */
	readonly open?: string | undefined;
	readonly menu?: ReactNode;
	readonly className?: string;
}) {
	return (
		<div
			className={`relative flex min-h-15 items-center gap-4 px-4 py-3 ring-ring ring-inset first:rounded-t-[10px] last:rounded-b-[10px] has-[a:focus-visible]:ring-2 ${open === undefined ? "" : "hover:bg-ink/3"} ${className}`}
		>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="flex min-w-0 items-center gap-2">
					{open === undefined ? (
						<span className="truncate font-medium" title={name}>
							{name}
						</span>
					) : (
						<Link
							to="/settings/machines/$id"
							params={{ id: open }}
							title={name}
							className="min-w-0 truncate font-medium outline-none after:absolute after:inset-0"
						>
							{name}
						</Link>
					)}
					{marks}
				</span>
				<span className="truncate text-xs font-book text-ink-muted" title={description}>
					{description}
				</span>
			</span>
			<span className="shrink-0">{status}</span>
			{open === undefined ? (
				<span className="relative flex w-7 shrink-0 justify-end">{menu}</span>
			) : (
				<span className="flex w-7 shrink-0 justify-end">
					<CaretRightIcon size={12} className="text-ink-muted" aria-hidden />
				</span>
			)}
		</div>
	);
}

/** Content that replaces a placeholder fades in where it stood, instead of cutting over. */
export function Loaded({ children }: { readonly children: ReactNode }) {
	return (
		<div className="flex animate-in flex-col duration-200 ease-out fade-in-0 motion-reduce:animate-none">
			{children}
		</div>
	);
}

/** A failure, in a field's or a dialog's own words, under what failed. */
export function Failure({ id, children }: { readonly id?: string; readonly children: ReactNode }) {
	return (
		<p id={id} role="alert" className="flex items-start gap-1.5 text-left text-xs text-destructive">
			<WarningCircleIcon size={14} weight="fill" className="mt-px shrink-0" aria-hidden />
			<span>{children}</span>
		</p>
	);
}
