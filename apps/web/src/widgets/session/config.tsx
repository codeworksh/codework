import type { SettingsFile } from "@codeworksh/contract";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Cause, Option, Predicate } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode, useId, useState } from "react";

import { ModelPicker, ThinkingPicker } from "@/components/model";
import { Command, CommandEmpty, CommandInput, CommandList } from "@/components/ui/command";
import { menuSurface } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Plus } from "@/components/vuesax";
import { Server } from "../../kernel/rpc";
import { codeworkKey } from "../../kernel/servers";
import { tilde } from "../../shell/paths";
import { failed } from "../threads/common";

type File = "settings" | "mcp";

/** Settings reads refresh after every write; so does what they feed, such as the model list. */
const keys = ["settings", ...codeworkKey];

/** One file, keyed `<projectId>:<file>`; an empty project id is the user's file. */
const fileAtom = Atom.family((key: string) => {
	const at = key.lastIndexOf(":");
	const projectId = key.slice(0, at);
	const file = key.slice(at + 1) as File;
	return Server.query("settings.read", projectId === "" ? { file } : { projectId, file }, { reactivityKeys: keys });
});
const setAtom = Server.mutation("settings.set");
const writeAtom = Server.mutation("settings.write");

const useFile = (projectId: string | undefined, file: File) => {
	const result = useAtomValue(fileAtom(`${projectId ?? ""}:${file}`));
	return AsyncResult.isSuccess(result) ? result.value : undefined;
};

