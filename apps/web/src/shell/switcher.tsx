import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AppWindow, X } from "lucide-react";
import { Fragment, useRef } from "react";

import { isMac } from "@codeworksh/widget/view";
import { registry } from "../widgets";
import { chromeAtom, chromeOf, focusedAtom, tabOwnerAtom } from "../wm/chrome";
import { deskAtom, deskKey } from "../wm/instances";
import { deleteWorkspace, type Workspace, workspaceRoute, workspacesKey, workspaceTag } from "../wm/workspaces";

interface SwitcherProps {
	readonly workspaces: readonly Workspace[];
	/** The workspace on screen; none while settings is open. */
	readonly active: Workspace | undefined;
}

/**
 * Workspace tabs, like a browser's: a title that the workspace's focused frame decides (its
 * `setTab`), shortened at its end when the bar runs out of room. The active workspace is the URL, so a tab is a link.
 */
export function Switcher({ workspaces, active }: SwitcherProps) {
	const { instances, order } = useAtomValue(deskAtom);
	const chrome = useAtomValue(chromeAtom);
	const focusedOn = useAtomValue(focusedAtom);
	const owners = useAtomValue(tabOwnerAtom);
	const navigate = useNavigate();
	const remove = useAtomSet(deleteWorkspace, { mode: "promise" });
	// No confirm, like a browser tab; closing the one on screen moves to a neighbour first.
	const close = async (workspace: Workspace, index: number) => {
		if (workspace.id === active?.id) {
			const next = workspaces[index + 1] ?? workspaces[index - 1];
			await navigate(next === undefined ? { to: "/" } : workspaceRoute(next));
		}
		// The server drops the workspace's widgets, so the desk reloads with the list.
		await remove({ payload: { id: workspace.id }, reactivityKeys: [...workspacesKey, ...deskKey] }).catch(
			() => undefined,
		);
	};
	// What each tab showed last, kept while a frame that will set the tab is still loading.
	const shown = useRef(new Map<string, string>());
	const showing = (workspace: Workspace) => {
		const tab = tabOf(workspace);
		shown.current.set(workspace.id, tab);
		return tab;
	};
	const tabOf = (workspace: Workspace): string => {
		const tag = workspaceTag(workspace);
		const onWorkspace = (instance: (typeof instances)[number] | undefined) =>
			instance !== undefined && (instance.tags & tag) !== 0;
		// The frame that claimed the tab keeps it while it is still on this workspace.
		const owner = instances.find((instance) => instance.id === owners.get(workspace.id));
		const claimed = owner !== undefined && onWorkspace(owner) ? chrome.get(owner.id)?.tab : undefined;
		if (claimed !== undefined) return claimed;
		// Its own last focus once it has been on screen, else its main frame (first in tile order), so
		// focusing a frame shared with another workspace never relabels a tab not yet visited.
		const remembered = instances.find((instance) => instance.id === focusedOn.get(workspace.id));
		const focused = onWorkspace(remembered)
			? remembered
			: order.tileOrder.map((id) => instances.find((instance) => instance.id === id)).find(onWorkspace);
		if (focused === undefined) return workspace.name;
		const frame = chrome.get(focused.id);
		// The focused frame decides what the tab says; without a say, the workspace's name and its title.
		if (frame?.tab !== undefined) return frame.tab;
		const kept = shown.current.get(workspace.id);
		if (registry.get(focused.kind)?.ownsTab === true && kept !== undefined) return kept;
		const title = chromeOf(focused, frame).title;
		// A frame named like its workspace adds nothing to the tab.
		return title.toLowerCase() === workspace.name.toLowerCase() ? workspace.name : `${workspace.name} / ${title}`;
	};

	return (
		<nav
			aria-label="Workspaces"
			className="ml-3 flex min-w-0 items-center rounded-xl bg-ink/5 p-1 [-webkit-app-region:no-drag]"
		>
			{workspaces.map((workspace, index) => {
				const current = workspace.id === active?.id;
				const tab = showing(workspace);
				// Keep separator space reserved when selection hides its hairline.
				const divider = index > 0 && !current && workspaces[index - 1]?.id !== active?.id;
				return (
					<Fragment key={workspace.id}>
						{index > 0 && (
							<span aria-hidden className={`mx-0.5 h-4 w-px shrink-0 bg-ink/12 ${divider ? "" : "invisible"}`} />
						)}
						<div className="group relative flex h-8 w-56 min-w-16 shrink basis-56">
							<Link
								{...workspaceRoute(workspace)}
								aria-current={current ? "page" : undefined}
								title={`${tab}\n${shortcutLabel(index + 1)}`}
								className={`flex size-full min-w-0 items-center gap-2 rounded-lg pr-3 pl-1.5 group-hover:pr-8 outline-none focus-visible:ring-2 focus-visible:ring-ring ${
									current
										? "border border-edge bg-linear-to-b from-frame-top to-frame text-ink shadow-frame"
										: "border border-transparent text-ink-muted hover:bg-ink/5 hover:text-ink"
								}`}
							>
								<span
									className={`grid size-6 shrink-0 place-items-center rounded-md border ${current ? "border-edge bg-frame-top text-ink shadow-xs" : "border-transparent text-ink-muted"}`}
								>
									<AppWindow className="size-3.5" strokeWidth={1.75} aria-hidden />
								</span>
								<span className="truncate text-xs font-medium">{tab}</span>
							</Link>
							<button
								type="button"
								aria-label={`Close ${workspace.name}`}
								title={`Close ${workspace.name}`}
								onClick={() => void close(workspace, index)}
								className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md text-ink-muted opacity-0 group-hover:opacity-100 hover:bg-ink/8 hover:text-ink focus-visible:opacity-100"
							>
								<X className="size-3" strokeWidth={2} aria-hidden />
							</button>
						</div>
					</Fragment>
				);
			})}
		</nav>
	);
}

export const shortcutLabel = (position: number) => `${isMac ? "⌘" : "Ctrl+"}${position}`;

const modifier = (event: KeyboardEvent) => !event.altKey && !event.shiftKey && (isMac ? event.metaKey : event.ctrlKey);

/** Cmd+N on macOS, Ctrl+N elsewhere, like switching browser tabs: the Nth workspace in order. */
export function workspaceShortcut(event: KeyboardEvent, workspaces: readonly Workspace[]): Workspace | undefined {
	if (!modifier(event) || !/^[1-9]$/.test(event.key)) return undefined;
	return workspaces[Number(event.key) - 1];
}

/** Cmd+, on macOS, Ctrl+, elsewhere: the platform's settings shortcut. */
export const settingsShortcut = (event: KeyboardEvent) => modifier(event) && event.key === ",";

/** Cmd+K on macOS, Ctrl+K elsewhere: the command palette. */
export const paletteShortcut = (event: KeyboardEvent) => modifier(event) && event.key.toLowerCase() === "k";
