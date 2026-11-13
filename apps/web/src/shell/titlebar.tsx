import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useCanGoBack, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";

import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { isMac } from "@codeworksh/widget/view";
import {
	MAX_WORKSPACES,
	useCreateWorkspace,
	useWorkspaces,
	useWorkspaceReturn,
	workspaceRoute,
} from "../wm/workspaces";
import { Switcher } from "./switcher";

// The window has no native title bar on macOS; a title bar is its drag region and leaves room for the
// inset traffic lights.
const insetTitleBar = window.desktopBridge?.platform === "darwin";

/** A square title-bar button; it opts out of the window's drag region so it can be clicked. */
const chromeButton =
	"grid size-7 shrink-0 place-items-center rounded-md text-ink-muted [-webkit-app-region:no-drag] hover:bg-selection-subtle hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

/** Window-level navigation remains available on Home, workspaces, and settings. */
export function NavigationControls() {
	const { open, isMobile } = useSidebar();
	const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });
	const withSidebar = open && !isMobile;
	const { workspaceId } = useParams({ strict: false });
	const workspaces = useWorkspaces();
	const active = workspaces.find((workspace) => workspace.id === workspaceId);
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const index = useLocation({ select: (location) => location.state.__TSR_index });
	const canGoForward = index < router.history.length - 1;
	return (
		<header className="flex h-titlebar w-full shrink-0 items-center bg-desktop pr-2 select-none [-webkit-app-region:drag]">
			<div
				data-slot="sidebar-navigation"
				className={`flex shrink-0 items-center gap-1 pr-3 ${insetTitleBar ? "pl-22" : "pl-3"}`}
				style={{ width: withSidebar ? "var(--sidebar-width)" : "fit-content" }}
			>
				<SidebarTrigger
					title={`Toggle sidebar (${isMac ? "⌘B" : "Ctrl+B"})`}
					className="text-ink-muted [-webkit-app-region:no-drag] hover:text-ink"
				/>
				<div className="flex items-center">
					<button
						type="button"
						aria-label="Back"
						title="Back"
						disabled={!canGoBack}
						onClick={() => router.history.back()}
						className={chromeButton}
					>
						<ArrowLeftIcon className="size-3.5" aria-hidden />
					</button>
					<button
						type="button"
						aria-label="Forward"
						title="Forward"
						disabled={!canGoForward}
						onClick={() => router.history.forward()}
						className={chromeButton}
					>
						<ArrowRightIcon className="size-3.5" aria-hidden />
					</button>
				</div>
			</div>
			{inSettings ? (
				<CloseSettings />
			) : (
				<>
					<Switcher workspaces={workspaces} active={active} />
					<NewWorkspaceButton />
				</>
			)}
		</header>
	);
}

function CloseSettings() {
	const navigate = useNavigate();
	const back = useWorkspaceReturn();
	return (
		<button
			type="button"
			aria-label="Close settings"
			title="Close settings (Esc)"
			className={`${chromeButton} ml-auto`}
			onClick={() => void navigate(back)}
		>
			<XIcon className="size-4" aria-hidden />
		</button>
	);
}

/** Adds a workspace and goes to it; pushed to the bar's right edge. */
function NewWorkspaceButton() {
	const workspaces = useWorkspaces();
	const navigate = useNavigate();
	const create = useCreateWorkspace();
	const full = workspaces.length >= MAX_WORKSPACES;
	const add = async () => {
		const workspace = await create({ name: `Workspace ${workspaces.length + 1}` });
		void navigate(workspaceRoute(workspace));
	};
	return (
		<button
			type="button"
			aria-label="New workspace"
			title={full ? `All ${MAX_WORKSPACES} workspaces are in use` : "New workspace"}
			disabled={full}
			onClick={() => void add()}
			className={`${chromeButton} ml-1`}
		>
			<PlusIcon className="size-4" aria-hidden />
		</button>
	);
}
