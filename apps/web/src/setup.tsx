import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { CaretRightIcon, CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode, useEffect, useState } from "react";

import { Collapse } from "@/components/collapse";
import { CopyCommand } from "@/components/copyable";
import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import { Frame } from "./frame";
import { isSignedInApp } from "./auth";
import { meAtom, workspaceAtom } from "./kernel/relay";
import { defaultServerAtom, INSTALL, installAtom, serviceAtom } from "./kernel/servers";
import { approveLabel, canAct, CodeSlot, machineAtom, useConnect } from "./shell/connect";

/** Set Up Later, per workspace: the app stops opening this page for it. */
const laterKey = (workspaceId: string) => `codework.setup.later.${workspaceId}`;

const setUpLater = (workspaceId: string) => {
	try {
		localStorage.setItem(laterKey(workspaceId), "1");
	} catch {
		// Unsaved, the page opens again on the next launch.
	}
};

const putOff = (workspaceId: string) => {
	try {
		return localStorage.getItem(laterKey(workspaceId)) !== null;
	} catch {
		return false;
	}
};

// Once per sign-in: after that, the app stays where the person goes. The atom registry is mounted inside
// the auth gate, so it starts over for each account that signs in.
const checkedAtom = Atom.make(false).pipe(Atom.keepAlive);

/**
 * Opens setup when this machine isn't set up for the workspace the app opens in: the CLI missing, its
 * server not running, or the machine not connected. Not for a workspace set up later, and never while the
 * relay or the local server is still unknown; local work never waits on it.
 */
export function SetupGate() {
	const navigate = useNavigate();
	const [checked, setChecked] = useAtom(checkedAtom);
	const current = useAtomValue(workspaceAtom);
	const status = useAtomValue(defaultServerAtom);
	const machine = useAtomValue(machineAtom);
	const workspace = AsyncResult.isSuccess(current) ? current.value : undefined;
	const running = status?.server._tag === "Running";
	const needs =
		workspace === undefined || status === undefined
			? undefined
			: status.cli === null || !("version" in status.cli) || !running
				? true
				: AsyncResult.isSuccess(machine)
					? !machine.value.workspaces.some((option) => option.id === workspace.id)
					: undefined;
	useEffect(() => {
		if (checked || !isSignedInApp || workspace === undefined || needs === undefined) return;
		setChecked(true);
		if (needs && !putOff(workspace.id)) {
			void navigate({
				to: "/workspaces/$workspaceId/settings/machines/setup",
				params: { workspaceId: workspace.id },
				replace: true,
			});
		}
	}, [checked, setChecked, needs, workspace, navigate]);
	return null;
}

/**
 * Sets up this machine for a workspace in three steps: install the CLI, start its server, connect to
 * the workspace. Only the current step is open; each also offers its terminal command.
 */
export function Setup({ workspaceId }: { readonly workspaceId: string }) {
	const navigate = useNavigate();
	const status = useAtomValue(defaultServerAtom);
	const machine = useAtomValue(machineAtom);
	const refreshMachine = useAtomRefresh(machineAtom);
	const me = useAtomValue(meAtom);
	const install = useAtomSet(installAtom, { mode: "promise" });
	const service = useAtomSet(serviceAtom, { mode: "promise" });
	const [busy, setBusy] = useState<"install" | "start" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);

	const workspace = AsyncResult.isSuccess(me)
		? me.value.workspaces.find((option) => option.id === workspaceId)
		: undefined;
	const workspaceName = workspace?.name ?? "Your Workspace";
	const cli = status?.cli ?? null;
	const version = cli !== null && "version" in cli ? cli.version : undefined;
	const running = status?.server._tag === "Running";
	const connected =
		AsyncResult.isSuccess(machine) && machine.value.workspaces.some((option) => option.id === workspaceId);
	const name = AsyncResult.isSuccess(machine)
		? (machine.value.givenName ?? machine.value.localHostName)
		: (status?.name ?? "This Machine");
	const current = version === undefined ? 0 : !running ? 1 : !connected ? 2 : 3;

	// A call's step stays busy until the server's status moves past it, a moment after the call returns,
	// so its button never flips back to ready in between.
	useEffect(() => {
		setBusy(null);
	}, [current]);

	// A server that just started answers machine.info now; read it again to see its workspaces.
	useEffect(() => {
		if (running) refreshMachine();
	}, [running, refreshMachine]);

	const run = (step: "install" | "start") => {
		if (status === undefined) return;
		setBusy(step);
		setError(null);
		const done =
			step === "install"
				? install({ payload: { id: status.id } })
				: service({ payload: { id: status.id, action: "start" } });
		done.catch((cause: unknown) => {
			setError(messageOf(cause));
			setBusy(null);
		});
	};

	return (
		<Frame home>
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-settings flex-col gap-8 px-5 pt-16 pb-16 text-ui sm:px-8">
					<header className="flex flex-col gap-1.5">
						<h1 className="text-2xl/8 font-medium">Set Up CodeWork</h1>
						<p className="font-book text-ink-muted">
							Setting up <span className="text-ink">{name}</span>
						</p>
					</header>
					<ol className="flex flex-col rounded-[10px] bg-frame-top shadow-(--cw-card-shadow)">
						<Step
							index={0}
							current={current}
							title="Install the CodeWork CLI"
							summary={version === undefined ? "" : `v${version} installed`}
							line={
								cli !== null && "failure" in cli
									? `codework at ${cli.path} fails to run: ${cli.failure}`
									: "It runs your sessions on this Machine."
							}
							command={INSTALL}
							error={current === 0 ? error : null}
						>
							<Button disabled={busy !== null || status === undefined} onClick={() => run("install")}>
								<BusyLabel busy={busy === "install"} idle="Install CLI" working="Installing…" />
							</Button>
						</Step>
						<Step
							index={1}
							current={current}
							title="Start the Server"
							summary="Running"
							line={
								status?.server._tag === "Incompatible"
									? `The running server is v${status.server.version}, which this app can't read. Restart it with the installed CLI.`
									: "It keeps running in the background, also after the app quits."
							}
							command="codework service start"
							error={current === 1 ? error : null}
						>
							<Button disabled={busy !== null} onClick={() => run("start")}>
								<BusyLabel busy={busy === "start"} idle="Start Server" working="Starting…" />
							</Button>
						</Step>
						<Step
							index={2}
							current={current}
							title={`Connect to ${workspaceName}`}
							summary={`Connected to ${workspaceName}`}
							line={`${name} shows up in ${workspaceName} for everyone in it.`}
							command={`codework connect --workspace ${workspaceId}`}
							error={null}
						>
							{connecting ? (
								<Connecting workspaceId={workspaceId} onCancel={() => setConnecting(false)} />
							) : (
								<Button onClick={() => setConnecting(true)}>Connect</Button>
							)}
						</Step>
					</ol>
					<div className="flex items-center justify-between">
						<Button
							variant="ghost"
							onClick={() => {
								setUpLater(workspaceId);
								void navigate({ to: "/" });
							}}
						>
							Set Up Later
						</Button>
						<Button disabled={!connected} onClick={() => void navigate({ to: "/" })}>
							Done
						</Button>
					</div>
				</div>
			</main>
		</Frame>
	);
}

