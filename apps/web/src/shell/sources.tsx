import { ProviderIcon } from "@/components/provider";
import {
	ArrowBendDownLeftIcon,
	ArrowBendLeftUpIcon,
	ArrowLeftIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	GitBranchIcon,
	LinkIcon,
} from "@phosphor-icons/react";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Cause, Option, Predicate } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type KeyboardEvent, type ReactNode, useContext, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useLast } from "@/hooks/last";
import { CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { messageOf } from "@/lib/utils";
import { isMac } from "@codeworksh/widget/view";
import type { SidebarProject } from "@codeworksh/contract";
import { type MachineEntry, useRowId } from "@/components/machine";
import { runQuery, Server } from "../kernel/rpc";
import { machineAtom, placeAtom } from "../landing/place";
import { useWatchClones } from "./clones";
import { projectsAtom } from "../widgets/session/projects";
import {
	cloneName,
	cloneTarget,
	cloneUrl,
	complete,
	directoryOf,
	filterFolders,
	isBrowseQuery,
	leafOf,
	ownerOnly,
	parentOf,
	pastedPath,
	projectFolder,
	tilde,
} from "./paths";

/** The palette's Add Project steps, after the root list. */
export type View =
	| { kind: "sources" }
	| { kind: "browse" }
	| { kind: "create" }
	| { kind: "remote"; source: "url" | "github" }
	| { kind: "destination"; remote: string; title: string; detail: string; name: string };

/** One step on the palette's stack and what was typed in it, kept for coming back. */
export interface Step {
	readonly view: View;
	readonly query: string;
}

export interface Nav {
	readonly step: Step;
	readonly setQuery: (query: string) => void;
	readonly push: (view: View, query?: string) => void;
	readonly pop: () => void;
	readonly close: () => void;
}

/** The palette's list fills what its input, summary and footer leave. */
export const PALETTE_LIST = "max-h-none min-h-0 flex-1";

const BROWSE_START = "~/";
const LISTING_TTL = "5 seconds";
const bridge = window.desktopBridge;
const fileManager = isMac ? "Finder" : "Files";

// Keyed by machine, `""` being the default one: each machine has its own home, folders and gh.
const on = (machineId: string | undefined) => (machineId === undefined ? {} : { machineId });
export const infoAtom = Atom.family((machineId: string) => Server.query("host.info", on(machineId || undefined)));
// gh checks its login over the network: kept a while, so opening the palette again does not ask anew.
const githubAtom = Atom.family((machineId: string) =>
	Server.query("github.status", on(machineId || undefined), { timeToLive: "5 minutes" }),
);
const listing = (path: string, machineId: string | undefined) =>
	Server.query("host.browse", { ...on(machineId), path }, { timeToLive: LISTING_TTL });
const addAtom = Server.mutation("host.add");
const createAtom = Server.mutation("host.create");
const cloneAtom = Server.mutation("host.clone");
const lookupAtom = Server.mutation("github.lookup");

const failureOf = <A, E>(result: AsyncResult.AsyncResult<A, E>) =>
	AsyncResult.isFailure(result) ? messageOf(result.cause) : undefined;

/** Why a listing failed, when the host says: a path that is not there, or is a file. */
const reasonOf = <A, E>(result: AsyncResult.AsyncResult<A, E>) => {
	if (!AsyncResult.isFailure(result)) return undefined;
	const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
	return Predicate.hasProperty(error, "reason") && (error.reason === "missing" || error.reason === "file")
		? error.reason
		: undefined;
};

/** The machine Add Project adds to: the start page's when it opened, none being the default one. */
const AddMachine = createContext<MachineEntry | undefined>(undefined);

/** The flow's machine, and what host calls name it by: none for the default machine. */
function useAddMachine() {
	const machine = useContext(AddMachine);
	return { machine, machineId: machine === undefined || machine.isDefault ? undefined : machine.id };
}

/** The palette's Add Project steps: pick a source, then browse, name, or clone into a folder. */
export function AddProject({ machine, ...nav }: Nav & { readonly machine: MachineEntry | undefined }) {
	return <AddMachine.Provider value={machine}>{step(nav)}</AddMachine.Provider>;
}

function step(nav: Nav) {
	switch (nav.step.view.kind) {
		case "sources":
			return <Sources {...nav} />;
		case "browse":
			return <Browse {...nav} />;
		case "create":
			return <Create {...nav} />;
		case "remote":
			return <Remote {...nav} source={nav.step.view.source} />;
		case "destination":
			return <Destination {...nav} target={nav.step.view} />;
	}
}

/** The step's folder becomes the start page's project, on the flow's machine, and the palette closes there. */
function useFinish(close: () => void) {
	const setPlace = useAtomSet(placeAtom);
	const setMachine = useAtomSet(machineAtom);
	const { machineId } = useAddMachine();
	const rowId = useRowId(machineId);
	const navigate = useNavigate();
	return (path: string, name?: string) => {
		if (rowId !== undefined) {
			setMachine(machineId);
			setPlace({ kind: "folder", path, machineId: rowId, ...(name === undefined ? {} : { name }) });
		}
		close();
		void navigate({ to: "/" });
	};
}

/** The native folder dialog, opening at `from`; finishes on a pick. Absent outside the desktop app and on Windows. */
function usePick(close: () => void) {
	const finish = useFinish(close);
	const { machineId } = useAddMachine();
	const pickFolder = bridge?.pickFolder;
	// The native dialog shows this computer's folders: of no use for another machine.
	if (pickFolder === undefined || machineId !== undefined) return undefined;
	return (from: string) =>
		void pickFolder(from).then((picked) => {
			if (picked !== null) finish(picked);
		});
}

const RECENT = 3;

/** When a project was last worked in: its newest session's activity, else when it was first seen. */
const lastActive = (project: SidebarProject) =>
	Math.max(project.created, ...project.sessions.map((session) => session.updated));

/** The flow machine's projects with a folder on it, from the sidebar's synced list, last worked in first. */
function useRecentProjects() {
	const projects = useAtomValue(projectsAtom);
	const machineId = useAddMachine().machine?.id;
	if (machineId === undefined || !AsyncResult.isSuccess(projects)) return [];
	return projects.value
		.filter((project) => project.machine.id === machineId && project.onHost)
		.toSorted((a, b) => lastActive(b) - lastActive(a));
}

function Sources({ step, setQuery, push, pop, close }: Nav) {
	const pick = usePick(close);
	const finish = useFinish(close);
	const { machine, machineId } = useAddMachine();
	const github = useAtomValue(githubAtom(machineId ?? ""));
	const status = AsyncResult.isSuccess(github) ? github.value : undefined;
	const info = useAtomValue(infoAtom(machineId ?? ""));
	const home = AsyncResult.isSuccess(info) ? info.value.home : undefined;
	const recent = useRecentProjects();
	// A few at rest; searching reaches every one.
	const shown = step.query.trim() === "" ? recent.slice(0, RECENT) : recent;
	return (
		<>
			<Input
				value={step.query}
				onValueChange={setQuery}
				placeholder="Add a project from…"
				icon={<FolderPlusIcon />}
				pop={pop}
			/>
			<CommandList className={PALETTE_LIST}>
				<CommandEmpty>No Sources Match</CommandEmpty>
				{shown.length > 0 && (
					<CommandGroup heading="Recent">
						{shown.map((project) => (
							<Row
								key={project.id}
								value={`recent:${project.id}`}
								keywords={[project.path]}
								icon={<FolderIcon />}
								title={project.name}
								detail={tilde(project.path, home)}
								onSelect={() => finish(project.path, project.name)}
							/>
						))}
					</CommandGroup>
				)}
				<CommandGroup heading="Sources">
					{pick !== undefined && bridge !== undefined && (
						<Row
							value="source:finder"
							keywords={["finder", "folder", "open", "dialog", "files"]}
							icon={<FolderOpenIcon />}
							title={`Open ${fileManager}`}
							detail={`Choose a folder in ${fileManager}`}
							onSelect={() => pick(bridge.home)}
						/>
					)}
					<Row
						value="source:new"
						keywords={["new project", "create", "empty", "repository", "git init"]}
						icon={<FolderPlusIcon />}
						title="New Project"
						detail="Start a new Git repository from a name"
						onSelect={() => push({ kind: "create" })}
					/>
					<Row
						value="source:local"
						keywords={["local", "folder", "directory", "browse"]}
						icon={<FolderIcon />}
						title="Local Folder"
						detail="Browse a folder on disk"
						onSelect={() => push({ kind: "browse" }, BROWSE_START)}
					/>
					<Row
						value="source:url"
						keywords={["clone", "remote", "repository", "repo", "git", "url"]}
						icon={<LinkIcon />}
						title="Git URL"
						detail="Clone from a remote URL"
						onSelect={() => push({ kind: "remote", source: "url" })}
					/>
					<Row
						value="source:github"
						keywords={["clone", "remote", "repository", "repo", "git", "github"]}
						icon={<ProviderIcon id="github" name="GitHub" className="size-4" />}
						title="GitHub Repository"
						detail="Clone GitHub owner/repo"
						disabled={status?.ready === false}
						trailing={
							// Its slot is held from the start, so the badge fades in without moving the row.
							<span
								title={status?.hint}
								aria-hidden={status?.ready !== false}
								data-shown={status?.ready === false}
								className="ml-auto shrink-0 rounded-sm border border-edge px-1.5 py-0.5 text-2xs text-ink-muted opacity-0 transition-opacity duration-150 ease-out data-[shown=true]:opacity-100 motion-reduce:transition-none"
							>
								Setup Required
							</span>
						}
						onSelect={() => push({ kind: "remote", source: "github" })}
					/>
				</CommandGroup>
			</CommandList>
			{/* Always there, so the palette keeps its height while gh is asked: the machine, else gh's hint. */}
			<Footer
				note={
					status?.ready === false ? status.hint : machine === undefined ? undefined : `Adding to ${machine.name}`
				}
			/>
		</>
	);
}

/**
 * Moves the query to another folder once that folder's listing is in, so its rows replace the old
 * ones in one step; a later move or keystroke drops an earlier move still waiting.
 */
function useEnter(type: (query: string) => void) {
	const registry = useContext(RegistryContext);
	const { machineId } = useAddMachine();
	const latest = useRef(0);
	return {
		enter: (next: string) => {
			const move = ++latest.current;
			void runQuery(registry, listing(directoryOf(next), machineId))
				.catch(() => undefined)
				.then(() => {
					if (latest.current === move) type(next);
				});
		},
		type: (next: string) => {
			latest.current++;
			type(next);
		},
	};
}

/** A folder listing for a browse query, and what the query points at within it. */
function useFolders(query: string, pinned?: string) {
	const browsing = isBrowseQuery(query);
	const directory = directoryOf(query);
	const leaf = leafOf(query);
	const { machineId } = useAddMachine();
	const result = useAtomValue(listing(browsing ? directory : BROWSE_START, machineId));
	const listed = AsyncResult.isSuccess(result) ? result.value : undefined;
	// The last folder's rows stay until the next folder's arrive, so the list never blinks empty.
	const last = useLast(listed);
	const loading = browsing && result._tag === "Initial";
	const entries = listed?.entries ?? (loading ? (last?.entries ?? []) : []);
	// A pinned clone name stays as the leaf while every sibling folder shows.
	const { visible } = filterFolders(entries, pinned !== undefined && leaf === pinned ? "" : leaf);
	const exact = leaf === "" ? undefined : listed?.entries.find((entry) => entry.name === leaf);
	const up = leaf === "" ? parentOf(directory) : null;
	return {
		browsing,
		directory,
		leaf,
		visible: browsing ? visible : [],
		exact,
		up: browsing ? up : null,
		resolved: listed?.path,
		// Unknown until it is listed; a folder the server may not read still lists, empty.
		readable: listed?.readable ?? true,
		loading,
		failure: browsing ? failureOf(result) : undefined,
		reason: browsing ? reasonOf(result) : undefined,
	};
}

function Browse({ step, setQuery, pop, close }: Nav) {
	const query = step.query;
	const folders = useFolders(query);
	const finish = useFinish(close);
	const pick = usePick(close);
	const add = useAtomSet(addAtom, { mode: "promise" });
	const { machineId } = useAddMachine();
	const [picked, setPicked] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();

	// Missing: a folder the host says is not there, or a leaf no folder has. Under a folder the server
	// may not read, a leaf's folder may exist unseen, so it is added as typed.
	const missing = folders.leaf === "" ? folders.reason === "missing" : folders.readable && folders.exact === undefined;
	const isFile = folders.leaf === "" && folders.reason === "file";
	const target = folders.leaf === "" ? (folders.resolved ?? query) : (folders.exact?.path ?? query.trim());

	const change = (next: string) => {
		setPicked(false);
		setError(undefined);
		setQuery(next);
	};
	const { enter, type } = useEnter(change);
	const submit = () => {
		if (!folders.browsing || pending) return;
		setPending(true);
		add({ payload: { ...on(machineId), path: target } })
			.then((added) => finish(added.path))
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => setPending(false));
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Tab" && !event.nativeEvent.isComposing && folders.browsing) {
			event.preventDefault();
			const completion = complete(folders.visible, folders.leaf);
			if (completion !== null) enter(`${folders.directory}${completion.name}${completion.done ? "/" : ""}`);
			return;
		}
		if (event.key === "Enter" && !event.nativeEvent.isComposing && (!picked || event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<>
			<Input
				value={query}
				onValueChange={(next) => (next === "" ? pop() : type(pastedPath(query, next)))}
				placeholder="Enter path (e.g. ~/projects/my-app)"
				icon={<FolderIcon />}
				pop={pop}
				onKeyDown={onKeyDown}
				onPick={() => setPicked(true)}
			/>
			<CommandList className={listClass(picked)}>
				{folders.browsing && (folders.up !== null || folders.visible.length > 0) && (
					<CommandGroup heading="Directories">
						{folders.up !== null && (
							<Row
								value=".."
								icon={<ArrowBendLeftUpIcon />}
								title=".."
								onSelect={() => enter(folders.up ?? query)}
							/>
						)}
						{folders.visible.map((entry) => (
							<Row
								key={entry.path}
								value={`dir:${entry.name}`}
								icon={<FolderIcon />}
								title={entry.name}
								onSelect={() => enter(`${folders.directory}${entry.name}/`)}
							/>
						))}
					</CommandGroup>
				)}
			</CommandList>
			<Footer
				note={
					error ??
					(!folders.browsing
						? "Paths start with / or ~/."
						: folders.loading
							? "Loading folders…"
							: folders.leaf === "" && folders.failure !== undefined
								? folders.failure
								: !folders.readable
									? "This folder can’t be read here, so its folders aren’t shown."
									: missing
										? "Press Enter to create this folder and add it as a project."
										: undefined)
				}
				failed={error !== undefined || (folders.leaf === "" && folders.failure !== undefined)}
				start={
					pick !== undefined && (
						<Button variant="ghost" size="xs" onClick={() => pick(folders.resolved ?? bridge?.home ?? "")}>
							<FolderOpenIcon />
							Open in {fileManager}
						</Button>
					)
				}
				action={
					<Action disabled={!folders.browsing || pending || isFile} onClick={submit}>
						{pending ? "Adding…" : missing ? "Create & Add" : "Add"}
					</Action>
				}
			/>
		</>
	);
}

function Create({ step, setQuery, pop, close }: Nav) {
	const name = step.query;
	const { machineId } = useAddMachine();
	const info = useAtomValue(infoAtom(machineId ?? ""));
	const home = AsyncResult.isSuccess(info) ? info.value.home : undefined;
	const root = AsyncResult.isSuccess(info) ? tilde(info.value.projects, home) : undefined;
	const finish = useFinish(close);
	const create = useAtomSet(createAtom, { mode: "promise" });
	const [picked, setPicked] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	// A project made without its first commit still opens, once that is read.
	const [made, setMade] = useState<{ path: string; warning: string }>();
	const submitting = useRef(false);

	const submit = () => {
		if (made !== undefined) return finish(made.path);
		if (name.trim() === "" || submitting.current) return;
		submitting.current = true;
		setPending(true);
		setError(undefined);
		create({ payload: { ...on(machineId), name: name.trim() } })
			.then((created) =>
				created.commitError === undefined
					? finish(created.path)
					: setMade({
							path: created.path,
							warning: `Created ${name.trim()} without a first commit: ${created.commitError}`,
						}),
			)
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => {
				submitting.current = false;
				setPending(false);
			});
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" && !event.nativeEvent.isComposing && (!picked || event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<>
			<Input
				value={name}
				onValueChange={(next) => {
					setPicked(false);
					setError(undefined);
					setQuery(next);
				}}
				placeholder="Project name"
				icon={<FolderPlusIcon />}
				pop={pop}
				onKeyDown={onKeyDown}
				onPick={() => setPicked(true)}
				disabled={made !== undefined}
			/>
			<Summary
				title={name.trim() === "" ? "New Project" : name.trim()}
				detail={
					root === undefined
						? undefined
						: name.trim() === ""
							? `Goes in ${root}`
							: `Creates ${root}/${projectFolder(name)}`
				}
			/>
			<CommandList className={listClass(picked)}>
				<CommandGroup>
					<Row
						value="create:existing"
						icon={<FolderPlusIcon />}
						title="Add existing project"
						detail="Open a folder or clone a repository"
						onSelect={pop}
					/>
				</CommandGroup>
			</CommandList>
			<Footer
				note={made?.warning ?? error}
				failed={error !== undefined}
				action={
					<Action disabled={(name.trim() === "" && made === undefined) || pending} onClick={submit}>
						{made !== undefined ? "Open" : pending ? "Creating…" : "Create"}
					</Action>
				}
			/>
		</>
	);
}

