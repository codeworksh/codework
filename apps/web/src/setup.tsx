import { shellQuoted } from "@codeworksh/schema";
import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Relay } from "@codeworksh/schema";
import type { LocalServerStatus } from "@codeworksh/contract";
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode, useEffect, useId, useState } from "react";

import { BusyLabel } from "@/components/busy";
import { Collapse } from "@/components/collapse";
import { CopyCommand } from "@/components/copyable";
import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import { Frame } from "./frame";
import { workspaceAtom } from "./kernel/relay";
import { defaultServerAtom, INSTALL, installAtom, serviceAtom } from "./kernel/servers";
import { type Membership, useMembership } from "./settings/machines/shared";
import { SettingInput, useConfigure } from "./settings/servers/local";
import { Variables } from "./settings/servers/variables";
import { approveLabel, canAct, CodeSlot, useMachineAtom, useConnect } from "./shell/connect";

/** Set Up Later or Skip, per workspace: the app stops opening this page for it. */
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

/** Set up for the workspace: the relay lists this machine under a key it holds, and it isn't leaving. */
const isLinked = (membership: Membership) => membership.state === "linked" && membership.held && !membership.leaving;

// Once per sign-in: after that, the app stays where the person goes. The atom registry is mounted inside
// the auth gate, so it starts over for each account that signs in.
const checkedAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Whether the first page is the one to show: the check ran, and setup, if needed, is open. */
export const settledAtom = Atom.make(false).pipe(Atom.keepAlive);

/**
 * Opens setup when this machine isn't set up for the workspace the app opens in: the CLI missing, its
 * server not running, or the relay not listing it. Not for a workspace set up later, never while the
 * local server is still unknown, and not for the link while the relay can't be reached; local work
 * never waits on it.
 */
export function SetupGate() {
	const navigate = useNavigate();
	const [checked, setChecked] = useAtom(checkedAtom);
	const settle = useAtomSet(settledAtom);
	const current = useAtomValue(workspaceAtom);
	const status = useAtomValue(defaultServerAtom);
	const machineAtom = useMachineAtom();
	const machine = useAtomValue(machineAtom);
	const workspace = AsyncResult.isSuccess(current) ? current.value : undefined;
	const membership = useMembership(
		AsyncResult.isSuccess(machine) ? machine.value.id : null,
		AsyncResult.isSuccess(machine) ? machine.value.workspaces : [],
		workspace,
	);
	const running = status?.server._tag === "Running";
	const needs =
		workspace === undefined || status === undefined
			? undefined
			: status.cli === null || !("version" in status.cli) || !running
				? true
				: !AsyncResult.isSuccess(machine) || membership === undefined || membership.state === "loading"
					? undefined
					: membership.state === "unknown" || membership.stale
						? false
						: !isLinked(membership);
	useEffect(() => {
		if (checked || workspace === undefined || needs === undefined) return;
		setChecked(true);
		if (needs && !putOff(workspace.id)) {
			void navigate({ to: "/settings/machines/setup", replace: true }).finally(() => settle(true));
		} else settle(true);
	}, [checked, setChecked, settle, needs, workspace, navigate]);
	return null;
}

/** Setup for the workspace the app works in, started over when another is picked. */
export function SetupPage() {
	const current = useAtomValue(workspaceAtom);
	const workspace = AsyncResult.isSuccess(current) ? current.value : undefined;
	return <Setup key={workspace?.id} workspace={workspace} />;
}

/**
 * Sets up this machine for a workspace in three steps: install the CLI, start its server, link it to
 * the workspace. Only the current step is open; each also offers its terminal command. The link can be
 * skipped: the machine works without it. Until the workspace is known, there is nothing to link to.
 */