/** A running connect: its code to check, then Approve. The row keeps its shape through every phase. */
function Connecting({ workspaceId, onCancel }: { readonly workspaceId: string; readonly onCancel: () => void }) {
	const connect = useConnect(workspaceId);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-3">
				<CodeSlot code={connect.code} />
				<Button className="min-w-28" disabled={!canAct(connect.phase)} onClick={connect.act}>
					{approveLabel(connect.phase)}
				</Button>
				<Button variant="ghost" disabled={!connect.cancellable} onClick={onCancel}>
					Cancel
				</Button>
			</div>
			{connect.error !== null && <p className="text-xs text-destructive">{connect.error}</p>}
		</div>
	);
}

/** A button label that swaps to its working form, a spinner and words, without changing width. */
function BusyLabel({
	busy,
	idle,
	working,
}: {
	readonly busy: boolean;
	readonly idle: string;
	readonly working: string;
}) {
	return (
		<span className="grid">
			<span className={`col-start-1 row-start-1 ${busy ? "invisible" : ""}`}>{idle}</span>
			<span
				className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${busy ? "" : "invisible"}`}
			>
				<CircleNotchIcon className="animate-spin motion-reduce:animate-none" aria-hidden />
				{working}
			</span>
		</span>
	);
}

function Step({
	index,
	current,
	title,
	summary,
	line,
	command,
	error,
	children,
}: {
	readonly index: number;
	readonly current: number;
	readonly title: string;
	readonly summary: string;
	readonly line: string;
	readonly command: string;
	readonly error: string | null;
	readonly children: ReactNode;
}) {
	const done = index < current;
	const open = index === current;
	const [terminal, setTerminal] = useState(false);
	return (
		<li
			className="flex gap-3 border-b border-edge/60 px-4 py-3.5 last:border-b-0"
			aria-current={open ? "step" : undefined}
		>
			<span
				className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium tabular-nums transition-colors duration-200 ease-out ${done ? "bg-success text-white" : open ? "bg-ink text-frame" : "border border-edge text-ink-muted"}`}
				aria-hidden
			>
				{done ? (
					<CheckIcon
						size={12}
						weight="bold"
						className="animate-in duration-200 ease-(--ease-out) fade-in-0 zoom-in-50 motion-reduce:animate-none"
					/>
				) : (
					index + 1
				)}
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex min-h-6 items-center justify-between gap-3">
					<span
						className={`font-medium transition-colors duration-200 ${open || done ? "text-ink" : "text-ink-muted"}`}
					>
						{title}
					</span>
					{done && (
						<span className="animate-in text-xs font-book text-ink-muted duration-200 fade-in-0 motion-reduce:animate-none">
							{summary}
						</span>
					)}
				</div>
				<Collapse open={open}>
					<p className="pt-0.5 text-xs font-book text-ink-muted">{line}</p>
					<div className="flex flex-col gap-2 pt-3">
						<div>{children}</div>
						{error !== null && <p className="text-xs text-destructive">{error}</p>}
					</div>
					<div className="pt-3 pb-0.5">
						<button
							type="button"
							aria-expanded={terminal}
							onClick={() => setTerminal((shown) => !shown)}
							className="flex items-center gap-1 rounded-md text-xs text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
						>
							<CaretRightIcon
								size={10}
								weight="bold"
								className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${terminal ? "rotate-90" : ""}`}
								aria-hidden
							/>
							Or use a terminal
						</button>
						<Collapse open={terminal}>
							<div className="pt-2">
								<CopyCommand command={command} />
							</div>
						</Collapse>
					</div>
				</Collapse>
			</div>
		</li>
	);
}
