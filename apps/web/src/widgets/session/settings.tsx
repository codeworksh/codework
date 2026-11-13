import type { ProjectSpace, SidebarProject } from "@codeworksh/contract";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ArrowLeft, Check, Copy, Folder } from "@/components/vuesax";
import { Server } from "../../kernel/rpc";
import { failed } from "../threads/common";
import { Files, General, Mcp, Row, Section, Tag, useTilde } from "./config";
import { projectsAtom, spacesAtom } from "./projects";
import { Skills } from "./skills";

const renameProject = Server.mutation("projects.rename");
const remoteOf = (projectId: string) => Server.query("projects.remote", { projectId });

/** A session's project settings in place of its thread; Esc or the back row returns to the thread. */
export function ProjectSettings({ sessionId, onBack }: { readonly sessionId: string; readonly onBack: () => void }) {
	const result = useAtomValue(projectsAtom);
	const project = AsyncResult.isSuccess(result)
		? result.value.find((candidate) => candidate.sessions.some(({ id }) => id === sessionId))
		: undefined;
	const scroller = useRef<HTMLDivElement>(null);
	// Takes focus as it opens, so Esc returns from this frame only.
	useEffect(() => scroller.current?.focus({ preventScroll: true }), []);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-8 shrink-0 items-center border-b border-edge/60 px-2">
				<button
					type="button"
					onClick={onBack}
					className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-ink-muted outline-none transition-[background-color,color] duration-150 ease-out hover:bg-ink/6 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ArrowLeft className="size-3.5" aria-hidden />
					Back to Thread
				</button>
			</div>
			<div
				ref={scroller}
				tabIndex={-1}
				onKeyDown={(event) => {
					if (event.key !== "Escape" || event.defaultPrevented) return;
					event.preventDefault();
					onBack();
				}}
				className="min-h-0 flex-1 overflow-y-auto outline-none"
			>
				<div className="mx-auto flex w-full max-w-conversation flex-col gap-10 px-5 py-8 text-ui sm:px-8">
					{project !== undefined && <Page project={project} />}
				</div>
			</div>
		</div>
	);
}

interface View {
	readonly project: SidebarProject;
	readonly main: ProjectSpace | undefined;
	/** Null when the project has no remote, or it could not be read. */
	readonly url: string | null;
}

/**
 * The page for `project`, drawn once its directories and remote are both in. Until then the page last
 * drawn stays, whole: switching threads never shows one project's banner over a section still loading.
 */
function Page({ project }: { readonly project: SidebarProject }) {
	const spaces = useAtomValue(spacesAtom(`${project.machine.id}/${project.id}`));
	const remote = useAtomValue(remoteOf(project.id));
	const settled = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
		AsyncResult.isSuccess(result) || AsyncResult.isFailure(result);
	// A repository's main worktree, or the folder of a project that is not one.
	const main = AsyncResult.isSuccess(spaces)
		? spaces.value.find((space) => space.kind === "primary" || space.kind === "plain")
		: undefined;
	const url = AsyncResult.isSuccess(remote) ? remote.value.url : null;
	const ready = settled(spaces) && settled(remote);
	const [view, setView] = useState<View>();
	if (ready && (view?.project !== project || view.main !== main || view.url !== url)) setView({ project, main, url });
	if (view === undefined) return null;
	return (
		<>
			{/* Keyed, so a name typed for one project never carries into the next. */}
			<Banner key={view.project.id} project={view.project} />
			{view.main !== undefined && (
				<>
					<Repository main={view.main} url={view.url} />
					{/* Settings and MCP files are read on this computer; a project only in a sandbox has none. */}
					{view.main.env === null ? (
						<General projectId={view.project.id} hostDir={view.main.location} />
					) : (
						<NoFolder title="General" />
					)}
					{view.main.env === null ? <Mcp projectId={view.project.id} /> : <NoFolder title="MCP Connectors" />}
					<Skills machineId={view.project.machine.id} projectId={view.project.id} />
					{view.main.env === null ? (
						<Files projectId={view.project.id} hostDir={view.main.location} />
					) : (
						<NoFolder title="Advanced" />
					)}
				</>
			)}
		</>
	);
}

/** A section whose files live on this computer, for a project that has no folder here. */
function NoFolder({ title }: { readonly title: string }) {
	return (
		<Section title={title}>
			<Row
				title={<span className="text-ink-muted">Not Available</span>}
				description="Requires a host directory linked to this project"
			/>
		</Section>
	);
}

/** The project as a tile and its name as the page's title. The name is a field: type, then Enter or leave it. */
function Banner({ project }: { readonly project: SidebarProject }) {
	const rename = useAtomSet(renameProject, { mode: "promise" });
	// What is typed, until it is saved or put back.
	const [draft, setDraft] = useState<string>();
	// The saved name, shown until the rename syncs back to the list.
	const [pending, setPending] = useState<string>();
	if (pending !== undefined && project.name === pending) setPending(undefined);
	const name = pending ?? project.name;
	const commit = (value: string) => {
		const next = value.trim();
		setDraft(undefined);
		if (next === "" || next === name) return;
		setPending(next);
		void rename({ payload: { projectId: project.id, name: next } }).catch((error: unknown) => {
			setPending(undefined);
			failed(error);
		});
	};
	return (
		<header className="flex items-center gap-3">
			<span className="grid size-10 shrink-0 place-items-center rounded-lg border border-edge/60 bg-ink/4 text-ink-muted">
				<Folder size={18} aria-hidden />
			</span>
			<div className="flex min-w-0 flex-1">
				<input
					aria-label="Project name"
					value={draft ?? name}
					spellCheck={false}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={(event) => commit(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") {
							// Puts the saved name back; the settings stay open.
							event.preventDefault();
							setDraft(undefined);
							event.currentTarget.value = name;
							event.currentTarget.blur();
						}
					}}
					className="-mx-1.5 h-8 w-full min-w-0 truncate rounded-md bg-transparent px-1.5 text-[22px]/8 font-medium tracking-[-0.01em] outline-none transition-colors duration-150 ease-out hover:bg-ink/4 focus:bg-ink/4"
				/>
			</div>
		</header>
	);
}

/** The project's repository: the URL it was cloned from, then the folder on this host. */
function Repository({ main, url }: { readonly main: ProjectSpace; readonly url: string | null }) {
	const shorten = useTilde();
	return (
		<Section title="Repository">
			<Row title="Remote URL">
				{url === null ? (
					<span className="text-xs text-ink-muted">None</span>
				) : (
					// Text to read and copy, not a field: nothing here suggests it can be changed.
					<div className="flex max-w-[60%] min-w-0 items-center gap-1">
						<span title={url} className="min-w-0 truncate font-mono text-xs text-ink-muted select-all">
							{url}
						</span>
						<CopyButton text={url} />
					</div>
				)}
			</Row>
			<Row
				title={
					<>
						{main.env === null ? "Host Directory" : "Sandbox Directory"}
						{main.kind === "primary" && <Tag>main</Tag>}
					</>
				}
				path
				description={<bdi title={main.location}>{shorten(main.location)}</bdi>}
			/>
		</Section>
	);
}

/** Copies `text`, then shows a check for a moment so the copy is seen to have happened. */
function CopyButton({ text }: { readonly text: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			aria-label={copied ? "Copied" : "Copy remote URL"}
			title={copied ? "Copied" : "Copy"}
			onClick={() => {
				void navigator.clipboard.writeText(text).then(
					() => setCopied(true),
					() => toast.error("Not Copied"),
				);
			}}
			className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-ink/6 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96]"
		>
			{copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
		</button>
	);
}
