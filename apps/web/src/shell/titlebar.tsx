import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronLeft, House, Plus, Settings } from "lucide-react";

import { MAX_WORKSPACES, useCreateWorkspace, useWorkspaces, workspaceRoute } from "../wm/workspaces";

/*
 * Title-bar controls shared by the workspace shell and the start page, so the two bars behave alike.
 */

// The window has no native title bar on macOS; a title bar is its drag region and leaves room for the
// inset traffic lights.
export const insetTitleBar = window.desktopBridge?.platform === "darwin";

/** A square title-bar button; it opts out of the window's drag region so it can be clicked. */
export const chromeButton =
	"grid size-7 shrink-0 place-items-center rounded-[10px] text-ink-muted press [-webkit-app-region:no-drag] hover:bg-ink/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

export function BackButton() {
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

export function HomeButton() {
	return (
		<Link to="/" aria-label="Home" title="Home: the start page" className={chromeButton}>
			<House className="size-4" strokeWidth={1.75} aria-hidden />
		</Link>
	);
}

/** Adds a workspace and goes to it; pushed to the bar's right edge. */
export function NewWorkspaceButton() {
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

export function SettingsButton({ current = false }: { readonly current?: boolean }) {
	return (
		<Link
			to="/settings/workspaces"
			aria-label="Settings"
			title="Settings"
			aria-current={current ? "page" : undefined}
			className={`${chromeButton} aria-[current=page]:bg-ink/8 aria-[current=page]:text-ink`}
		>
			<Settings className="size-4" strokeWidth={1.75} aria-hidden />
		</Link>
	);
}