function Remote({ step, setQuery, push, pop, source }: Nav & { source: "url" | "github" }) {
	const input = step.query;
	const lookup = useAtomSet(lookupAtom, { mode: "promise" });
	const { machineId } = useAddMachine();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const github = source === "github";

	const submit = () => {
		const trimmed = input.trim();
		if (trimmed === "" || pending) return;
		if (!github) {
			const name = cloneName(trimmed);
			const remote = cloneUrl(trimmed);
			return push(
				{ kind: "destination", remote, title: trimmed, detail: remote, name },
				cloneTarget(BROWSE_START, name),
			);
		}
		if (ownerOnly(trimmed)) return setError("Enter the full owner/repository name.");
		setPending(true);
		setError(undefined);
		lookup({ payload: { ...on(machineId), repository: trimmed } })
			.then((repo) => {
				const name = cloneName(repo.nameWithOwner);
				push(
					{ kind: "destination", remote: repo.url, title: repo.nameWithOwner, detail: repo.url, name },
					cloneTarget(BROWSE_START, name),
				);
			})
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => setPending(false));
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<>
			<Input
				value={input}
				onValueChange={(next) => {
					setError(undefined);
					setQuery(next);
				}}
				placeholder={github ? "Enter GitHub repository (owner/repo)" : "Enter Git clone URL"}
				icon={github ? <ProviderIcon id="github" name="GitHub" className="size-4" /> : <LinkIcon />}
				pop={pop}
				onKeyDown={onKeyDown}
			/>
			<CommandList className={PALETTE_LIST} />
			<Footer
				note={
					error ??
					(github
						? "Enter a repository path and press Enter to look it up."
						: "Enter a Git clone URL and press Enter to continue.")
				}
				failed={error !== undefined}
				action={
					<Action disabled={input.trim() === "" || pending} onClick={submit}>
						{github ? (pending ? "Looking up…" : "Lookup") : "Continue"}
					</Action>
				}
			/>
		</>
	);
}

