import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { Check, ChevronRight, FolderKanban, FolderPlus, ListTodo, Settings } from "lucide-react";
import { useEffect, useState } from "react";

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
import { AddProject, PALETTE_LIST, type View } from "./sources";
import { paletteShortcut } from "./switcher";
import { Swatch } from "./swatch";

const OPEN_PROJECTS = "widgets:projects";
const GO_THREADS = "navigation:threads";
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
 * Opens a widget by kind and address: where it already is, so the desktop reveals it there; else
 * in the workspace on screen, else the last used.
 */
function useOpenWidget() {
	const navigate = useNavigate();
	const workspaces = useWorkspaces();
	const { instances } = useAtomValue(deskAtom);
	const lastId = useAtomValue(lastWorkspaceAtom);
	const { workspaceId } = useParams({ strict: false });
	return (kind: string, address: string) => {
		const open = instances.find((instance) => instance.kind === kind);
		const target =
			(open && workspaces.find((workspace) => (open.tags & workspaceTag(workspace)) !== 0)) ??
			workspaces.find((workspace) => workspace.id === (workspaceId ?? lastId)) ??
			workspaces[0];
		if (target !== undefined) void navigate(openInWorkspaceRoute(target, address, "replace"));
	};
}

/**
 * The Cmd+K command palette. Highlighting a theme with the keyboard previews it;
 * Enter keeps the highlighted one and closing without choosing restores the saved one. The pointer
 * only picks: hovering neither moves the highlight nor previews.
 */
export function Palette() {
	const navigate = useNavigate();
	const [{ open, stack }, setPalette] = useAtom(paletteAtom);
	const step = stack.at(-1);
	const [saved, setTheme] = useAtom(themeAtom);
	// The highlighted item, controlled so each opening starts at the top.
	const [value, setValue] = useState(GO_THREADS);
	const openWidget = useOpenWidget();

	const show = (next: boolean) => {
		if (next) {
			setValue(GO_THREADS);
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

	// Closes without putting the saved theme back: the action may have just chosen another.
	const run = (action: () => void) => {
		setPalette({ open: false, stack: [] });
		action();
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
					// A theme previews as soon as it is highlighted; leaving the list restores the saved one.
					previewTheme(isTheme(next) ? next : saved);
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
						<CommandGroup heading="Navigation">
							<CommandItem
								value={GO_THREADS}
								keywords={["all threads", "go", "issues", "list", "status", "priority", "groups"]}
								onSelect={() => run(() => void navigate({ to: "/threads" }))}
							>
								<ListTodo strokeWidth={1.75} />
								All Threads
							</CommandItem>
						</CommandGroup>
						<CommandGroup heading="View">
							<CommandItem
								value={OPEN_PROJECTS}
								keywords={["open", "projects", "sessions", "threads", "forks", "tree"]}
								onSelect={() => run(() => openWidget(projects.kind, projectsAddress))}
							>
								<FolderKanban strokeWidth={1.75} />
								Projects
							</CommandItem>
						</CommandGroup>
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