function Setup({ workspace }: { readonly workspace: Relay.Workspace | undefined }) {
	const navigate = useNavigate();
	const status = useAtomValue(defaultServerAtom);
	const machineAtom = useMachineAtom();
	const machine = useAtomValue(machineAtom);
	const refreshMachine = useAtomRefresh(machineAtom);
	const install = useAtomSet(installAtom, { mode: "promise" });
	const service = useAtomSet(serviceAtom, { mode: "promise" });
	const [busy, setBusy] = useState<Action | null>(null);
	const [error, setError] = useState<{ readonly action: Action; readonly message: string } | null>(null);
	const [connecting, setConnecting] = useState(false);

	const workspaceId = workspace?.id;
	const workspaceName = workspace?.name ?? "Your Workspace";
	const cli = status?.cli ?? null;
	const version = cli !== null && "version" in cli ? cli.version : undefined;
	const running = status?.server._tag === "Running";
	const local = status?.kind === "local" ? status : undefined;
	// The terminal commands reach this server's home: a home chosen in Settings isn't the CLI's default.
	const home =
		status !== undefined && "home" in status && status.home.custom ? ` --home ${shellQuoted(status.home.path)}` : "";
	const membership = useMembership(
		AsyncResult.isSuccess(machine) ? machine.value.id : null,
		AsyncResult.isSuccess(machine) ? machine.value.workspaces : [],
		workspace,
	);
	const connected = membership !== undefined && isLinked(membership);
	const name = AsyncResult.isSuccess(machine)
		? (machine.value.givenName ?? machine.value.localHostName)
		: (status?.name ?? "This Machine");
	const current = version === undefined ? 0 : !running ? 1 : !connected ? 2 : 3;

	// A call's step stays busy until the server's status moves past it, a moment after the call returns,
	// so its button never flips back to ready in between. A restart passes through stopped and back, so
	// it stays busy until its own call returns.
	useEffect(() => {
		setBusy((action) => (action === "restart" ? action : null));
	}, [current]);
	const restarts = current > 1 || busy === "restart";

	// A server that just started answers machine.info now; read it again to see its workspaces.
	useEffect(() => {
		if (running) refreshMachine();
	}, [running, refreshMachine]);

	const run = (action: Action) => {
		if (status === undefined) return;
		setBusy(action);
		setError(null);
		const done =
			action === "install"
				? install({ payload: { id: status.id } })
				: service({ payload: { id: status.id, action } });
		done.then(
			() => {
				if (action === "restart") setBusy(null);
			},
			(cause: unknown) => {
				setError({ action, message: messageOf(cause) });
				setBusy(null);
			},
		);
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
							line="It runs your sessions on this Machine."
							problem={
								cli !== null && "failure" in cli ? `codework at ${cli.path} fails to run: ${cli.failure}` : null
							}
							command={INSTALL}
							error={error?.action === "install" ? error.message : null}
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
								restarts
									? "Changes apply after a restart."
									: "It keeps running in the background, also after the app quits."
							}
							// Its settings stay in reach once it runs.
							reopenable
							problem={
								status?.server._tag === "Incompatible"
									? `The running server is v${status.server.version}, which this app can’t read. Restart it with the installed CLI.`
									: null
							}
							// A local server shows what it runs and how to change it; the command takes the terminal's place.
							command={local === undefined ? `codework service start${home}` : null}
							before={local !== undefined && <LaunchCommand status={local} />}
							after={local !== undefined && <LaunchSettings status={local} />}
							error={error !== null && error.action !== "install" ? error.message : null}
						>
							<Button disabled={busy !== null} onClick={() => run(restarts ? "restart" : "start")}>
								{restarts ? (
									<BusyLabel busy={busy === "restart"} idle="Restart Server" working="Restarting…" />
								) : (
									<BusyLabel busy={busy === "start"} idle="Start Server" working="Starting…" />
								)}
							</Button>
						</Step>
						<Step
							index={2}
							current={current}
							title={`Link to ${workspaceName}`}
							summary={`Linked to ${workspaceName}`}
							line={`${name} shows up in ${workspaceName} for everyone in it.`}
							problem={null}
							command={`codework connect${workspaceId === undefined ? "" : ` --workspace ${workspaceId}`}${home}`}
							error={null}
						>
							{connecting && workspaceId !== undefined ? (
								<Connecting workspaceId={workspaceId} onCancel={() => setConnecting(false)} />
							) : (
								<Button disabled={workspaceId === undefined} onClick={() => setConnecting(true)}>
									Link
								</Button>
							)}
						</Step>
					</ol>
					<div className="flex items-center justify-between">
						<Button
							variant="ghost"
							className={current === 3 ? "invisible" : undefined}
							aria-hidden={current === 3 || undefined}
							tabIndex={current === 3 ? -1 : undefined}
							onClick={() => {
								if (workspaceId !== undefined) setUpLater(workspaceId);
								// Skipping the link leaves a machine ready to use.
								void navigate({ to: current === 2 ? "/" : "/settings/machines" });
							}}
						>
							{current === 2 ? "Skip" : "Set Up Later"}
						</Button>
						<Button disabled={current !== 3} onClick={() => void navigate({ to: "/" })}>
							Done
						</Button>
					</div>
				</div>
			</main>
		</Frame>
	);
}