/** Sets one value in a project file; a refusal is a toast, and the page keeps showing the file. */
const useSet = (projectId: string, file: File) => {
	const set = useAtomSet(setAtom, { mode: "promise" });
	return (at: readonly [string | number, ...Array<string | number>], value?: unknown) =>
		set({
			payload: { projectId, file, at, ...(value === undefined ? {} : { value }) },
			reactivityKeys: keys,
		}).catch((error: unknown) => {
			failed(error);
			throw error;
		});
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
	Predicate.isObject(value) && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A section heading as Linear sets one, a step quieter: medium weight, in line with its rows' text. */
export function Heading({ children }: { readonly children: string }) {
	return <h2 className="px-4 text-[14px]/5 font-medium text-ink">{children}</h2>;
}

export function Section(props: {
	readonly title: string;
	/** A quiet link at the heading's end, to where the section's things are made. */
	readonly action?: ReactNode;
	readonly children: ReactNode;
}) {
	const { title, children } = props;
	return (
		<section className="flex flex-col gap-2.5">
			{props.action === undefined ? (
				<Heading>{title}</Heading>
			) : (
				<div className="flex items-center justify-between gap-4 pr-2">
					<Heading>{title}</Heading>
					{props.action}
				</div>
			)}
			<div className="flex flex-col divide-y divide-edge/60 overflow-hidden rounded-[10px] border border-edge/60">
				{children}
			</div>
		</section>
	);
}

/**
 * One setting: its name in regular weight, so the section heading above stays the step up, and a
 * muted line under it. The control sits at the end.
 */
export function Row(props: {
	readonly title: ReactNode;
	readonly description?: ReactNode;
	/** The description is a path, cut from its start: the last parts tell folders apart. */
	readonly path?: boolean;
	/** The id of the field this row sets: its name becomes that field's label. */
	readonly htmlFor?: string;
	readonly children?: ReactNode;
}) {
	const Title = props.htmlFor === undefined ? "span" : "label";
	return (
		<div className="flex min-h-15 items-center gap-4 px-4 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Title htmlFor={props.htmlFor} className="flex min-w-0 items-center gap-2 truncate">
					{props.title}
				</Title>
				{props.description !== undefined && (
					<span
						className={`min-w-0 truncate text-xs text-ink-muted ${props.path === true ? "text-left [direction:rtl]" : ""}`}
					>
						{props.description}
					</span>
				)}
			</div>
			{props.children}
		</div>
	);
}

/** A category beside a row's name: where a server comes from, which checkout a folder is. */
export function Tag({ children }: { readonly children: string }) {
	return (
		<span className="inline-flex h-4.5 shrink-0 items-center rounded-sm bg-ink/6 px-1.5 text-2xs text-ink-muted">
			{children}
		</span>
	);
}

const infoAtom = Server.query("host.info", undefined);

/** `path` with the home folder as `~`, once the server has said where home is. */
export const useTilde = () => {
	const info = useAtomValue(infoAtom);
	const home = AsyncResult.isSuccess(info) ? info.value.home : undefined;
	return (path: string) => tilde(path, home);
};

/** The model new sessions in this project start on, and how often a failed request is tried again. */
export function General({ projectId, hostDir }: { readonly projectId: string; readonly hostDir: string }) {
	const settings = useFile(projectId, "settings");
	const set = useSet(projectId, "settings");
	const retry = record(record(settings?.value).retry);
	const retries = retry.maxRetries;
	const retriesId = useId();
	return (
		<Section title="General">
			<Row title="Default Model" description="New sessions start on it">
				<div className="flex shrink-0 items-center gap-1">
					<ModelPicker
						hostDir={hostDir}
						value={undefined}
						onChange={(model) =>
							void set(["model", "provider"], model.provider).then(() => set(["model", "id"], model.id))
						}
					/>
					<ThinkingPicker
						hostDir={hostDir}
						model={undefined}
						value={undefined}
						onChange={(level) => void set(["model", "thinkingLevel"], level)}
					/>
				</div>
			</Row>
			<Row title="Retries" description="Attempts after a failed request" htmlFor={retriesId}>
				<Count
					// Keyed, so a saved value replaces what was typed.
					key={String(retries)}
					id={retriesId}
					value={typeof retries === "number" ? retries : undefined}
					inherited={settings?.inherited?.retry.maxRetries}
					onCommit={(next) =>
						// Clearing the last retry key takes the empty `retry` block with it.
						void (
							next === undefined && Object.keys(retry).every((key) => key === "maxRetries")
								? set(["retry"])
								: set(["retry", "maxRetries"], next)
						).catch(() => undefined)
					}
				/>
			</Row>
		</Section>
	);
}

/** What a count setting accepts, as the settings schema checks it: a whole number, 0 or more. */
const count = /^\d+$/;

/**
 * A count the project sets, saved on Enter or leaving it. Empty means the project sets none: the value
 * it then inherits shows as the placeholder. A typo is held and flagged until it is fixed, not saved.
 */
function Count(props: {
	readonly id: string;
	readonly value: number | undefined;
	readonly inherited: number | undefined;
	readonly onCommit: (value: number | undefined) => void;
}) {
	const saved = props.value === undefined ? "" : String(props.value);
	const [draft, setDraft] = useState(saved);
	const [invalid, setInvalid] = useState(false);
	const valid = (text: string) => text === "" || count.test(text);
	const commit = () => {
		const trimmed = draft.trim();
		if (!valid(trimmed)) return setInvalid(true);
		const next = trimmed === "" ? undefined : Number(trimmed);
		if (next === props.value) return setDraft(saved);
		props.onCommit(next);
	};
	return (
		<div className="flex shrink-0 items-center gap-2">
			{invalid && (
				<span id={`${props.id}-error`} className="text-xs text-destructive">
					Whole number, 0 or more
				</span>
			)}
			<input
				id={props.id}
				// Text, not `number`: a number field reads "1e" as empty, which here means "remove the setting".
				type="text"
				inputMode="numeric"
				pattern="[0-9]*"
				autoComplete="off"
				spellCheck={false}
				placeholder={props.inherited === undefined ? undefined : String(props.inherited)}
				aria-invalid={invalid}
				aria-describedby={invalid ? `${props.id}-error` : undefined}
				value={draft}
				onChange={(event) => {
					setDraft(event.target.value);
					// Once flagged, the flag clears the moment the value is fixed.
					if (invalid && valid(event.target.value.trim())) setInvalid(false);
				}}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") {
						// Puts the saved value back; the settings stay open.
						event.preventDefault();
						setDraft(saved);
						setInvalid(false);
					}
				}}
				className="h-7 w-20 rounded-md border border-edge/60 bg-transparent px-2 text-right text-xs tabular-nums outline-none transition-colors duration-150 ease-out placeholder:text-ink-muted/70 hover:bg-ink/4 focus:bg-ink/4 focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
			/>
		</div>
	);
}

