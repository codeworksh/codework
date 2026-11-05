import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { Check, ChevronRight, FolderKanban, FolderPlus, KanbanSquare, Settings } from "lucide-react";
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
import { dashboard, dashboardAddress } from "../widgets/dashboard";
import { projects, projectsAddress } from "../widgets/projects";
import { deskAtom } from "../wm/instances";
import { lastWorkspaceAtom, openInWorkspaceRoute, useWorkspaces, workspaceTag } from "../wm/workspaces";
import { AddProject, PALETTE_LIST, type View } from "./sources";
import { paletteShortcut } from "./switcher";
import { Swatch } from "./swatch";

/** How long the highlight rests on a theme before it previews, so scrolling through doesn't strobe. */
const PREVIEW_DELAY = 200;

const OPEN_PROJECTS = "widgets:projects";
const OPEN_DASHBOARD = "widgets:dashboard";
const ADD_PROJECT = "projects:add";
const THEME_SETTINGS = "settings:themes";

/** Whether the palette is open, and the steps opened past its root list, each with what was typed. */
const paletteAtom = Atom.make<{ open: boolean; stack: ReadonlyArray<{ view: View; query: string }> }>({
	open: false,
	stack: [],
}).pipe(Atom.keepAlive);

/** Opens the palette at Add Project's sources. */
export function useAddProject() {
	const setPalette = useAtomSet(paletteAtom);
	return () => setPalette({ open: true, stack: [{ view: { kind: "sources" }, query: "" }] });
}

/**
 * The Cmd+K command palette. Moving through the theme list with the keyboard previews each theme;
 * Enter keeps the highlighted one and closing without choosing restores the saved one. The pointer
 * only picks: hovering neither moves the highlight nor previews.
 */
export function Palette() {
	const navigate = useNavigate();
	const [{ open, stack }, setPalette] = useAtom(paletteAtom);
	const step = stack.at(-1);
	const [saved, setTheme] = useAtom(themeAtom);
	// The highlighted item, controlled so each opening starts at the top.
	const [value, setValue] = useState(OPEN_PROJECTS);
	const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
	const workspaces = useWorkspaces();
	const { instances } = useAtomValue(deskAtom);
	const lastId = useAtomValue(lastWorkspaceAtom);
	const { workspaceId } = useParams({ strict: false });

	// Where the widget already is, so the desktop reveals it there; else the workspace on screen, else the last used.
	const openWidget = (kind: string, address: string) => {
		const open = instances.find((instance) => instance.kind === kind);
		const target =
			(open && workspaces.find((workspace) => (open.tags & workspaceTag(workspace)) !== 0)) ??
			workspaces.find((workspace) => workspace.id === (workspaceId ?? lastId)) ??
			workspaces[0];
		if (target !== undefined) void navigate(openInWorkspaceRoute(target, address, "replace"));
	};

	const show = (next: boolean) => {
		clearTimeout(pending.current);
		if (next) {
			setValue(OPEN_PROJECTS);
		} else {
			previewTheme(saved);
		}
		setPalette({ open: next, stack: [] });
	};
	const close = () => show(false);

	const push = (view: View, query = "") => {
		setValue("");
		setPalette({ open, stack: [...stack, { view, query }] });
	};
	const pop = () => {
		setValue(stack.length === 1 ? ADD_PROJECT : "");
		setPalette({ open, stack: stack.slice(0, -1) });
	};
	const setQuery = (query: string) =>
		setPalette({
			open,
			stack: stack.map((entry, index) => (index === stack.length - 1 ? { ...entry, query } : entry)),
		});

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
		close();
	};

	return (
		<CommandDialog
			open={open}
			onOpenChange={show}
			showCloseButton={false}
			// No open/close animation: it is keyboard-opened and used many times a day. One height for
			// every step and listing, so moving through them never resizes it.
			className="top-[20%] flex h-[min(440px,70vh)] translate-y-0 flex-col data-[state=closed]:animate-none! data-[state=open]:animate-none! sm:max-w-xl"
			command={{
				value,
				disablePointerSelection: true,
				// Typed paths, names and URLs aren't searches; the steps filter their own rows.
				shouldFilter: step === undefined || step.view.kind === "sources",
				onValueChange: (next) => {
					setValue(next);
					clearTimeout(pending.current);
					// Leaving the theme list restores the saved theme.
					const shown = isTheme(next) ? next : saved;
					pending.current = setTimeout(() => previewTheme(shown), PREVIEW_DELAY);
				},
			}}
		>
			{step !== undefined ? (
				<AddProject key={stack.length} step={step} setQuery={setQuery} push={push} pop={pop} close={close} />
			) : (
				<>
					<CommandInput placeholder="Type a command or search…" />
					<CommandList className={PALETTE_LIST}>
						<CommandEmpty>No results.</CommandEmpty>
						<CommandGroup heading="Projects">
							<CommandItem
								value={ADD_PROJECT}
								keywords={[
									"add project",
									"new project",
									"folder",
									"directory",
									"browse",
									"clone",
									"repository",
									"github",
								]}
								onSelect={() => push({ kind: "sources" })}
							>
								<FolderPlus strokeWidth={1.75} />
								Add Project…
							</CommandItem>
						</CommandGroup>
						<CommandGroup heading="Widgets">
							<CommandItem
								value={OPEN_PROJECTS}
								keywords={["open projects", "sessions"]}
								onSelect={() => run(() => openWidget(projects.kind, projectsAddress))}
							>
								<FolderKanban strokeWidth={1.75} />
								Open Projects
							</CommandItem>
							<CommandItem
								value={OPEN_DASHBOARD}
								keywords={["open dashboard", "board", "threads", "status", "priority", "groups"]}
								onSelect={() => run(() => openWidget(dashboard.kind, dashboardAddress))}
							>
								<KanbanSquare strokeWidth={1.75} />
								Open Dashboard
							</CommandItem>
						</CommandGroup>
						<CommandGroup heading="Settings">
							<CommandItem
								value={THEME_SETTINGS}
								keywords={["change theme", "appearance", "colors"]}
								onSelect={() => run(() => void navigate({ to: "/settings/themes" }))}
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
								>
									<Swatch theme={theme.id} />
									<span className="text-ink-muted">Change theme</span>
									<ChevronRight className="-mx-1 size-3.5! text-ink-muted" strokeWidth={1.75} aria-hidden />
									{theme.name}
									{theme.id === saved && (
										<Check className="ml-auto text-ink-muted" aria-label="Current theme" />
									)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</>
			)}
		</CommandDialog>
	);
}