function Destination({ step, setQuery, pop, close, target }: Nav & { target: Extract<View, { kind: "destination" }> }) {
	const query = step.query;
	const folders = useFolders(query, target.name);
	const finish = useFinish(close);
	const clone = useAtomSet(cloneAtom, { mode: "promise" });
	const { machineId } = useAddMachine();
	const watch = useWatchClones();
	const [picked, setPicked] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();

	const change = (next: string) => {
		setPicked(false);
		setError(undefined);
		setQuery(next);
	};
	const { enter, type } = useEnter(change);
	// Choosing a folder clones into it under the repository's name, unless it already is that folder.
	const into = (directory: string, name: string) =>
		name === target.name ? `${directory}${name}/` : cloneTarget(`${directory}${name}`, target.name);
	const path = folders.leaf === "" ? (folders.resolved ?? query) : query.trim();

	const submit = () => {
		if (!folders.browsing || pending) return;
		setPending(true);
		setError(undefined);
		watch(machineId);
		clone({ payload: { ...on(machineId), remote: target.remote, path } })
			.then((cloned) => finish(cloned.path))
			.catch((cause: unknown) => setError(messageOf(cause)))
			.finally(() => setPending(false));
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// The clone keeps its name, so Tab doesn't complete the leaf here.
		if (event.key === "Tab") return event.preventDefault();
		if (event.key === "Enter" && !event.nativeEvent.isComposing && (!picked || event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<>
			<Input
				value={query}
				onValueChange={(next) => (next === "" ? pop() : type(pastedPath(query, next)))}
				placeholder="Where to clone"
				icon={<GitBranchIcon />}
				pop={pop}
				onKeyDown={onKeyDown}
				onPick={() => setPicked(true)}
				disabled={pending}
			/>
			<Summary label="Repository" title={target.title} detail={target.detail} />
			<CommandList className={listClass(picked)}>
				{folders.browsing && (folders.up !== null || folders.visible.length > 0) && (
					<CommandGroup heading="Select where to clone">
						{folders.up !== null && (
							<Row
								value=".."
								icon={<ArrowBendLeftUpIcon />}
								title=".."
								onSelect={() => enter(cloneTarget(folders.up ?? query, target.name))}
							/>
						)}
						{folders.visible.map((entry) => (
							<Row
								key={entry.path}
								value={`dir:${entry.name}`}
								icon={<FolderIcon />}
								title={entry.name}
								onSelect={() => enter(into(folders.directory, entry.name))}
							/>
						))}
					</CommandGroup>
				)}
			</CommandList>
			<Footer
				note={
					error ??
					(pending
						? `Cloning ${target.title}…`
						: !folders.browsing
							? "Paths start with / or ~/."
							: "Choose a destination path and press Enter to clone.")
				}
				failed={error !== undefined}
				action={
					<Action disabled={!folders.browsing || pending} onClick={submit}>
						{pending ? "Cloning…" : folders.reason === "missing" ? "Create & Clone" : "Clone"}
					</Action>
				}
			/>
		</>
	);
}

// While Enter adds rather than picks, no row shows as highlighted.
const listClass = (picked: boolean) =>
	`${PALETTE_LIST} ${picked ? "" : "[&_[cmdk-item][data-selected=true]]:bg-transparent"}`;

function Input({
	value,
	onValueChange,
	placeholder,
	icon,
	pop,
	onKeyDown,
	onPick,
	disabled,
}: {
	value: string;
	onValueChange: (value: string) => void;
	placeholder: string;
	icon: ReactNode;
	pop: () => void;
	onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
	onPick?: () => void;
	disabled?: boolean;
}) {
	return (
		<CommandInput
			autoFocus
			value={value}
			onValueChange={onValueChange}
			placeholder={placeholder}
			disabled={disabled ?? false}
			start={
				<span className="flex shrink-0 items-center gap-1.5 text-ink-muted [&_svg]:size-4">
					<button
						type="button"
						aria-label="Back"
						title="Back"
						onClick={pop}
						className="-ml-1 grid size-6 place-items-center rounded-md hover:bg-selection-subtle hover:text-ink"
					>
						<ArrowLeftIcon />
					</button>
					{icon}
				</span>
			}
			onKeyDown={(event) => {
				if (event.key === "Backspace" && value === "") {
					event.preventDefault();
					return pop();
				}
				if (event.key === "ArrowUp" || event.key === "ArrowDown") onPick?.();
				onKeyDown?.(event);
			}}
		/>
	);
}

function Row({
	value,
	keywords,
	icon,
	title,
	detail,
	trailing,
	disabled,
	onSelect,
}: {
	value: string;
	keywords?: string[];
	icon: ReactNode;
	title: string;
	detail?: string;
	trailing?: ReactNode;
	disabled?: boolean;
	onSelect: () => void;
}) {
	return (
		<CommandItem
			value={value}
			keywords={keywords === undefined ? [title] : [title, ...keywords]}
			disabled={disabled ?? false}
			onSelect={onSelect}
		>
			{icon}
			<span className="flex min-w-0 flex-col">
				<span className="truncate">{title}</span>
				{detail !== undefined && <span className="truncate text-xs text-ink-muted">{detail}</span>}
			</span>
			{trailing}
		</CommandItem>
	);
}

function Summary({ label, title, detail }: { label?: string; title: string; detail?: string | undefined }) {
	return (
		<div className="flex min-w-0 flex-col border-b px-4 py-2.5">
			{label !== undefined && <span className="text-2xs font-medium text-ink-muted">{label}</span>}
			<span className="truncate text-sm text-ink">{title}</span>
			{detail !== undefined && <span className="truncate text-xs text-ink-muted">{detail}</span>}
		</div>
	);
}

function Footer({
	note,
	failed = false,
	start,
	action,
}: {
	note?: string | undefined;
	failed?: boolean;
	start?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex min-h-10 items-center gap-2 border-t px-2 py-1.5">
			{start}
			<span
				data-shown={note !== undefined}
				className={`min-w-0 flex-1 truncate px-1 text-xs transition-opacity duration-150 ease-out data-[shown=false]:opacity-0 motion-reduce:transition-none ${failed ? "text-destructive" : "text-ink-muted"}`}
			>
				{note}
			</span>
			{action}
		</div>
	);
}

function Action({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<Button size="xs" disabled={disabled} onClick={onClick}>
			{children}
			<ArrowBendDownLeftIcon aria-hidden />
		</Button>
	);
}
