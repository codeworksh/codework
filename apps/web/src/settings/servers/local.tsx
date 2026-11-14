import { ArrowCounterClockwiseIcon, CheckIcon, CopyIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useAtomSet } from "@effect/atom-react";
import { type CliAction, LOCAL_SERVER, type LocalServerStatus, type ServerUpdate } from "@codeworksh/contract";

import { type ReactNode, useState } from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import brand from "../../assets/codework.png";
import { Server } from "../../kernel/rpc";
import { Code, Group as Card, quietField as field, SavingInput } from "../blocks";
import { Variables } from "./variables";

const serviceAtom = Server.mutation("servers.service");
const updateAtom = Server.mutation("servers.update");
const removeAtom = Server.mutation("servers.remove");
const setDefaultAtom = Server.mutation("servers.setDefault");

const INSTALL = "curl -fsSL https://codework.sh/install | sh";

type Tone = "success" | "warning" | "danger" | "info" | "muted";

const TONES: Record<Tone, string> = {
	success: "bg-success/15 text-success",
	warning: "bg-warning/15 text-warning",
	danger: "bg-destructive/15 text-destructive",
	info: "bg-info/15 text-info",
	muted: "bg-ink/8 text-ink-muted",
};

/** A small coloured pill: a server's state, or a fixed fact such as "Default". */
export const Badge = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
	<span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${TONES[tone]}`}>{children}</span>
);

export const Mark = () => <img src={brand} alt="" className="size-5 shrink-0" />;

/** What a server is called without the user's override: as shown while there is none. */
export const reportedName = (status: LocalServerStatus) =>
	status.override === null ? status.name : (status.host ?? undefined);

const Version = ({ version }: { version: string }) => (
	<span className="font-mono text-xs text-ink-muted">v{version}</span>
);

/**
 * Starts, restarts or stops a server through its CLI.
 * `act` resolves to whether it worked; the app server checks the servers again either way.
 */
function useServerAction() {
	const service = useAtomSet(serviceAtom, { mode: "promise" });
	const [running, setRunning] = useState<CliAction | null>(null);
	const [error, setError] = useState<string | null>(null);
	const act = (id: string, action: CliAction) => {
		setError(null);
		setRunning(action);
		return service({ payload: { id, action } })
			.then(
				() => true,
				(cause: unknown) => {
					setError(messageOf(cause));
					return false;
				},
			)
			.finally(() => setRunning(null));
	};
	return { running, error, act };
}

/** A server's row in the list: its name and binary, and whether it is the default. */
export function LocalItem({ status }: { status: LocalServerStatus }) {
	const { cli } = status;
	// Only the binary is judged here; the server's own state belongs to the detail.
	const problem = cli === null ? "No codework found" : "failure" in cli ? cli.failure : undefined;
	return (
		<div className="flex items-start gap-3">
			<span className="pt-0.5">
				<Mark />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<span className="flex flex-wrap items-center gap-2">
					<span className="truncate font-medium">{status.name}</span>
					{status.host !== null && status.host !== status.name && (
						<span className="truncate text-xs text-ink-muted">{status.host}</span>
					)}
					{cli !== null && "version" in cli && <Version version={cli.version} />}
					{problem !== undefined && (
						<WarningIcon className="size-3.5 shrink-0 text-warning" aria-label={problem}>
							<title>{problem}</title>
						</WarningIcon>
					)}
					{status.isDefault && <Badge tone="info">Default</Badge>}
				</span>
				<StatusLine status={status} />
			</div>
		</div>
	);
}

const DOTS: Record<Tone, string> = {
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-destructive",
	info: "bg-info",
	muted: "bg-ink-muted/50",
};

/** A server's state in a few words, as its row in the list reads it. */
function stateOf({ cli, server }: LocalServerStatus): { tone: Tone; text: string } {
	if (cli === null) return { tone: "warning", text: "Not installed" };
	if ("failure" in cli) return { tone: "danger", text: "Won't start" };
	switch (server._tag) {
		case "Running":
			return { tone: "success", text: `Running · ${new URL(server.url).host}` };
		case "Unreachable":
			return { tone: "warning", text: "Not answering" };
		case "Incompatible":
			return { tone: "danger", text: "Incompatible version" };
		case "Stopped":
			return { tone: "muted", text: "Stopped" };
	}
}

const StatusLine = ({ status }: { status: LocalServerStatus }) => {
	const { tone, text } = stateOf(status);
	return (
		<span className="flex items-center gap-1.5 text-xs text-ink-muted">
			<span className={`size-1.5 shrink-0 rounded-full ${DOTS[tone]}`} aria-hidden />
			<span className="truncate">{text}</span>
		</span>
	);
};

/** A local server: its name, its state and controls, then how it runs and what it starts with. */
export function LocalDetail({ status }: { status: LocalServerStatus }) {
	const update = useAtomSet(updateAtom, { mode: "promise" });
	const { running, error: actionError, act: run } = useServerAction();
	const [error, setError] = useState<string | null>(null);
	const [nameError, setNameError] = useState<string | null>(null);
	const { id, server, cli } = status;
	const usable = cli !== null && "version" in cli;

	const configure = (patch: Omit<ServerUpdate, "id">) =>
		update({ payload: { id, ...patch } }).then(
			() => undefined,
			(cause: unknown) => messageOf(cause),
		);

	const act = (action: CliAction) => {
		setError(null);
		void run(id, action);
	};

	return (
		<div className="flex min-w-0 flex-col gap-5">
			{/* As tall as its buttons, so a server that can be removed does not sit lower than one that cannot. */}
			<header className="flex min-h-8 flex-wrap items-center gap-2">
				<Mark />
				<h2 className="min-w-0 truncate text-ui font-medium">{status.name}</h2>
				<Badge tone="muted">Local</Badge>
				{status.isDefault && <Badge tone="info">Default</Badge>}
				<span className="flex-1" />
				<MakeDefault status={status} onError={setError} />
				<ServerActions status={status} onError={setError} />
			</header>

			<Card>
				<Field title="Name" description="Shown in your provider list.">
					<SavingInput
						label="Server name"
						value={status.override ?? ""}
						placeholder={reportedName(status)}
						className={field}
						onCommit={(next) => {
							setNameError(null);
							void configure({ name: next }).then((failure) => setNameError(failure ?? null));
						}}
					/>
					{nameError !== null && <span className="text-sm text-destructive">{nameError}</span>}
				</Field>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
					<div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
						<span className="font-medium">Connection</span>
						<span className="text-ui text-ink-muted">
							<ServerLine status={status} />
						</span>
					</div>
					{usable && server._tag === "Stopped" && (
						<Button size="sm" disabled={running !== null} onClick={() => act("start")}>
							{running === "start" ? "Starting…" : "Start"}
						</Button>
					)}
					{usable && server._tag !== "Stopped" && (
						<div className="flex shrink-0 gap-1">
							<Button size="sm" variant="secondary" disabled={running !== null} onClick={() => act("restart")}>
								{running === "restart" ? "Restarting…" : "Restart"}
							</Button>
							<Button size="sm" variant="ghost" disabled={running !== null} onClick={() => act("stop")}>
								{running === "stop" ? "Stopping…" : "Stop"}
							</Button>
						</div>
					)}
				</div>
				{(actionError ?? error) !== null && (
					<p className="px-4 pb-3 text-ui text-destructive">{actionError ?? error}</p>
				)}
			</Card>

			<section className="flex flex-col gap-2">
				<h3 className="text-ui font-medium text-ink-muted">Runtime</h3>
				<Card>
					<SettingField
						title="Executable"
						label="Executable"
						description={
							cli === null
								? "No codework found in the install script's folder or on your login shell's PATH. Enter its path, or install it:"
								: "Path to the codework binary used by this instance."
						}
						value={cli?.custom ? cli.path : ""}
						placeholder={cli !== null && !cli.custom ? cli.path : "codework"}
						onSave={(next) => configure({ executable: next || null })}
					>
						{cli === null && <CopyCommand command={INSTALL} />}
						{cli !== null && "failure" in cli && <span className="text-sm text-destructive">{cli.failure}</span>}
					</SettingField>
					<SettingField
						title="Home directory"
						label="CODEWORK_HOME_DIR path"
						description="Where this provider stores its sessions and configuration."
						// An added server always has its own home, so only the built-in one shows a default to reset to.
						value={status.home.fallback === null || status.home.custom ? status.home.path : ""}
						placeholder={status.home.fallback ?? "~/.codework-2"}
						resettable={status.home.fallback !== null}
						onSave={(next) => configure({ home: next || null })}
					/>
					<SettingField
						title="Launch arguments"
						label="Launch arguments"
						description={
							<>
								Additional CLI arguments passed to <Code>codework service start</Code>.
							</>
						}
						value={status.args}
						placeholder="--port 7433"
						onSave={(next) => configure({ args: next })}
					/>
				</Card>
			</section>

			<section className="flex flex-col gap-2">
				<h3 className="text-ui font-medium text-ink-muted">Environment</h3>
				<Card>
					<div className="flex flex-col gap-3 px-4 py-3">
						<p className="text-ui text-ink-muted">
							API keys and other variables for this provider. Changes apply after restarting.
						</p>
						<Variables key={JSON.stringify(status.env)} saved={status.env} onSave={(env) => configure({ env })} />
					</div>
				</Card>
			</section>
		</div>
	);
}

/** Moves the default, the server the app connects through, here; the default itself shows none. */
function MakeDefault({ status, onError }: { status: LocalServerStatus; onError: (message: string) => void }) {
	const setDefault = useAtomSet(setDefaultAtom, { mode: "promise" });
	const [switching, setSwitching] = useState(false);
	if (status.isDefault) return null;
	return (
		<Button
			size="sm"
			variant="outline"
			disabled={switching}
			title="Connect the app through this server"
			onClick={() => {
				setSwitching(true);
				setDefault({ payload: { id: status.id } })
					.catch((cause: unknown) => onError(messageOf(cause)))
					.finally(() => setSwitching(false));
			}}
		>
			{switching ? "Switching…" : "Make Default"}
		</Button>
	);
}

/** Remove, for the servers it applies to: the built-in one and the default stay. */
function ServerActions({ status, onError }: { status: LocalServerStatus; onError: (message: string) => void }) {
	const remove = useAtomSet(removeAtom, { mode: "promise" });
	const [busy, setBusy] = useState(false);
	const run = (action: () => Promise<unknown>) => {
		setBusy(true);
		action()
			.catch((cause: unknown) => onError(messageOf(cause)))
			.finally(() => setBusy(false));
	};
	return (
		<>
			{!status.isDefault && status.id !== LOCAL_SERVER && (
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={`Remove ${status.name}`}
							title="Remove"
							disabled={busy}
						>
							<TrashIcon />
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Remove {status.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								The app forgets this server's settings. Its home, and a server running from it, are left as they
								are.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={() => run(() => remove({ payload: { id: status.id } }))}>
								Remove
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</>
	);
}

/** A titled block whose value sits under its description, as in a form. */
function Field({ title, description, children }: { title: ReactNode; description: ReactNode; children?: ReactNode }) {
	return (
		<div className="grid items-start gap-3 px-4 py-3 @min-[560px]:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] @min-[560px]:gap-6">
			<div className="flex min-w-0 flex-col gap-1">
				<span className="font-medium">{title}</span>
				<span className="text-ui text-ink-muted">{description}</span>
			</div>
			<div className="flex min-w-0 flex-col gap-1">{children}</div>
		</div>
	);
}

/**
 * A setting the user may change: the field saves when left; blank, or Reset while it is set, goes
 * back to the default its placeholder shows. Its error, from saving, shows under it until the next save.
 */
function SettingField({
	title,
	label,
	description,
	value,
	placeholder,
	resettable = true,
	onSave,
	children,
}: {
	title: ReactNode;
	/** The field's name for screen readers, when the title is more than text. */
	label: string;
	description: ReactNode;
	value: string;
	placeholder: string;
	/** Whether a set value can go back to the default; an added server's home has none. */
	resettable?: boolean;
	onSave: (value: string) => Promise<string | undefined>;
	children?: ReactNode;
}) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const save = (next: string) => {
		setSaving(true);
		setError(undefined);
		void onSave(next).then((failure) => {
			setError(failure);
			setSaving(false);
		});
	};
	return (
		<Field title={title} description={description}>
			<span className="flex items-center gap-2">
				<SavingInput
					label={label}
					value={value}
					placeholder={placeholder}
					className={`${field} font-mono text-xs md:text-xs`}
					onCommit={save}
				/>
				{resettable && value !== "" && (
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label={`Reset ${label} to default`}
						title="Reset to default"
						disabled={saving}
						onClick={() => save("")}
					>
						<ArrowCounterClockwiseIcon />
					</Button>
				)}
			</span>
			{error !== undefined && <span className="text-sm text-destructive">{error}</span>}
			{children}
		</Field>
	);
}

function ServerLine({ status }: { status: LocalServerStatus }) {
	const { server } = status;
	if (server._tag === "Running")
		return (
			<>
				Running at <code className="font-mono text-xs break-all">{server.url}</code> · pid {server.pid}
			</>
		);
	if (server._tag === "Incompatible")
		return (
			<>
				<code className="font-mono text-xs break-all">{server.url}</code> · pid {server.pid} answers, but not in the
				form this app expects: it is another build. Update the CLI, or run a server built with this app.
			</>
		);
	if (server._tag === "Unreachable")
		return (
			<>
				Registered at <code className="font-mono text-xs break-all">{server.url}</code> (pid {server.pid}) but not
				answering this app.
			</>
		);
	return "Not running. Once started, it keeps running in the background after the app quits.";
}

function CopyCommand({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="flex items-center gap-1 rounded-lg border border-edge bg-ink/3 py-1 pr-1 pl-3">
			<code className="flex-1 font-mono text-xs">{command}</code>
			<Button
				size="icon-xs"
				variant="ghost"
				aria-label="Copy install command"
				title="Copy"
				onClick={() =>
					void navigator.clipboard.writeText(command).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
				}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</Button>
		</span>
	);
}
