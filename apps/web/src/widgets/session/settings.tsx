import type { SidebarProject } from "@codeworksh/contract";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { ArrowLeft, Folder } from "@/components/vuesax";
import { Server } from "../../kernel/rpc";
import { failed } from "../threads/common";
import { projectsAtom } from "./projects";

const renameProject = Server.mutation("projects.rename");

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
				<div className="mx-auto flex w-full max-w-conversation flex-col gap-6 px-5 py-6 text-ui sm:px-8">
					{project !== undefined && <Banner project={project} />}
				</div>
			</div>
		</div>
	);
}

/** The project as a tile, its name as the page's title and where it lives. The name is a field: type, then Enter or leave it. */
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
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
					className="-mx-1.5 h-8 w-full min-w-0 truncate rounded-md bg-transparent px-1.5 text-[22px]/8 font-semibold tracking-tight outline-none transition-colors duration-150 ease-out hover:bg-ink/4 focus:bg-ink/4"
				/>
				<div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
					{/* From its end: the last parts tell projects apart, not the home directory. */}
					<span title={project.path} className="min-w-0 truncate [direction:rtl]">
						<bdi>{project.path}</bdi>
					</span>
					<span aria-hidden>·</span>
					<span className="shrink-0">{project.machine.name}</span>
				</div>
			</div>
		</header>
	);
}
