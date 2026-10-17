import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronLeft, House, Plus, Settings } from "lucide-react";

import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { isMac } from "@codeworksh/widget/view";
import { MAX_WORKSPACES, useCreateWorkspace, useWorkspaces, type Workspace, workspaceRoute } from "../wm/workspaces";
import { Switcher } from "./switcher";

// The window has no native title bar on macOS; a title bar is its drag region and leaves room for the
// inset traffic lights.
export const insetTitleBar = window.desktopBridge?.platform === "darwin";

/** A square title-bar button; it opts out of the window's drag region so it can be clicked. */
export const chromeButton =
	"grid size-7 shrink-0 place-items-center rounded-[10px] text-ink-muted press [-webkit-app-region:no-drag] hover:bg-ink/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * The title bar over the start page and workspaces: the window's drag region with the sidebar
 * toggle, navigation, the workspace switcher and settings. With the sidebar hidden, or overlaid as
 * a sheet in a narrow window, it sits in the window's corner, so it moves clear of the macOS
 * traffic lights.
 */
export function TitleBar({
	active,
}: {
	/** The workspace on screen; none on the start page. */
	readonly active: Workspace | undefined;
}) {
	const { open, isMobile } = useSidebar();
	const inCorner = !open || isMobile;
	const workspaces = useWorkspaces();
	return (
		<header
			className={`flex h-12 shrink-0 items-center gap-1.5 px-2 select-none [-webkit-app-region:drag] ${inCorner && insetTitleBar ? "pl-20" : ""}`}
		>
			<SidebarTrigger
				title={`Toggle sidebar (${isMac ? "⌘B" : "Ctrl+B"})`}
				className="text-ink-muted [-webkit-app-region:no-drag] hover:text-ink"
			/>
			<BackButton />
			<HomeButton />
			<Switcher workspaces={workspaces} active={active} />
			<NewWorkspaceButton />
			<SettingsButton />
		</header>
	);
}

function BackButton() {
	const router = useRouter();
	const canGoBack = useCanGoBack();
	return (
		<button
			type="button"
			aria-label="Back"
			title="Back"
			disabled={!canGoBack}
			onClick={() => router.history.back()}
			className={chromeButton}
		>
			<ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden />
		</button>
	);
}

function HomeButton() {
	return (
		<Link to="/" aria-label="Home" title="Home: the start page" className={chromeButton}>
			<House className="size-4" strokeWidth={1.75} aria-hidden />
		</Link>
	);
}

/** Adds a workspace and goes to it; pushed to the bar's right edge. */
function NewWorkspaceButton() {
	const workspaces = useWorkspaces();
	const navigate = useNavigate();
	const create = useCreateWorkspace();
	const full = workspaces.length >= MAX_WORKSPACES;
	const add = async () => {
		const workspace = await create({ name: `Workspace ${workspaces.length + 1}`, icon: "app-window" });
		void navigate(workspaceRoute(workspace));
	};
	return (
		<button
			type="button"
			aria-label="New workspace"
			title={full ? `All ${MAX_WORKSPACES} workspaces are in use` : "New workspace"}
			disabled={full}
			onClick={() => void add()}
			className={`${chromeButton} ml-auto`}
		>
			<Plus className="size-4" strokeWidth={1.75} aria-hidden />
		</button>
	);
}

function SettingsButton() {
	return (
		<Link to="/settings/workspaces" aria-label="Settings" title="Settings" className={chromeButton}>
			<Settings className="size-4" strokeWidth={1.75} aria-hidden />
		</Link>
	);
}