interface McpRow {
	readonly name: string;
	readonly from: "project" | "user";
	readonly detail: Detail;
	readonly enabled: boolean;
	/** The project entry only turns the user's server on or off. */
	readonly override: boolean;
}

/** Where a server runs, as a line: its own description, else its command or URL. */
/** A server's line: its own description as prose, else its URL or command as code. */
interface Detail {
	readonly text: string;
	readonly code: boolean;
}

const detailOf = (config: Readonly<Record<string, unknown>>): Detail => {
	if (typeof config.description === "string") return { text: config.description, code: false };
	if (typeof config.url === "string") return { text: config.url, code: true };
	const args = Array.isArray(config.args) ? config.args.filter(Predicate.isString) : [];
	return { text: typeof config.command === "string" ? [config.command, ...args].join(" ") : "", code: true };
};

const isOverride = (config: Readonly<Record<string, unknown>>) =>
	config.command === undefined && config.url === undefined && config.type === undefined;

/** The MCP servers sessions in this project connect to: the project's own, and the user's it can turn off. */
export function Mcp({ projectId }: { readonly projectId: string }) {
	const project = useFile(projectId, "mcp");
	const user = useFile(undefined, "mcp");
	const set = useSet(projectId, "mcp");
	if (project === undefined || user === undefined) return null;
	const own = record(record(project.value).mcpServers);
	const theirs = record(record(user.value).mcpServers);
	const servers: Array<McpRow> = [];
	for (const [name, raw] of Object.entries(theirs)) {
		const config = record(raw);
		const local = record(own[name]);
		const override = name in own && isOverride(local);
		if (name in own && !override) continue;
		servers.push({
			name,
			from: "user",
			detail: detailOf(config),
			enabled: (override ? local.enabled : config.enabled) !== false,
			override,
		});
	}
	for (const [name, raw] of Object.entries(own)) {
		const config = record(raw);
		if (isOverride(config)) continue;
		servers.push({
			name,
			from: "project",
			detail: detailOf(config),
			enabled: config.enabled !== false,
			override: false,
		});
	}
	servers.sort((a, b) => a.name.localeCompare(b.name));
	const toggle = (server: McpRow, enabled: boolean) => {
		// Turning a user server back on drops the project's override rather than leaving `enabled: true`.
		const keys = Object.keys(record(own[server.name]));
		if (server.from === "user" && enabled && keys.every((key) => key === "enabled"))
			return void set(["mcpServers", server.name]).catch(() => undefined);
		void set(["mcpServers", server.name, "enabled"], enabled).catch(() => undefined);
	};
	const yours = servers.filter((server) => server.from === "user");
	const local = servers.filter((server) => server.from === "project");
	const row = (server: McpRow) => (
		<Row
			key={server.name}
			// A server that is off reads quieter, so the list shows at a glance what this project uses.
			title={
				<span
					className={`truncate transition-colors duration-150 ease-out ${server.enabled ? "" : "text-ink-muted"}`}
				>
					{server.name}
				</span>
			}
			description={
				server.detail.code ? (
					<span className="font-mono text-[11px]">{server.detail.text}</span>
				) : (
					server.detail.text
				)
			}
		>
			<Switch
				aria-label={`Use ${server.name}`}
				checked={server.enabled}
				onCheckedChange={(checked) => toggle(server, checked)}
			/>
		</Row>
	);
	return (
		<Section
			title="MCP Connectors"
			action={
				<Link
					to="/settings/mcp"
					title="Your MCP Servers in Settings"
					className="relative flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-ink-muted outline-none transition-[background-color,color] duration-150 ease-out before:absolute before:-inset-y-2 before:inset-x-0 hover:bg-ink/6 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
				>
					Manage
					<ArrowUpRightIcon className="size-3" aria-hidden />
				</Link>
			}
		>
			{project.error !== undefined && (
				<Row title="Errors in mcp.json" description={<span className="text-destructive">{project.error}</span>} />
			)}
			{yours.length > 0 && (
				<Group label="User" count={yours.length}>
					{yours.map(row)}
				</Group>
			)}
			{/* Connectors are added to the project; signing in to one belongs to your user settings. */}
			<Group label="Project" count={local.length}>
				{local.map(row)}
				<AddConnector />
			</Group>
		</Section>
	);
}

