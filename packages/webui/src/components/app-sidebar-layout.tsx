import { Link } from "@tanstack/react-router";
import {
	ArchiveIcon,
	ArrowUpDownIcon,
	ChevronRightIcon,
	MenuIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	SquarePenIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { APP_BASE_NAME, APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { sidebarMockData } from "../data/sidebar";
import type { SidebarMockProject, SidebarMockThread } from "../data/sidebar-types";
import { isElectron } from "../env";
import { useCommandPaletteStore } from "../lib/cmd-palette-store";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "./ui/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./ui/tooltip";

const SIDEBAR_WIDTH = "17rem";

export function AppSidebarLayout({ children }: { children: ReactNode }) {
	return (
		<TooltipProvider delay={250}>
			<div
				className="app-sidebar-layout flex h-screen w-screen overflow-hidden bg-background text-foreground"
				style={{ "--sidebar-width": SIDEBAR_WIDTH } as React.CSSProperties}
			>
				<div className="group peer hidden text-sidebar-foreground md:block" data-collapsible="" data-side="left" data-state="expanded" data-variant="sidebar">
					<div className="relative w-[var(--sidebar-width)] bg-transparent transition-[width] duration-200 ease-linear" data-slot="sidebar-gap" />
					<aside className="fixed inset-y-0 left-0 z-10 hidden h-svh w-[var(--sidebar-width)] border-r border-border bg-card text-foreground transition-[width] duration-200 ease-linear md:flex" data-slot="sidebar-container">
						<SidebarSurface />
					</aside>
				</div>

				<div className="flex min-w-0 flex-1 flex-col">
					<header
						className={cn(
							"app-mobile-header flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 md:hidden",
							isElectron &&
								"drag-region h-[52px] pl-[90px] wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)] wco:pl-[calc(env(titlebar-area-x)+1em)]",
						)}
					>
						<MobileSidebar />
						<div className="flex min-w-0 flex-1 items-center gap-1.5">
							<CodeWorkMark />
							<span className="truncate text-sm font-medium tracking-tight">{APP_BASE_NAME}</span>
						</div>
						<CommandPaletteIconButton />
					</header>

					<main className="min-h-0 flex-1 overflow-auto">{children}</main>
				</div>
			</div>
		</TooltipProvider>
	);
}

function SidebarSurface() {
	return (
		<div className="flex h-full w-full min-w-0 flex-col bg-sidebar" data-sidebar="sidebar" data-slot="sidebar-inner">
			<SidebarContent />
			<button
				aria-label="Resize Sidebar"
				className="absolute inset-y-0 -right-4 z-20 hidden w-4 -translate-x-1/2 cursor-w-resize transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex"
				data-sidebar="rail"
				data-slot="sidebar-rail"
				tabIndex={-1}
				title="Drag to resize sidebar"
				type="button"
			/>
		</div>
	);
}

function SidebarContent() {
	const [expandedProjectIds, setExpandedProjectIds] = useState(() =>
		new Set(sidebarMockData.projects.filter((project) => project.expanded).map((project) => project.id)),
	);
	const [activeThreadId, setActiveThreadId] = useState(() => {
		for (const project of sidebarMockData.projects) {
			const activeThread = project.threads.find((thread) => thread.active);
			if (activeThread) return activeThread.id;
		}
		return sidebarMockData.projects[0]?.threads[0]?.id ?? null;
	});

	const toggleProject = (projectId: string) => {
		setExpandedProjectIds((current) => {
			const next = new Set(current);
			if (next.has(projectId)) {
				next.delete(projectId);
			} else {
				next.add(projectId);
			}
			return next;
		});
	};

	return (
		<>
			<SidebarChromeHeader />

			<div className="size-full h-auto min-h-0 flex-1 overflow-hidden" role="presentation">
				<div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					<div className="flex w-full min-w-0 flex-col gap-0" data-sidebar="content" data-slot="sidebar-content">
						<SidebarCommandSearch />
						<SidebarProjects
							activeThreadId={activeThreadId}
							expandedProjectIds={expandedProjectIds}
							onSelectThread={setActiveThreadId}
							onToggleProject={toggleProject}
						/>
					</div>
				</div>
			</div>

			<Separator className="mx-2 w-auto bg-sidebar-border" data-sidebar="separator" data-slot="sidebar-separator" />
			<SidebarChromeFooter />
		</>
	);
}

function SidebarChromeHeader() {
	const wordmark = (
		<div className="flex items-center gap-2">
			<Tooltip>
				<TooltipTrigger
					render={
						<Link
							aria-label="Go to threads"
							className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
							to="/"
						>
							<CodeWorkMark />
							<span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
								Code
							</span>
							<span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
								{APP_STAGE_LABEL}
							</span>
						</Link>
					}
				/>
				<TooltipContent side="bottom" sideOffset={2}>
					Version {APP_VERSION}
				</TooltipContent>
			</Tooltip>
		</div>
	);

	return (
		<div
			className={cn(
				"flex flex-col gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3",
				isElectron &&
					"drag-region h-[52px] flex-row items-center gap-2 py-0 pl-[90px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]",
			)}
			data-sidebar="header"
			data-slot="sidebar-header"
		>
			{wordmark}
		</div>
	);
}

function SidebarCommandSearch() {
	const setOpen = useCommandPaletteStore((store) => store.setOpen);

	return (
		<div className="relative flex w-full min-w-0 flex-col px-2 pt-2 pb-1" data-sidebar="group" data-slot="sidebar-group">
			<ul className="flex w-full min-w-0 flex-col gap-1" data-sidebar="menu" data-slot="sidebar-menu">
				<li className="group/menu-item relative" data-sidebar="menu-item" data-slot="sidebar-menu-item">
					<button
						type="button"
						className="flex h-7 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground/70 outline-hidden ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
						data-testid="command-palette-trigger"
						onClick={() => setOpen(true)}
					>
						<SearchIcon className="size-3.5 shrink-0" />
						<span className="flex-1 truncate text-left text-xs">Search</span>
						<kbd className="pointer-events-none inline-flex h-4 min-w-0 select-none items-center justify-center rounded-sm bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground">
							⌘K
						</kbd>
					</button>
				</li>
			</ul>
		</div>
	);
}

function SidebarProjects({
	activeThreadId,
	expandedProjectIds,
	onSelectThread,
	onToggleProject,
}: {
	activeThreadId: string | null;
	expandedProjectIds: ReadonlySet<string>;
	onSelectThread: (threadId: string) => void;
	onToggleProject: (projectId: string) => void;
}) {
	return (
		<div className="relative flex w-full min-w-0 flex-col px-2 py-2" data-sidebar="group" data-slot="sidebar-group">
			<div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
				<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
					Projects
				</span>
				<div className="flex items-center gap-1">
					<IconTooltip label="Sort projects">
						<button
							type="button"
							className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
						>
							<ArrowUpDownIcon className="size-3.5" />
						</button>
					</IconTooltip>
					<IconTooltip label="Add project">
						<button
							type="button"
							aria-label="Add project"
							className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
						>
							<PlusIcon className="size-3.5" />
						</button>
					</IconTooltip>
				</div>
			</div>

			<ul className="flex w-full min-w-0 flex-col gap-1" data-sidebar="menu" data-slot="sidebar-menu">
				{sidebarMockData.projects.map((project) => (
					<SidebarProjectRow
						activeThreadId={activeThreadId}
						expanded={expandedProjectIds.has(project.id)}
						key={project.id}
						onSelectThread={onSelectThread}
						onToggle={() => onToggleProject(project.id)}
						project={project}
					/>
				))}
			</ul>
		</div>
	);
}

function SidebarProjectRow({
	activeThreadId,
	expanded,
	onSelectThread,
	onToggle,
	project,
}: {
	activeThreadId: string | null;
	expanded: boolean;
	onSelectThread: (threadId: string) => void;
	onToggle: () => void;
	project: SidebarMockProject;
}) {
	const activeThreadInProject = useMemo(
		() => project.threads.some((thread) => thread.id === activeThreadId),
		[activeThreadId, project.threads],
	);

	return (
		<li className="group/menu-item relative rounded-md" data-sidebar="menu-item" data-slot="sidebar-menu-item">
			<div className="group/project-header relative">
				<button
					type="button"
					className="flex h-7 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-xs outline-hidden ring-ring transition-colors hover:bg-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
					data-active={activeThreadInProject}
					data-sidebar="menu-button"
					data-slot="sidebar-menu-button"
					onClick={onToggle}
				>
					<ChevronRightIcon
						className={cn(
							"-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
							expanded && "rotate-90",
						)}
					/>
					<ProjectFavicon project={project} />
					<span className="flex min-w-0 flex-1 items-center gap-2">
						<span className="truncate text-xs font-medium text-foreground/90">{project.name}</span>
					</span>
				</button>
				<IconTooltip label={`New thread in ${project.name}`}>
					<div className="pointer-events-none absolute top-1 right-1.5 opacity-0 transition-opacity duration-150 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
						<button
							type="button"
							aria-label={`Create new thread in ${project.name}`}
							className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
							onClick={(event) => {
								event.stopPropagation();
							}}
						>
							<SquarePenIcon className="size-3.5" />
						</button>
					</div>
				</IconTooltip>
			</div>

			{expanded ? (
				<ul
					className="mx-1 my-0 flex w-full min-w-0 translate-x-0 flex-col gap-0.5 overflow-hidden border-l border-sidebar-border px-1.5 py-0"
					data-sidebar="menu-sub"
					data-slot="sidebar-menu-sub"
				>
					{project.threads.map((thread) => (
						<SidebarThreadRow
							active={activeThreadId === thread.id}
							key={thread.id}
							onSelect={() => onSelectThread(thread.id)}
							thread={thread}
						/>
					))}
				</ul>
			) : null}
		</li>
	);
}

function SidebarThreadRow({
	active,
	onSelect,
	thread,
}: {
	active: boolean;
	onSelect: () => void;
	thread: SidebarMockThread;
}) {
	return (
		<li className="group/menu-sub-item relative w-full" data-sidebar="menu-sub-item" data-slot="sidebar-menu-sub-item" data-thread-item="true">
			<button
				type="button"
				className={cn(
					"relative isolate flex h-7 w-full min-w-0 translate-x-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-left text-xs text-muted-foreground outline-hidden ring-ring select-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
					active && "bg-sidebar-accent text-sidebar-accent-foreground",
				)}
				data-active={active}
				data-sidebar="menu-sub-button"
				data-slot="sidebar-menu-sub-button"
				onClick={onSelect}
			>
				<span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
					<span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
				</span>
				<span className="ml-auto flex shrink-0 items-center gap-1.5">
					<span className="flex min-w-12 justify-end">
						<span className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
							<span className="inline-flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground">
								<ArchiveIcon className="size-3.5" />
							</span>
						</span>
						<span className="pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0">
							<span className={cn("text-[10px]", active ? "text-foreground/70" : "text-muted-foreground/40")}>
								{thread.relativeTime}
							</span>
						</span>
					</span>
				</span>
			</button>
		</li>
	);
}

function SidebarChromeFooter() {
	return (
		<div className="flex flex-col gap-2 p-2" data-sidebar="footer" data-slot="sidebar-footer">
			<ul className="flex w-full min-w-0 flex-col gap-1" data-sidebar="menu" data-slot="sidebar-menu">
				<li className="group/menu-item relative" data-sidebar="menu-item" data-slot="sidebar-menu-item">
					<Link
						className="flex h-7 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground/70 outline-hidden ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
						to="/concepts"
					>
						<SettingsIcon className="size-3.5" />
						<span className="text-xs">Settings</span>
					</Link>
				</li>
			</ul>
		</div>
	);
}

function MobileSidebar() {
	return (
		<Sheet>
			<SheetTrigger render={<Button aria-label="Open navigation" size="icon" variant="ghost" />}>
				<MenuIcon />
			</SheetTrigger>
			<SheetContent className="w-72 p-0" side="left">
				<SheetHeader className="sr-only">
					<SheetTitle>{APP_BASE_NAME}</SheetTitle>
					<SheetDescription>Application navigation</SheetDescription>
				</SheetHeader>
				<SidebarSurface />
			</SheetContent>
		</Sheet>
	);
}

function CommandPaletteIconButton() {
	const setOpen = useCommandPaletteStore((store) => store.setOpen);
	const button = (
		<Button aria-label="Open command palette" onClick={() => setOpen(true)} size="icon" variant="ghost">
			<SearchIcon />
		</Button>
	);

	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipContent>Command palette</TooltipContent>
		</Tooltip>
	);
}

function ProjectFavicon({ project }: { project: SidebarMockProject }) {
	return (
		<span
			aria-hidden="true"
			className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-[8px] font-semibold text-white shadow-sm"
			style={{ backgroundColor: project.faviconColor }}
			title={project.cwd}
		>
			{project.name.slice(0, 1).toUpperCase()}
		</span>
	);
}

function CodeWorkMark() {
	return (
		<span className="inline-flex h-4 w-auto shrink-0 items-center text-[10px] font-semibold tracking-normal text-foreground">
			CW
		</span>
	);
}

function IconTooltip({ children, label }: { children: ReactNode; label: string }) {
	return (
		<Tooltip>
			<TooltipTrigger render={<span className="inline-flex">{children}</span>} />
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}
