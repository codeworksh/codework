import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { Fragment, useRef } from "react";

import { isMac } from "../kernel/platform";
import type { Tab } from "../sdk";
import { registry } from "../widgets";
import { chromeAtom, chromeOf, focusedAtom, tabOwnerAtom } from "../wm/chrome";
import { deskAtom } from "../wm/instances";
import { type Workspace, workspaceRoute, workspaceTag } from "../wm/workspaces";
import { iconOf } from "./icons";

interface SwitcherProps {
	readonly workspaces: readonly Workspace[];
	/** The workspace on screen; none while settings is open. */
	readonly active: Workspace | undefined;
}

/**
 * Workspace tabs, like a browser's: a title and subtitle that the workspace's focused frame decides
 * (its `setTab`), and they shrink together when the bar runs out of room. The active workspace is the URL, so a tab is a link.
 */
export function Switcher({ workspaces, active }: SwitcherProps) {
	const { instances, order } = useAtomValue(deskAtom);
	const chrome = useAtomValue(chromeAtom);
	const focusedOn = useAtomValue(focusedAtom);
	const owners = useAtomValue(tabOwnerAtom);
	// What each tab showed last, kept while a frame that will set the tab is still loading.
	const shown = useRef(new Map<string, Tab>());
	const showing = (workspace: Workspace) => {
		const tab = tabOf(workspace);
		shown.current.set(workspace.id, tab);
		return tab;
	};
	const tabOf = (workspace: Workspace): Tab => {
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
		if (focused === undefined) return { title: workspace.name };
		const frame = chrome.get(focused.id);
		// The focused frame decides what the tab says; without a say, the workspace's name over its title.
		if (frame?.tab !== undefined) return frame.tab;
		const kept = shown.current.get(workspace.id);
		if (registry.get(focused.kind)?.ownsTab === true && kept !== undefined) return kept;
		const title = chromeOf(focused, frame).title;
		// A frame named like its workspace adds nothing to the tab.
		return title.toLowerCase() === workspace.name.toLowerCase()
			? { title: workspace.name }
			: { title: workspace.name, subtitle: title };
	};

	return (
		<nav className="flex min-w-0 items-center rounded-[14px] bg-ink/5 p-1 [-webkit-app-region:no-drag]">
			{workspaces.map((workspace, index) => {
				const Icon = iconOf(workspace.icon);
				const current = workspace.id === active?.id;
				const tab = showing(workspace);
				// A hairline between two resting tabs; the raised active tab needs none beside it.
				const divider = index > 0 && !current && workspaces[index - 1]?.id !== active?.id;
				return (
					<Fragment key={workspace.id}>
						{divider && <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-ink/12" />}
						<Link
							{...workspaceRoute(workspace)}
							aria-current={current ? "page" : undefined}
							title={`${tab.title}${tab.subtitle === undefined ? "" : `\n${tab.subtitle}`}\n${shortcutLabel(index + 1)}`}
							className={`flex h-9 w-56 min-w-12 shrink items-center gap-2 rounded-[10px] pr-3 pl-1.5 transition-colors [corner-shape:superellipse(1.25)] ${
								current
									? "border border-edge bg-linear-to-b from-frame-top to-frame text-ink shadow-frame"
									: "border border-transparent text-ink-muted hover:bg-ink/5 hover:text-ink"
							}`}
						>
							<span className="grid size-6 shrink-0 place-items-center rounded-[7px] border border-edge bg-frame-top text-ink shadow-xs">
								<Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
							</span>
							<span className="flex min-w-0 flex-col leading-tight">
								<span className="truncate text-[12px] font-medium">{tab.title}</span>
								{tab.subtitle !== undefined && (
									<span className="truncate text-[11px] text-ink-muted">{tab.subtitle}</span>
								)}
							</span>
						</Link>
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
