import { useAtomValue } from "@effect/atom-react";
import type { RemoteServerStatus, ServerStatus } from "@codeworksh/contract";
import type { Relay } from "@codeworksh/schema";
import { CaretRightIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";

import { isSignedInApp } from "../../auth";
import { workspaceAtom } from "../../kernel/relay";
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

/** Whether a paired machine is linked to the workspace, as it last said. */
export const isLinked = (server: RemoteServerStatus, workspace: Relay.Workspace) =>
	server.workspaces.some((link) => link.id === workspace.id);

export const linkText = (linked: boolean, workspace: Relay.Workspace) =>
	linked ? `Linked to ${workspace.name}` : "Not Linked";

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
