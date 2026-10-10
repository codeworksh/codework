import { Link } from "@tanstack/react-router";

import { isMac } from "../kernel/platform";
import { type Workspace, workspaceRoute } from "../wm/workspaces";
import { iconOf } from "./icons";

interface SwitcherProps {
	readonly workspaces: readonly Workspace[];
	/** The workspace on screen; none while settings is open. */
	readonly active: Workspace | undefined;
}

/** Workspace tabs; the active workspace is the URL, so each tab is just a link. */
export function Switcher({ workspaces, active }: SwitcherProps) {
	return (
		<nav className="flex items-center gap-0.5 rounded-xl bg-ink/5 p-0.5 [-webkit-app-region:no-drag]">
			{workspaces.map((workspace, index) => {
				const Icon = iconOf(workspace.icon);
				const current = workspace.id === active?.id;
				return (
					<Link
						key={workspace.id}
						{...workspaceRoute(workspace)}
						aria-current={current ? "page" : undefined}
						title={`${workspace.name} (${shortcutLabel(index + 1)})`}
						className={`flex h-7 items-center gap-1.5 rounded-[10px] px-3 font-medium max-md:px-2 transition-colors [corner-shape:superellipse(1.25)] ${
							current
								? "border border-edge bg-linear-to-b from-frame-top to-frame text-ink shadow-frame"
								: "border border-transparent text-ink-muted hover:bg-ink/5 hover:text-ink"
						}`}
					>
						<Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
						{/* Narrow windows keep only the icons; the title still names the tab. */}
						<span className="max-md:sr-only">{workspace.name}</span>
					</Link>
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