/** Opens the connector directory as a searchable menu. The directory is not listed yet. */
function AddConnector() {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	return (
		// The button's own padding stands in for the row's on its side, so its text lines up with the switches.
		<div className="flex min-h-15 items-center justify-between gap-4 py-3 pr-2 pl-4">
			<span className="min-w-0 truncate text-ink-muted">Add a Connector to this Project</span>
			<PopoverPrimitive.Root
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setSearch("");
				}}
			>
				<PopoverPrimitive.Trigger asChild>
					<button
						type="button"
						className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-ink/6 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] data-[state=open]:bg-ink/6"
					>
						<Plus className="size-3.5" aria-hidden />
						Add Connector
					</button>
				</PopoverPrimitive.Trigger>
				<PopoverPrimitive.Portal>
					<PopoverPrimitive.Content
						align="start"
						sideOffset={4}
						collisionPadding={8}
						className={cn("z-50 w-60 overflow-hidden outline-hidden", menuSurface)}
					>
						{/* Dense, as the other menus: a plain 32px search row and a short empty line. */}
						<Command
							loop
							className="**:data-[slot=command-input-wrapper]:h-8 **:data-[slot=command-input-wrapper]:px-2.5"
						>
							<CommandInput
								start={false}
								value={search}
								onValueChange={setSearch}
								placeholder="Search"
								aria-label="Search connectors"
								className="h-8 py-0 text-[13px]"
							/>
							<CommandList>
								<CommandEmpty className="flex flex-col">
									<span className="px-2.5 py-2 text-[13px] text-ink-muted">No Connectors Found</span>
									{/* Where connectors come from: your user settings, where they are added and signed in to. */}
									<div className="border-t p-1">
										<Link
											to="/settings/mcp"
											onClick={() => setOpen(false)}
											// The list takes Enter for its own rows; on the link it follows the link.
											onKeyDown={(event) => {
												if (event.key === "Enter") event.stopPropagation();
											}}
											className="flex h-7 items-center gap-1.5 rounded-[8px] px-1.5 text-[13px] outline-none transition-colors duration-150 ease-out hover:bg-accent focus-visible:bg-accent"
										>
											Manage
											<ArrowUpRightIcon className="size-3 text-ink-muted" aria-hidden />
										</Link>
									</div>
								</CommandEmpty>
							</CommandList>
						</Command>
					</PopoverPrimitive.Content>
				</PopoverPrimitive.Portal>
			</PopoverPrimitive.Root>
		</div>
	);
}

/**
 * Rows from one source inside a section, under a quiet label: where they come from is said once for the
 * group instead of on every row.
 */
function Group(props: { readonly label: string; readonly count: number; readonly children: ReactNode }) {
	const id = useId();
	return (
		<div role="group" aria-labelledby={id} className="flex flex-col divide-y divide-edge/60">
			<div className="flex h-8 items-center justify-between bg-ink/2 px-4 text-xs text-ink-muted">
				<span id={id}>{props.label}</span>
				{props.count > 0 && <span className="tabular-nums">{props.count}</span>}
			</div>
			{props.children}
		</div>
	);
}

/** The project's files, each opened in place to edit as text: for whatever the rows above do not cover. */
export function Files({ projectId, hostDir }: { readonly projectId: string; readonly hostDir: string }) {
	return (
		<Section title="Advanced">
			<FileRow projectId={projectId} hostDir={hostDir} file="settings" />
			<FileRow projectId={projectId} hostDir={hostDir} file="mcp" />
		</Section>
	);
}

const nameOf = (path: string) => path.split("/").at(-1) ?? path;

/** What each file holds, as its row says it. */
const purposes: Record<File, string> = { settings: "Default model, plugins and retries", mcp: "MCP servers" };

