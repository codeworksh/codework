import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { CliAction, CliConfig, CliStatus } from "@codeworksh/server/contract";
import { Check, Copy, TriangleAlert, Undo2 } from "lucide-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import brand from "../../assets/codework.png";
import { Server } from "../../kernel/rpc";
import { Code, quietField as field, SavingInput } from "../blocks";
import { Variables } from "./variables";

export const cliKey = ["cli"];
export const statusAtom = Server.query("cli.status", undefined, { reactivityKeys: cliKey });
const serviceAtom = Server.mutation("cli.service");
const configureAtom = Server.mutation("cli.configure");

// The name is the app's own, kept in its kv store under the built-in package.
const nameKey = { package: "codework", key: "servers.local.name" } as const;
const nameKeys = ["servers.local.name"];
const nameAtom = Server.query("kv.get", nameKey, { reactivityKeys: nameKeys });
const saveNameAtom = Server.mutation("kv.set");

/** The local server's name: "CodeWork" until renamed. */
export function useLocalName() {
	const result = useAtomValue(nameAtom);
	const saved = AsyncResult.isSuccess(result) ? Option.getOrUndefined(result.value) : undefined;
	return typeof saved === "string" ? saved : "CodeWork";
}

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
	<span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>{children}</span>
);

const Mark = () => <img src={brand} alt="" className="size-5 shrink-0" />;

const Version = ({ version }: { version: string }) => (
	<span className="font-mono text-[13px] text-ink-muted">v{version}</span>
);

/** The local server's row in the list: always there, and the default. */
export function LocalItem({ status, selected }: { status: CliStatus | undefined; selected: boolean }) {
	const name = useLocalName();
	const cli = status?.cli;
	// Only the binary is judged here; the server's own state belongs to the detail.
	const problem =
		cli === undefined ? undefined : cli === null ? "No codework found" : "failure" in cli ? cli.failure : undefined;
	return (
		<div className={`flex items-start gap-3 px-5 py-4 ${selected ? "bg-ink/4" : ""}`}>
			<span className="pt-0.5">
				<Mark />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<span className="flex flex-wrap items-center gap-2">
					<span className="truncate font-medium">{name}</span>
					{cli != null && "version" in cli && <Version version={cli.version} />}
					{problem !== undefined && (
						<TriangleAlert className="size-3.5 shrink-0 text-warning" aria-label={problem}>
							<title>{problem}</title>
						</TriangleAlert>
					)}
				</span>
				<span className="flex flex-wrap gap-1.5">
					<Badge tone="muted">Local</Badge>
					<Badge tone="info">Default</Badge>
				</span>
			</div>
		</div>
	);
}

