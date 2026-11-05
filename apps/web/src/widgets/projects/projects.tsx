import { useAtomValue } from "@effect/atom-react";
import type { ListedThread, SidebarProject } from "@codeworksh/contract";
import { openMode, useShell } from "@codeworksh/widget/view";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { AsyncResult } from "effect/reactivity";
import {
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";

import { threadAddress } from "../session/address";
import { projectsAtom } from "../session/projects";
import type { ThreadRef } from "../session/schema";
import { threadsAtom } from "../threads/data";
import { ago } from "../time";

/** What a tree path stands for: a project (it only folds) or a thread that opens. */
type Entry =
	| { readonly kind: "project"; readonly path: string }
	| { readonly kind: "thread"; readonly ref: ThreadRef; readonly updated: number; readonly running: boolean };

/** The tree's colors and type from the app's theme tokens, so it follows light and dark. */
const TREE_STYLE = {
	height: "100%",
	"--trees-bg-override": "transparent",
	"--trees-fg-override": "var(--color-ink-secondary)",
	"--trees-fg-muted-override": "var(--color-ink-muted)",
	"--trees-bg-muted-override": "var(--color-selection-subtle)",
	"--trees-selected-bg-override": "var(--color-selection-current)",
	"--trees-selected-fg-override": "var(--color-ink)",
	"--trees-accent-override": "var(--color-brand)",
	"--trees-focus-ring-color-override": "var(--color-ring)",
	"--trees-font-family-override": "inherit",
	"--trees-font-size-override": "12px",
} as CSSProperties;

/** A thread is a conversation, not a file: a chat bubble in the file slot. */
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="codework-thread" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol></svg>`;
const ICONS = { set: "none", spriteSheet: SPRITE, remap: { "file-tree-icon-file": "codework-thread" } } as const;

/**
 * Each project with its sessions' main threads, and under a main thread its forks, as tree paths
 * in the sidebar's order. A path segment is the name shown, so a slash in a title is swapped for
 * a look-alike and a name its siblings already use gets an invisible suffix.
 */
function layout(projects: ReadonlyArray<SidebarProject>, threads: ReadonlyArray<ListedThread>) {
	const forks = new Map<string, Array<ListedThread>>();
	for (const thread of threads)
		if (thread.originKind === "fork") forks.set(thread.sessionId, [...(forks.get(thread.sessionId) ?? []), thread]);
	const entries = new Map<string, Entry>();
	const paths: Array<string> = [];
	const taken = new Map<string, Set<string>>();
	const segment = (parent: string, name: string) => {
		const used = taken.get(parent) ?? new Set<string>();
		taken.set(parent, used);
		let next = name.replaceAll("/", "∕").trim() || "Untitled";
		while (used.has(next)) next += "​";
		used.add(next);
		return next;
	};
	const machines = new Set(projects.map((project) => project.machine.id)).size;
	for (const project of projects) {
		const projectPath = `${segment("", machines > 1 ? `${project.name} · ${project.machine.name}` : project.name)}/`;
		paths.push(projectPath);
		entries.set(projectPath, { kind: "project", path: project.path });
		for (const session of project.sessions) {
			const own = (forks.get(session.id) ?? []).toSorted((a, b) => b.updatedAt - a.updatedAt);
			const name = segment(projectPath, session.title);
			const sessionPath = own.length === 0 ? `${projectPath}${name}` : `${projectPath}${name}/`;
			paths.push(sessionPath);
			entries.set(sessionPath, {
				kind: "thread",
				ref: { sessionId: session.id },
				updated: session.updated,
				running: session.runState !== "idle",
			});
			for (const fork of own) {
				const forkPath = `${sessionPath}${segment(sessionPath, fork.title)}`;
				paths.push(forkPath);
				entries.set(forkPath, {
					kind: "thread",
					ref: { sessionId: fork.sessionId, threadId: fork.id },
					updated: fork.updatedAt,
					running: fork.runState !== "idle",
				});
			}
		}
	}
	return { paths, entries };
}

const EMPTY: ReadonlyArray<ListedThread> = [];

/** Projects, their sessions and the sessions' forks as a tree; a main thread or a fork opens its session. */
export function Projects() {
	const shell = useShell();
	const projects = useAtomValue(projectsAtom);
	const listed = useAtomValue(threadsAtom("status"));
	const threads = useMemo(
		() => (AsyncResult.isSuccess(listed) ? listed.value.lists.flatMap((list) => list.threads) : EMPTY),
		[listed],
	);
	const tree = useMemo(
		() => (AsyncResult.isSuccess(projects) ? layout(projects.value, threads) : undefined),
		[projects, threads],
	);
	// The tree's model is made once; its row decorations read the latest entries from here.
	const entries = useRef(new Map<string, Entry>());
	const rank = useRef(new Map<string, number>());
	useLayoutEffect(() => {
		if (tree === undefined) return;
		entries.current = tree.entries;
		rank.current = new Map(tree.paths.map((path, index) => [path, index]));
	});
	const { model } = useFileTree({
		paths: [],
		// The sidebar's order (newest first), not the tree's alphabetical one.
		sort: (a, b) => (rank.current.get(a.path) ?? 0) - (rank.current.get(b.path) ?? 0),
		density: "compact",
		icons: ICONS,
		renderRowDecoration: ({ row }) => {
			const entry = entries.current.get(row.path);
			if (entry?.kind !== "thread") return null;
			return entry.running ? { text: "Working" } : { text: ago(entry.updated) };
		},
	});

	// Each read replaces the paths, keeping open what was open; projects start open, sessions closed.
	const seen = useRef(new Set<string>());
	useEffect(() => {
		if (tree === undefined) return;
		const expanded = tree.paths.filter((path) => {
			if (!path.endsWith("/")) return false;
			const item = model.getItem(path);
			if (item !== null && "isExpanded" in item && seen.current.has(path)) return item.isExpanded();
			return tree.entries.get(path)?.kind === "project";
		});
		seen.current = new Set(tree.paths);
		model.resetPaths(tree.paths, { initialExpandedPaths: expanded });
	}, [model, tree]);

	const open = (path: string | null, mode: "new" | "replace") => {
		const entry = path === null ? undefined : entries.current.get(path);
		if (entry?.kind === "thread") shell.open(threadAddress(entry.ref), { mode });
	};
	// The clicked row's path, from inside the tree's shadow root.
	const pathOf = (event: MouseEvent) => {
		for (const target of event.nativeEvent.composedPath())
			if (target instanceof HTMLElement && target.dataset.itemPath !== undefined) return target.dataset.itemPath;
		return null;
	};

	if (AsyncResult.isFailure(projects)) return <p className="p-3 text-ink-muted">Could not load projects.</p>;
	return (
		<FileTree
			model={model}
			style={TREE_STYLE}
			className="px-1 pb-2"
			onClick={(event) => open(pathOf(event), openMode(event))}
			onAuxClick={(event) => event.button === 1 && open(pathOf(event), "new")}
			onKeyDown={(event: KeyboardEvent) => {
				if (event.key === "Enter") open(model.getFocusedPath(), event.metaKey || event.ctrlKey ? "new" : "replace");
			}}
		/>
	);
}
