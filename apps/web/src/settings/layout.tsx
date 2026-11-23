import { useAtomValue } from "@effect/atom-react";
import { ArrowLeftIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";

import { useScrollFade } from "@/hooks/use-scroll-fade";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInput,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "@/components/ui/sidebar";
import { ConnectionStatus } from "../shell/status";
import { isSignedInApp } from "../auth";
import { workspaceAtom } from "../kernel/relay";
import { useTabReturn } from "../wm/tabs";
import { search } from "./sections";

/** Settings replaces the sessions list within the same app shell and sidebar controls. */
export function SettingsSidebar() {
	const pathname = useLocation({ select: (location) => location.pathname });
	const navigate = useNavigate();
	const back = useTabReturn();
	const [query, setQuery] = useState("");
	const current = useAtomValue(workspaceAtom);
	const workspaceId = AsyncResult.isSuccess(current) ? current.value?.id : undefined;
	// The account's pages sit under the workspace, so they wait for it; signed out, there is no account.
	const matches = search(query).filter(
		(section) => !section.to.includes("$workspaceId") || (isSignedInApp && workspaceId !== undefined),
	);
	const params = { workspaceId: workspaceId ?? "" };
	const groups = [...new Set(matches.map((section) => section.group))];
	return (
		<Sidebar collapsible="offcanvas" className="shell-sidebar select-none">
			<SidebarHeader className="gap-2 px-2 pt-2 pb-2">
				<Link
					{...back}
					className="flex h-7 w-fit items-center gap-1.5 rounded-full pr-3 pl-1.5 text-ui font-medium text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ArrowLeftIcon size={14} className="shrink-0" aria-hidden />
					<span>Back to App</span>
				</Link>
				<div className="relative">
					<MagnifyingGlassIcon
						size={14}
						className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-muted"
						aria-hidden
					/>
					<SidebarInput
						type="search"
						placeholder="Search…"
						aria-label="Search settings"
						value={query}
						className="h-7 rounded-lg border border-edge bg-frame-top pr-2 pl-8 text-ui font-medium shadow-none placeholder:text-ink-muted focus-visible:ring-2 focus-visible:ring-ring"
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							const first = matches[0];
							if (event.key === "Enter" && first !== undefined) void navigate({ to: first.to, params });
							if (event.key === "Escape" && query !== "") {
								event.preventDefault();
								setQuery("");
							}
						}}
					/>
				</div>
			</SidebarHeader>
			<SidebarContent className="gap-0 px-2 pb-2">
				<nav aria-label="Settings navigation" className="flex flex-col gap-3 pt-2">
					{groups.map((group) => (
						<SidebarGroup key={group} className="p-0">
							<SidebarGroupLabel className="h-7 px-2.5 text-ui font-medium text-ink-muted">
								{group}
							</SidebarGroupLabel>
							<SidebarMenu className="gap-0.5">
								{matches
									.filter((section) => section.group === group)
									.map(({ to, label, icon: Icon }) => {
										// By path, so a page under a section (one paired machine) keeps it highlighted.
										const path = to.replace("$workspaceId", params.workspaceId);
										const active = pathname === path || pathname.startsWith(`${path}/`);
										return (
											<SidebarMenuItem key={to}>
												<SidebarMenuButton
													asChild
													isActive={active}
													className="h-7 gap-2.5 rounded-lg px-2.5 text-ui font-medium text-ink-muted transition-none hover:bg-selection-subtle hover:text-ink data-[active=true]:bg-selection-current data-[active=true]:font-medium data-[active=true]:text-ink [&>svg]:size-4"
												>
													<Link to={to} params={params} aria-current={active ? "page" : undefined}>
														<Icon size={16} className="shrink-0" aria-hidden />
														<span>{label}</span>
													</Link>
												</SidebarMenuButton>
											</SidebarMenuItem>
										);
									})}
							</SidebarMenu>
						</SidebarGroup>
					))}
					{matches.length === 0 && <p className="px-2 py-2 text-xs text-ink-muted">No Settings Match “{query}”</p>}
				</nav>
			</SidebarContent>
			<SidebarFooter className="flex-row items-center p-2">
				<ConnectionStatus />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}

export function SettingsLayout() {
	const viewport = useRef<HTMLElement>(null);
	useScrollFade(viewport);
	return (
		<main ref={viewport} className="scroll-fade h-full min-h-0 min-w-0 overflow-auto">
			<div>
				<Outlet />
			</div>
		</main>
	);
}
