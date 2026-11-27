import { shellQuoted } from "@codeworksh/schema";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useAtomSet } from "@effect/atom-react";
import { type CliAction, type LocalServerStatus, type ServerUpdate } from "@codeworksh/contract";
import { type ReactNode, useState } from "react";

import { CopyCommand } from "@/components/copyable";
import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import { installAtom, serviceAtom, updateAtom } from "../../kernel/servers";
import { quietField as field, SavingInput } from "../blocks";

/** The pieces of this machine's CodeWork server that its page and Setup share. */

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

/**
 * Starts, restarts or stops a server through its CLI.
 * `act` resolves to whether it worked; the app server checks the servers again either way.
 */
export function useServerAction() {
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

/** A server's state in a few words, as its row in the list reads it. */
export function stateOf({ cli, server }: LocalServerStatus): { tone: Tone; text: string } {
	if (cli === null) return { tone: "warning", text: "Not Installed" };
	if ("failure" in cli) return { tone: "danger", text: "Won’t Start" };
	switch (server._tag) {
		case "Running":
			return { tone: "success", text: "Running" };
		case "Unreachable":
			return { tone: "warning", text: "Not Answering" };
		case "Incompatible":
			return { tone: "danger", text: "Incompatible Version" };
		case "Stopped":
			return { tone: "muted", text: "Stopped" };
	}
}

/** Saves part of a server's settings; resolves to the failure's message, or nothing once saved. */
export function useConfigure(id: string) {
	const update = useAtomSet(updateAtom, { mode: "promise" });
	return (patch: Omit<ServerUpdate, "id">) =>
		update({ payload: { id, ...patch } }).then(
			() => undefined,
			(cause: unknown) => messageOf(cause),
		);
}

interface SettingInputProps {
	/** For a visible label that points at the field. */
	id?: string;
	/** The field's name for screen readers, when the title is more than text. */
	label: string;
	value: string;
	placeholder: string;
	/** Whether a set value can go back to the default; an added server's home has none. */
	resettable?: boolean;
	/** What hovering shows, empty for nothing; by default the value, else the default its placeholder names. */
	hover?: string | undefined;
	onSave: (value: string) => Promise<string | undefined>;
}

/** A setting's field with its Reset, and the error from saving it until the next save. */
export function SettingInput({
	id,
	label,
	value,
	placeholder,
	resettable = true,
	hover = value || placeholder,
	onSave,
}: SettingInputProps) {
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
		<>
			<span className="flex items-center gap-2">
				<SavingInput
					id={id}
					label={label}
					value={value}
					placeholder={placeholder}
					// Paths run longer than the field; the whole one shows on hover.
					title={hover}
					className={`${field} font-mono text-xs md:text-xs`}
					onCommit={save}
				/>
				{resettable && value !== "" && (
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label={`Reset ${label} to default`}
						title="Reset to Default"
						disabled={saving}
						onClick={() => save("")}
					>
						<ArrowCounterClockwiseIcon />
					</Button>
				)}
			</span>
			{error !== undefined && <span className="text-sm text-destructive">{error}</span>}
		</>
	);
}

/** Runs the install command for the user, then starts this server; the status shows the result. */
export function Install({ id }: { id: string }) {
	const install = useAtomSet(installAtom, { mode: "promise" });
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<span className="flex flex-col items-start gap-1">
			<Button
				size="sm"
				disabled={installing}
				onClick={() => {
					setInstalling(true);
					setError(null);
					install({ payload: { id } })
						.catch((cause: unknown) => setError(messageOf(cause)))
						.finally(() => setInstalling(false));
				}}
			>
				{installing ? "Installing…" : "Install CodeWork"}
			</Button>
			{error !== null && <span className="text-sm text-destructive">{error}</span>}
		</span>
	);
}

/** A home-relative path as people write it. */
export const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

/**
 * The command that starts this server, as the app runs it: its variables, binary, home and arguments.
 * One line, cut short where it runs out, what the user changed in ink; the copy is the whole command.
 * Secrets never reach the app, so the copy reads them from the shell.
 */
export function LaunchCommand({ status }: { readonly status: LocalServerStatus }) {
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