function FileRow(props: { readonly projectId: string; readonly hostDir: string; readonly file: File }) {
	const { projectId, file } = props;
	const current = useFile(projectId, file);
	const shorten = useTilde();
	const [open, setOpen] = useState(false);
	if (current === undefined) return null;
	// A file above the host directory belongs to an outer project, and that is worth seeing before editing.
	const outside = !current.path.startsWith(`${props.hostDir}/`);
	return (
		<div className="flex flex-col">
			<Row
				title={<span title={current.path}>{nameOf(current.path)}</span>}
				path={current.error === undefined && outside}
				description={
					current.error !== undefined ? (
						<span className="text-destructive">{current.error}</span>
					) : outside ? (
						<bdi title={current.path}>{shorten(current.path)}</bdi>
					) : (
						purposes[file]
					)
				}
			>
				{!open && (
					<button
						type="button"
						onClick={() => setOpen(true)}
						className="h-7 shrink-0 rounded-md border border-edge/60 px-2.5 text-xs outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-ink/6 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
					>
						Edit
					</button>
				)}
			</Row>
			{open && <Editor projectId={projectId} file={file} current={current} onClose={() => setOpen(false)} />}
		</div>
	);
}

/** The file as text. Saved only if nobody changed it meanwhile; a refusal keeps what was typed. */
function Editor(props: {
	readonly projectId: string;
	readonly file: File;
	readonly current: SettingsFile;
	readonly onClose: () => void;
}) {
	const write = useAtomSet(writeAtom, { mode: "promiseExit" });
	const refresh = useAtomRefresh(fileAtom(`${props.projectId}:${props.file}`));
	// The text and the version it was started from, so a reload can start over.
	const [base, setBase] = useState(props.current);
	const [draft, setDraft] = useState(props.current.source);
	const [problem, setProblem] = useState<{ readonly message: string; readonly conflict: boolean }>();
	const [saving, setSaving] = useState(false);
	// A reload waits for the file read again, then starts over from it.
	const [reloading, setReloading] = useState(false);
	if (reloading && props.current.version !== base.version) {
		setReloading(false);
		setBase(props.current);
		setDraft(props.current.source);
		setProblem(undefined);
	}
	const save = async () => {
		setSaving(true);
		const exit = await write({
			payload: { projectId: props.projectId, file: props.file, source: draft, version: base.version },
			reactivityKeys: keys,
		});
		setSaving(false);
		if (exit._tag === "Success") return props.onClose();
		const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
		if (error?._tag === "Server.SettingsConflict")
			return setProblem({ message: "Changed on disk since you opened it.", conflict: true });
		setProblem({ message: error !== undefined && "message" in error ? error.message : "Not Saved", conflict: false });
	};
	return (
		<div className="flex flex-col gap-2 border-t border-edge/60 p-4">
			<textarea
				aria-label={nameOf(props.current.path)}
				value={draft}
				spellCheck={false}
				autoFocus
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						void save();
					}
					if (event.key === "Escape") {
						// The editor closes, not the settings page.
						event.preventDefault();
						props.onClose();
					}
				}}
				placeholder="{}"
				className="min-h-64 w-full resize-y rounded-md border border-edge/60 bg-ink/3 p-3 font-mono text-xs/5 outline-none [tab-size:2] focus:border-edge"
			/>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-xs text-destructive" title={problem?.message}>
					{problem?.message}
				</span>
				{problem?.conflict === true && (
					<FooterButton
						onClick={() => {
							setReloading(true);
							refresh();
						}}
					>
						Reload
					</FooterButton>
				)}
				<FooterButton onClick={props.onClose}>Cancel</FooterButton>
				<FooterButton primary disabled={saving || draft === base.source} onClick={() => void save()}>
					Save
				</FooterButton>
			</div>
		</div>
	);
}

function FooterButton(props: {
	readonly children: string;
	readonly onClick: () => void;
	readonly primary?: boolean;
	readonly disabled?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={props.disabled}
			onClick={props.onClick}
			className={`h-7 shrink-0 rounded-md px-2.5 text-xs outline-none transition-[background-color,scale,opacity] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 ${
				props.primary === true
					? "bg-primary text-primary-foreground hover:bg-primary/90"
					: "border border-edge/60 hover:bg-ink/6"
			}`}
		>
			{props.children}
		</button>
	);
}
