import { useAtomValue } from "@effect/atom-react";
import type { ListedThread, SidebarProject } from "@codeworksh/contract";
import { openMode, useShell } from "@codeworksh/widget/view";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { AsyncResult } from "effect/reactivity";
import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef } from "react";

import { useNowMinute } from "../hooks/now";
import { threadAddress } from "../widgets/session/address";
import { projectsAtom } from "../widgets/session/projects";
import type { ThreadRef } from "../widgets/session/schema";
import { threadsAtom } from "../widgets/threads/data";
import { ago } from "../widgets/time";

/** What a tree path stands for: a project (it only folds) or a thread that opens. */
type Entry =
	| { readonly kind: "project"; readonly path: string; readonly sessions: number }
	| {
			readonly kind: "thread";
			readonly ref: ThreadRef;
			readonly fork: boolean;
			readonly updated: number;
			readonly running: boolean;
	  };

/** The tree's colors and type from the app's theme tokens, so it follows light and dark. */
const TREE_STYLE = {
	height: "100%",
	// The page's own surface: sticky project bands are drawn over the rows on it and need it opaque.
	"--trees-bg-override": "var(--color-frame)",
	"--trees-fg-override": "var(--color-ink-secondary)",
	"--trees-fg-muted-override": "var(--color-ink-muted)",
	"--trees-bg-muted-override": "var(--color-selection-subtle)",
	"--trees-selected-bg-override": "var(--color-selection-current)",
	"--trees-selected-fg-override": "var(--color-ink)",
	"--trees-accent-override": "var(--color-brand)",
	"--trees-focus-ring-color-override": "var(--color-ring)",
	"--trees-font-family-override": "inherit",
	"--trees-font-size-override": "13px",
	// Bands run edge to edge, as All Threads' sections do; rows keep a small inset.
	"--trees-padding-inline-override": "0px",
	"--trees-item-margin-x-override": "6px",
} as CSSProperties;

/** A project's row as All Threads draws a section: a full-width band, its count quiet on the right. */
const SECTION_CSS = `
[data-type="item"][aria-level="1"] {
	margin-inline: 0;
	border-radius: 0;
	background: color-mix(in oklab, var(--color-frame), var(--color-ink) 4%);
	box-shadow: inset 0 -1px color-mix(in oklab, var(--color-edge) 50%, transparent);
	color: var(--color-ink);
}
[data-type="item"][aria-level="1"]:hover {
	background: color-mix(in oklab, var(--color-frame), var(--color-ink) 7%);
}
[data-type="item"][aria-level="1"] [data-item-section="decoration"] {
	color: var(--color-ink-muted);
	font-weight: 400;
}
`;

