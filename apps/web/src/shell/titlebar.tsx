import { useCanGoBack, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Plus } from "lucide-react";

import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { isMac } from "@codeworksh/widget/view";
import { MAX_WORKSPACES, useCreateWorkspace, useWorkspaces, workspaceRoute } from "../wm/workspaces";
import { Switcher } from "./switcher";

// The window has no native title bar on macOS; a title bar is its drag region and leaves room for the
// inset traffic lights.
export const insetTitleBar = window.desktopBridge?.platform === "darwin";

/** A square title-bar button; it opts out of the window's drag region so it can be clicked. */
export const chromeButton =
	"grid size-7 shrink-0 place-items-center rounded-[10px] text-ink-muted press [-webkit-app-region:no-drag] hover:bg-ink/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

/** Window-level navigation remains available on Home, workspaces, and settings. */
export function NavigationControls() {
	const { open, isMobile } = useSidebar();
	const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });
	const withSidebar = open && !isMobile && !inSettings;
	const { workspaceId } = useParams({ strict: false });
	const workspaces = useWorkspaces();
	const active = workspaces.find((workspace) => workspace.id === workspaceId);
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const index = useLocation({ select: (location) => location.state.__TSR_index });
	const canGoForward = index < router.history.length - 1;
	return (
		<header className="flex h-12 w-full shrink-0 items-center border-b border-edge/50 bg-desktop pr-2 select-none [-webkit-app-region:drag]">
			<div
				className={`flex shrink-0 items-center gap-1 px-2 ${insetTitleBar ? "min-w-44 pl-20" : "min-w-28"}`}
				style={{ width: withSidebar ? "calc(52px + var(--sidebar-width))" : undefined }}
			>
				<button
					type="button"
					aria-label="Back"
					title="Back"
					disabled={!canGoBack}
					onClick={() => router.history.back()}
					className={chromeButton}
				>
					<ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden />
				</button>
				<button
					type="button"
					aria-label="Forward"
					title="Forward"
					disabled={!canGoForward}
					onClick={() => router.history.forward()}
					className={chromeButton}
				>
					<ArrowRight className="size-4" strokeWidth={1.5} aria-hidden />
				</button>
				<SidebarTrigger
					title={`Toggle sidebar (${isMac ? "⌘B" : "Ctrl+B"})`}
					className="text-ink-muted [-webkit-app-region:no-drag] hover:text-ink"
				/>
			</div>
			<Switcher workspaces={workspaces} active={active} />
			<NewWorkspaceButton />
		</header>
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
			className={chromeButton}
		>
			<Plus className="size-4" strokeWidth={1.75} aria-hidden />
		</button>
	);
}