type Action = "install" | "start" | "restart";

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

function Step({
	index,
	current,
	title,
	summary,
	line,
	problem,
	command,
	before,
	after,
	reopenable = false,
	error,
	children,
}: {
	readonly index: number;
	readonly current: number;
	readonly title: string;
	readonly summary: string;
	readonly line: string;
	/** Done, it can be opened again from its summary. */
	readonly reopenable?: boolean;
	/** What stands in the step's way, in place of its line and in the error's colour. */
	readonly problem: string | null;
	/** Offered under "Or use a terminal"; none when the step shows its own. */
	readonly command: string | null;
	/** Above the step's action. */
	readonly before?: ReactNode;
	/** Below the step's action, in place of the terminal. */
	readonly after?: ReactNode;
	readonly error: string | null;
	readonly children: ReactNode;
}) {
	const done = index < current;
	const [reopened, setReopened] = useState(false);
	const toggles = done && reopenable;
	const open = index === current || (toggles && reopened);
	const [terminal, setTerminal] = useState(false);
	const heading = (
		<>
			<span className={`font-medium transition-colors duration-200 ${open || done ? "text-ink" : "text-ink-muted"}`}>
				{title}
			</span>
			{done && (
				<span className="flex animate-in items-center gap-1 text-xs font-book text-ink-muted duration-200 fade-in-0 motion-reduce:animate-none">
					{summary}
					{toggles && (
						<CaretRightIcon
							size={10}
							weight="bold"
							className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${reopened ? "rotate-90" : ""}`}
							aria-hidden
						/>
					)}
				</span>
			)}
		</>
	);
	return (
		<li
			className="flex gap-3 border-b border-edge/60 px-4 py-3.5 last:border-b-0"
			aria-current={index === current ? "step" : undefined}
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
				{toggles ? (
					<button
						type="button"
						aria-expanded={reopened}
						onClick={() => setReopened((shown) => !shown)}
						className="group relative flex min-h-6 items-center justify-between gap-3 rounded-md text-left outline-none before:absolute before:-inset-x-2 before:-inset-y-1.5 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring [&>span:last-child]:hover:text-ink"
					>
						{heading}
					</button>
				) : (
					<div className="flex min-h-6 items-center justify-between gap-3">{heading}</div>
				)}
				<Collapse open={open}>
					{problem === null ? (
						<p className="pt-0.5 text-xs font-book text-ink-muted">{line}</p>
					) : (
						<p className="pt-0.5 text-xs text-destructive">{problem}</p>
					)}
					{before && <div className="pt-3">{before}</div>}
					<div className="flex flex-col gap-2 pt-3">
						<div>{children}</div>
						{error !== null && <p className="text-xs text-destructive">{error}</p>}
					</div>
					<div className="pt-3 pb-0.5">
						{command === null ? (
							after
						) : (
							<>
								<Disclosure open={terminal} onToggle={() => setTerminal((shown) => !shown)}>
									Or use a terminal
								</Disclosure>
								<Collapse open={terminal}>
									<div className="pt-2">
										<CopyCommand command={command} />
									</div>
								</Collapse>
							</>
						)}
					</div>
				</Collapse>
			</div>
		</li>
	);
}

/** A step's quiet toggle for what it keeps folded away. */
function Disclosure({
	open,
	onToggle,
	children,
}: {
	readonly open: boolean;
	readonly onToggle: () => void;
	readonly children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onToggle}
			className="relative flex items-center gap-1 rounded-md text-xs text-ink-muted outline-none before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-[''] hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
		>
			<CaretRightIcon
				size={10}
				weight="bold"
				className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
				aria-hidden
			/>
			{children}
		</button>
	);
}

/**
 * The command that starts this server, as the app runs it: its variables, binary, home and arguments.
 * One line, cut short where it runs out, what the user changed in ink; the copy is the whole command.
 * Secrets never reach the app, so the copy reads them from the shell.
 */
function LaunchCommand({ status }: { readonly status: LocalServerStatus }) {
	const { cli, home, args, env } = status;
	const parts = [
		...env.map(({ name, value, sensitive }) => ({
			shown: `${name}=${sensitive ? "••••" : shellQuoted(value ?? "")}`,
			copied: `${name}=${sensitive ? `"$${name}"` : shellQuoted(value ?? "")}`,
			changed: true,
		})),
		{
			shown: `${cli?.custom ? shellQuoted(tilde(cli.path)) : "codework"} service start`,
			copied: `${cli?.custom ? shellQuoted(cli.path) : "codework"} service start`,
			changed: cli?.custom === true,
		},
		...(home.custom
			? [
					{
						shown: `--home ${shellQuoted(tilde(home.path))}`,
						copied: `--home ${shellQuoted(home.path)}`,
						changed: true,
					},
				]
			: []),
		...(args === "" ? [] : [{ shown: args, copied: args, changed: true }]),
	];
	return (
		<CopyCommand
			command={parts.map((part) => part.copied).join(" ")}
			shown={parts.map((part, i) => (
				<span key={i} className={part.changed ? "text-ink" : "text-ink-secondary"}>
					{i > 0 && " "}
					{part.shown}
				</span>
			))}
		/>
	);
}

/** Advanced: the server's runtime settings from Providers, saved as each is left. */
function LaunchSettings({ status }: { readonly status: LocalServerStatus }) {
	const [open, setOpen] = useState(false);
	const configure = useConfigure(status.id);
	const { cli, home } = status;
	return (
		<>
			<Disclosure open={open} onToggle={() => setOpen((shown) => !shown)}>
				Advanced
			</Disclosure>
			<Collapse open={open}>
				<div className="flex flex-col gap-3 pt-3">
					<LaunchField
						label="Executable"
						hint={cli !== null && !cli.custom ? `Found at ${tilde(cli.path)}` : undefined}
					>
						{(id) => (
							<SettingInput
								id={id}
								label="Executable"
								value={cli?.custom ? cli.path : ""}
								placeholder={cli !== null && !cli.custom ? cli.path : "codework"}
								onSave={(next) => configure({ executable: next || null })}
							/>
						)}
					</LaunchField>
					<LaunchField label="Home Directory" hint="Where codework keeps its configuration">
						{(id) => (
							<SettingInput
								id={id}
								label="Home Directory"
								// An added server always has its own home, so only the built-in one shows a default to reset to.
								value={home.fallback === null || home.custom ? home.path : ""}
								placeholder={home.fallback ?? "~/.codework-2"}
								resettable={home.fallback !== null}
								onSave={(next) => configure({ home: next || null })}
							/>
						)}
					</LaunchField>
					<LaunchField
						label="Launch Arguments"
						hint="Additional CLI arguments passed to codework on service start"
					>
						{(id) => (
							<SettingInput
								id={id}
								label="Launch Arguments"
								value={status.args}
								placeholder="--port 7433"
								onSave={(next) => configure({ args: next })}
							/>
						)}
					</LaunchField>
					<LaunchField label="Environment" hint="API keys, base URLs, and other per-service CLI settings">
						<Variables
							key={JSON.stringify(status.env)}
							saved={status.env}
							onSave={(env) => configure({ env })}
							compact
						/>
					</LaunchField>
				</div>
			</Collapse>
		</>
	);
}

const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

/** A setting with its hint; one taking its input's id gets a label that focuses it. */
function LaunchField({
	label,
	hint,
	children,
}: {
	readonly label: string;
	readonly hint: string | undefined;
	readonly children: ReactNode | ((id: string) => ReactNode);
}) {
	const id = useId();
	const field = typeof children === "function";
	return (
		<div className="flex flex-col gap-1.5">
			<span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
				{field ? (
					<label htmlFor={id} className="font-medium text-ink">
						{label}
					</label>
				) : (
					<span className="font-medium text-ink">{label}</span>
				)}
				{hint !== undefined && <span className="font-book text-pretty text-ink-muted">{hint}</span>}
			</span>
			{field ? children(id) : children}
		</div>
	);
}
