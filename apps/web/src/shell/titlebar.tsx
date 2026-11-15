import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useCanGoBack, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";

import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { isMac } from "@codeworksh/widget/view";
import { MAX_TABS, useCreateTab, useTabs, useTabReturn, tabRoute } from "../wm/tabs";
import { Switcher } from "./switcher";

// The window has no native title bar on macOS; a title bar is its drag region and leaves room for the
// inset traffic lights.
const insetTitleBar = window.desktopBridge?.platform === "darwin";

/** A square title-bar button; it opts out of the window's drag region so it can be clicked. */
const chromeButton =
	"grid size-7 shrink-0 place-items-center rounded-md text-ink-muted [-webkit-app-region:no-drag] hover:bg-selection-subtle hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

/** Window-level navigation remains available on Home, tabs, and settings. */
export function NavigationControls() {
	const { open, isMobile } = useSidebar();
	const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });
	const withSidebar = open && !isMobile;
	const { tabId } = useParams({ strict: false });
	const tabs = useTabs();
	const active = tabs.find((tab) => tab.id === tabId);
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
					<Switcher tabs={tabs} active={active} />
					<NewTabButton />
				</>
			)}
		</header>
	);
}

function CloseSettings() {
	const navigate = useNavigate();
	const back = useTabReturn();
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

/** Adds a tab and goes to it; pushed to the bar's right edge. */
function NewTabButton() {
	const tabs = useTabs();
	const navigate = useNavigate();
	const create = useCreateTab();
	const full = tabs.length >= MAX_TABS;
	const add = async () => {
		const tab = await create({ name: `Tab ${tabs.length + 1}` });
		void navigate(tabRoute(tab));
	};
	return (
		<button
			type="button"
			aria-label="New tab"
			title={full ? `All ${MAX_TABS} tabs are in use` : "New tab"}
			disabled={full}
			onClick={() => void add()}
			className={`${chromeButton} ml-1`}
		>
			<PlusIcon className="size-4" aria-hidden />
		</button>
	);
}
