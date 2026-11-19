import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

const insetTitleBar = window.desktopBridge?.platform === "darwin";

/**
 * A full-window page's window: a drag strip with Back to App on the left and `end` on the right, then
 * the page below it. Back goes to the previous page, or with `home` to home in its place, for pages
 * reached on the way somewhere else.
 */
export function Frame({
	end,
	home = false,
	children,
}: {
	readonly end?: ReactNode;
	readonly home?: boolean;
	readonly children: ReactNode;
}) {
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const navigate = useNavigate();
	return (
		<div className="flex h-full flex-col bg-desktop text-ink">
			<header
				className={`flex h-titlebar shrink-0 items-center justify-between gap-4 pr-3 select-none [-webkit-app-region:drag] ${insetTitleBar ? "pl-22" : "pl-3"}`}
			>
				<button
					type="button"
					onClick={() => (canGoBack && !home ? router.history.back() : void navigate({ to: "/", replace: home }))}
					className="flex h-7 items-center gap-1.5 rounded-md px-2 text-2xs text-ink-muted outline-none [-webkit-app-region:no-drag] hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ArrowLeftIcon size={12} aria-hidden />
					Back to App
				</button>
				{end}
			</header>
			{children}
		</div>
	);
}
