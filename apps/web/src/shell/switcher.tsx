import { Link } from "@tanstack/react-router";

import { workspaceRoute, workspaces } from "../wm/workspaces";

interface SwitcherProps {
	readonly active: number;
}

/** Workspace tabs; the active workspace is the URL, so each tab is just a link. */
export function Switcher({ active }: SwitcherProps) {
	return (
		<nav className="flex items-center gap-0.5 rounded-xl bg-ink/5 p-0.5 [-webkit-app-region:no-drag]">
			{workspaces.map(({ id, name, icon: Icon }) => {
				const current = id === active;
				return (
					<Link
						key={id}
						{...workspaceRoute(id)}
						aria-current={current ? "page" : undefined}
						title={`${name} (${shortcutLabel(id)})`}
						className={`flex h-7 items-center gap-1.5 rounded-[10px] px-3 font-medium transition-colors [corner-shape:superellipse(1.25)] ${
							current
								? "border border-edge bg-linear-to-b from-frame-top to-frame text-ink shadow-frame"
								: "border border-transparent text-ink-muted hover:bg-ink/5 hover:text-ink"
						}`}
					>
						<Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
						{name}
					</Link>
				);
			})}
		</nav>
	);
}

const isMac = navigator.platform.startsWith("Mac");

export const shortcutLabel = (id: number) => `${isMac ? "⌘" : "Ctrl+"}${id}`;

/** Cmd+N on macOS, Ctrl+N elsewhere, like switching browser tabs. */
export function workspaceShortcut(event: KeyboardEvent): number | null {
	if (event.altKey || event.shiftKey || !(isMac ? event.metaKey : event.ctrlKey)) return null;
	const id = Number(event.key);
	return workspaces.some((workspace) => workspace.id === id) ? id : null;
}