/** A thread is a conversation, not a file: a chat bubble in the file slot. */
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="codework-thread" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol></svg>`;
const ICONS = { set: "none", spriteSheet: SPRITE, remap: { "file-tree-icon-file": "codework-thread" } } as const;

/**
 * Each project with its sessions' main threads, and under a main thread its forks, as tree paths
 * in the sidebar's order. A path segment is the name shown, so a slash in a title is swapped for
 * a look-alike and a name its siblings already use gets an invisible suffix.
 */
function layout(projects: ReadonlyArray<SidebarProject>, threads: ReadonlyArray<ListedThread>) {
	// Forks by the thread they were cut from; one whose source is not listed (a subagent) hangs off
	// its session's main thread.
	const listed = new Set(threads.map((thread) => thread.id));
	const mainOf = new Map(
		threads.flatMap((thread) => (thread.originKind === "main" ? [[thread.sessionId, thread.id]] : [])),
	);
	const forks = new Map<string, Array<ListedThread>>();
	for (const thread of threads) {
		if (thread.originKind !== "fork") continue;
		const source =
			thread.originThreadId !== null && listed.has(thread.originThreadId)
				? thread.originThreadId
				: (mainOf.get(thread.sessionId) ?? thread.sessionId);
		forks.set(source, [...(forks.get(source) ?? []), thread]);
	}
	const forksOf = (threadId: string) => (forks.get(threadId) ?? []).toSorted((a, b) => b.updatedAt - a.updatedAt);
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
		entries.set(projectPath, { kind: "project", path: project.path, sessions: project.sessions.length });
		/** A fork and, under it, the forks cut from it, at any depth. */
		const addFork = (parentPath: string, fork: ListedThread, seen: ReadonlySet<string>) => {
			const below = seen.has(fork.id) ? [] : forksOf(fork.id);
			const name = segment(parentPath, fork.title);
			const forkPath = below.length === 0 ? `${parentPath}${name}` : `${parentPath}${name}/`;
			paths.push(forkPath);
			entries.set(forkPath, {
				kind: "thread",
				ref: { sessionId: fork.sessionId, threadId: fork.id },
				fork: true,
				updated: fork.updatedAt,
				running: fork.runState !== "idle",
			});
			const next = new Set([...seen, fork.id]);
			for (const child of below) addFork(forkPath, child, next);
		};
		for (const session of project.sessions) {
			const own = forksOf(session.threadId);
			const name = segment(projectPath, session.title);
			const sessionPath = own.length === 0 ? `${projectPath}${name}` : `${projectPath}${name}/`;
			paths.push(sessionPath);
			entries.set(sessionPath, {
				kind: "thread",
				ref: { sessionId: session.id },
				fork: false,
				updated: session.updated,
				running: session.runState !== "idle",
			});
			for (const fork of own) addFork(sessionPath, fork, new Set([session.threadId]));
		}
	}
	return { paths, entries };
}

const EMPTY: ReadonlyArray<ListedThread> = [];

/**
 * A folder as a band shows it: the user's home folder as `~`, and past three folders only the last
 * two, so the project's name keeps the room. The full path is the band's title.
 */
const homeShort = (path: string) => {
	const short = path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
	const [root = "", ...rest] = short.split("/");
	return rest.length > 3 ? `${root}/…/${rest.slice(-2).join("/")}` : short;
};

/** Projects, their sessions and the sessions' forks as a tree; a main thread or a fork opens its session. */
export function Projects() {
	const shell = useShell();
	const projects = useAtomValue(projectsAtom);
	const listed = useAtomValue(threadsAtom("status"));
	const threads = AsyncResult.isSuccess(listed) ? listed.value.lists.flatMap((list) => list.threads) : EMPTY;
	const tree = AsyncResult.isSuccess(projects) ? layout(projects.value, threads) : undefined;
	// The tree's model is made once; its row decorations read the latest entries from here.
	const entries = useRef(new Map<string, Entry>());
	const rank = useRef(new Map<string, number>());
	const minute = useNowMinute();
	const now = useRef(minute);
	useLayoutEffect(() => {
		if (tree === undefined) return;
		entries.current = tree.entries;
		rank.current = new Map(tree.paths.map((path, index) => [path, index]));
	});
	const { model } = useFileTree({
		paths: [],
		// The sidebar's order (newest first), not the tree's alphabetical one.
		sort: (a, b) => (rank.current.get(a.path) ?? 0) - (rank.current.get(b.path) ?? 0),
		itemHeight: 32,
		// A project's row stays at the top while its sessions scroll under it, as All Threads' sections do.
		stickyFolders: true,
		icons: ICONS,
		unsafeCSS: SECTION_CSS,
		renderRowDecoration: ({ row }) => {
			const entry = entries.current.get(row.path);
			if (entry === undefined) return null;
			if (entry.kind === "project") {
				const path = homeShort(entry.path);
				const count = String(entry.sessions);
				return {
					text: `${path} · ${count}`,
					title: entry.path,
					parts: [
						{ text: path, color: "color-mix(in oklab, var(--color-ink-muted) 75%, transparent)" },
						{ text: `\u00a0· ${count}` },
					],
				};
			}
			const when = entry.running ? "Working" : ago(entry.updated, now.current);
			// A fork often carries its source's title; the mark tells it apart.
			if (!entry.fork) return { text: when };
			return {
				text: `fork · ${when}`,
				parts: [
					{ text: "fork", color: "color-mix(in oklab, var(--color-ink-muted) 75%, transparent)" },
					{ text: `\u00a0· ${when}` },
				],
			};
		},
	});

	// The tree draws decorations itself, outside React; a root render redraws them for each minute tick.
	useEffect(() => {
		now.current = minute;
		model.setComposition(model.getComposition());
	}, [model, minute]);

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
	const count = AsyncResult.isSuccess(projects) ? projects.value.length : 0;
	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 shrink-0 items-center border-b border-edge px-3">
				<span className="text-xs text-ink-muted tabular-nums">
					{count} {count === 1 ? "project" : "projects"}
				</span>
			</div>
			<FileTree
				model={model}
				style={TREE_STYLE}
				className="min-h-0 flex-1 pb-2"
				onClick={(event) => open(pathOf(event), openMode(event))}
				onAuxClick={(event) => event.button === 1 && open(pathOf(event), "new")}
				onKeyDown={(event: KeyboardEvent) => {
					if (event.key === "Enter")
						open(model.getFocusedPath(), event.metaKey || event.ctrlKey ? "new" : "replace");
				}}
			/>
		</div>
	);
}