/** The local server: its name, its state and controls, then the executable that runs it and its home. */
export function LocalDetail({ status }: { status: CliStatus }) {
	const service = useAtomSet(serviceAtom, { mode: "promise" });
	const saveName = useAtomSet(saveNameAtom, { mode: "promise" });
	const saveConfig = useAtomSet(configureAtom, { mode: "promise" });
	const name = useLocalName();
	const [running, setRunning] = useState<CliAction | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nameError, setNameError] = useState<string | null>(null);
	const { server, cli } = status;
	const usable = cli !== null && "version" in cli;

	const configure = (config: typeof CliConfig.Type) =>
		saveConfig({ payload: config, reactivityKeys: cliKey }).then(
			() => undefined,
			(cause: unknown) => messageOf(cause),
		);

	const act = (action: CliAction) => {
		setError(null);
		setRunning(action);
		service({ payload: { action }, reactivityKeys: cliKey })
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => setRunning(null));
	};

	return (
		<div className="flex min-w-0 flex-col gap-6 p-4 @3xl:p-6">
			<header className="flex items-center gap-3 px-2">
				<Mark />
				<span className="truncate text-[15px] font-medium">{name}</span>
				<Badge tone="muted">Local</Badge>
			</header>

			<Card>
				<Field title="Name" description="How this server is listed in codework.">
					<SavingInput
						label="Server name"
						value={name}
						className={field}
						onCommit={(next) => {
							// The server keeps its name when the field is cleared.
							if (!next) return;
							setNameError(null);
							saveName({ payload: { ...nameKey, value: next }, reactivityKeys: nameKeys }).catch(
								(cause: unknown) => setNameError(messageOf(cause)),
							);
						}}
					/>
					{nameError !== null && <span className="text-[13px] text-destructive">{nameError}</span>}
				</Field>
			</Card>

			<Card>
				<div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-4">
					<div className="flex min-w-60 flex-1 flex-col gap-1">
						<span className="font-medium">Server</span>
						<span className="text-[13px] text-ink-muted">
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
				{error !== null && <p className="px-5 pb-4 text-[13px] text-destructive">{error}</p>}
			</Card>

			<section className="flex flex-col gap-3">
				<h3 className="px-2 text-[14px] text-ink-muted">Runtime</h3>
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
						{cli !== null && "failure" in cli && (
							<span className="text-[13px] text-destructive">{cli.failure}</span>
						)}
					</SettingField>
					<SettingField
						title={
							<>
								<Code>CODEWORK_HOME_DIR</Code> path
							</>
						}
						label="CODEWORK_HOME_DIR path"
						description="codework home and config directory."
						value={status.home.custom ? status.home.path : ""}
						placeholder={status.home.fallback}
						onSave={(next) => configure({ home: next || null })}
					/>
					<SettingField
						title="Launch Args"
						label="Launch Args"
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

			<section className="flex flex-col gap-3">
				<h3 className="px-2 text-[14px] text-ink-muted">Environment</h3>
				<Card>
					<Field
						title="Variables"
						description="API keys, base URLs, and other settings the server starts with. Changes apply when it next starts or restarts."
					>
						<Variables key={JSON.stringify(status.env)} saved={status.env} onSave={(env) => configure({ env })} />
					</Field>
				</Card>
			</section>
		</div>
	);
}

const Card = ({ children }: { children: ReactNode }) => (
	<div className="flex flex-col divide-y divide-edge rounded-xl border border-edge">{children}</div>
);

/** A titled block whose value sits under its description, as in a form. */
function Field({ title, description, children }: { title: ReactNode; description: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex flex-col gap-1 px-5 py-4">
			<span className="font-medium">{title}</span>
			<span className="text-[13px] text-ink-muted">{description}</span>
			<div className="mt-2 flex flex-col gap-1">{children}</div>
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
	onSave,
	children,
}: {
	title: ReactNode;
	/** The field's name for screen readers, when the title is more than text. */
	label: string;
	description: ReactNode;
	value: string;
	placeholder: string;
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
					className={`${field} font-mono text-[12px] md:text-[12px]`}
					onCommit={save}
				/>
				{value !== "" && (
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label={`Reset ${label} to default`}
						title="Reset to default"
						disabled={saving}
						onClick={() => save("")}
					>
						<Undo2 />
					</Button>
				)}
			</span>
			{error !== undefined && <span className="text-[13px] text-destructive">{error}</span>}
			{children}
		</Field>
	);
}

function ServerLine({ status }: { status: CliStatus }) {
	const { server } = status;
	if (server._tag === "Running")
		return (
			<>
				Running at <code className="font-mono">{server.url}</code> · pid {server.pid}
			</>
		);
	if (server._tag === "Incompatible")
		return (
			<>
				<code className="font-mono">{server.url}</code> · pid {server.pid} answers, but not in the form this app
				expects: it is another build. Update the CLI, or run a server built with this app.
			</>
		);
	if (server._tag === "Unreachable")
		return (
			<>
				Registered at <code className="font-mono">{server.url}</code> (pid {server.pid}) but not answering this app.
			</>
		);
	return "Not running. Once started, it keeps running in the background after the app quits.";
}

function CopyCommand({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="flex items-center gap-1 rounded-lg border border-edge bg-ink/3 py-1 pr-1 pl-3">
			<code className="flex-1 font-mono text-[12px]">{command}</code>
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
				{copied ? <Check /> : <Copy />}
			</Button>
		</span>
	);
}
