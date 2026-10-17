import { useAtom, useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Check, ChevronRight, FolderKanban, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { isTheme, previewTheme, THEMES, themeAtom } from "../theme";
import { projects, projectsAddress } from "../widgets/projects";
import { deskAtom } from "../wm/instances";
import { lastWorkspaceAtom, openInWorkspaceRoute, useWorkspaces, workspaceTag } from "../wm/workspaces";
import { paletteShortcut } from "./switcher";
import { Swatch } from "./swatch";

/** How long the highlight rests on a theme before it previews, so scrolling through doesn't strobe. */
const PREVIEW_DELAY = 200;

const OPEN_PROJECTS = "widgets:projects";
const THEME_SETTINGS = "settings:themes";

/**
 * The Cmd+K command palette. Moving through the theme list with the keyboard previews each theme;
 * Enter keeps the highlighted one and closing without choosing restores the saved one. The pointer
 * only picks: hovering neither moves the highlight nor previews.
 */
export function Palette() {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [saved, setTheme] = useAtom(themeAtom);
	// The highlighted item, controlled so each opening starts at the top.
	const [value, setValue] = useState(OPEN_PROJECTS);
	const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
	const workspaces = useWorkspaces();
	const { instances } = useAtomValue(deskAtom);
	const lastId = useAtomValue(lastWorkspaceAtom);
	const { workspaceId } = useParams({ strict: false });

	// Where Projects already is, so the desktop reveals it there; else the workspace on screen, else the last used.
	const openProjects = () => {
		const open = instances.find((instance) => instance.kind === projects.kind);
		const target =
			(open && workspaces.find((workspace) => (open.tags & workspaceTag(workspace)) !== 0)) ??
			workspaces.find((workspace) => workspace.id === (workspaceId ?? lastId)) ??
			workspaces[0];
		if (target !== undefined) void navigate(openInWorkspaceRoute(target, projectsAddress, "replace"));
	};

	const show = (next: boolean) => {
		clearTimeout(pending.current);
		if (next) {
			setValue(OPEN_PROJECTS);
		} else {
			previewTheme(saved);
		}
		setOpen(next);
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!paletteShortcut(event)) return;
			event.preventDefault();
			show(!open);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	const run = (action: () => void) => {
		clearTimeout(pending.current);
		action();
		setOpen(false);
	};

	return (
		<CommandDialog
			open={open}
			onOpenChange={show}
			showCloseButton={false}
			// No open/close animation: it is keyboard-opened and used many times a day.
			className="top-[20%] translate-y-0 data-[state=closed]:animate-none! data-[state=open]:animate-none! sm:max-w-xl"
			command={{
				value,
				disablePointerSelection: true,
				onValueChange: (next) => {
					setValue(next);
					clearTimeout(pending.current);
					// Leaving the theme list restores the saved theme.
					const shown = isTheme(next) ? next : saved;
					pending.current = setTimeout(() => previewTheme(shown), PREVIEW_DELAY);
				},
			}}
		>
			<CommandInput placeholder="Type a command or search…" />
			<CommandList className="max-h-[min(420px,60vh)]">
				<CommandEmpty>No results.</CommandEmpty>
				<CommandGroup heading="Widgets">
					<CommandItem
						value={OPEN_PROJECTS}
						keywords={["open projects", "sessions"]}
						onSelect={() => run(openProjects)}
						className="hover:bg-accent/50"
					>
						<FolderKanban strokeWidth={1.75} />
						Open Projects
					</CommandItem>
				</CommandGroup>
				<CommandGroup heading="Settings">
					<CommandItem
						value={THEME_SETTINGS}
						keywords={["change theme", "appearance", "colors"]}
						onSelect={() => run(() => void navigate({ to: "/settings/themes" }))}
						className="hover:bg-accent/50"
					>
						<Settings strokeWidth={1.75} />
						Change theme…
					</CommandItem>
					{THEMES.map((theme) => (
						<CommandItem
							key={theme.id}
							value={theme.id}
							keywords={["change theme", theme.name]}
							onSelect={() => run(() => setTheme(theme.id))}
							className="hover:bg-accent/50"
						>
							<Swatch theme={theme.id} />
							<span className="text-ink-muted">Change theme</span>
							<ChevronRight className="-mx-1 size-3.5! text-ink-muted" strokeWidth={1.75} aria-hidden />
							{theme.name}
							{theme.id === saved && <Check className="ml-auto text-ink-muted" aria-label="Current theme" />}
						</CommandItem>
					))}
				</CommandGroup>
			</CommandList>
		</CommandDialog>
	);
}
