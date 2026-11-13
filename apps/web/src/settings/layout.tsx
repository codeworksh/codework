import { ArrowLeftIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";

import { useRef, useState } from "react";
import { useScrollFade } from "@/hooks/use-scroll-fade";

import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInput,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "@/components/ui/sidebar";
import { search } from "./sections";
import { useWorkspaceReturn } from "../wm/workspaces";

/** Settings replaces the sessions list within the same app shell and sidebar controls. */
export function SettingsSidebar() {
	const matchRoute = useMatchRoute();
	const navigate = useNavigate();
	const back = useWorkspaceReturn();
	const [query, setQuery] = useState("");
	const matches = search(query);
	const groups = [...new Set(matches.map((section) => section.group))];
	return (
		<Sidebar collapsible="offcanvas" className="shell-sidebar select-none">
			<SidebarHeader className="gap-0.5 px-2 pt-2 pb-2">
				<Link
					{...back}
					className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-ui text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ArrowLeftIcon size={15} className="shrink-0" aria-hidden />
					<span>Back to app</span>
				</Link>
				<div className="relative">
					<MagnifyingGlassIcon
						size={15}
						className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-muted"
						aria-hidden
					/>
					<SidebarInput
						type="search"
						placeholder="Search"
						aria-label="Search settings"
						value={query}
						className="h-7 rounded-md border-0 bg-transparent pr-2 pl-[30px] text-ui shadow-none dark:bg-transparent placeholder:text-ink-muted hover:bg-selection-subtle focus-visible:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring"
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							const first = matches[0];
							if (event.key === "Enter" && first !== undefined) void navigate({ to: first.to });
							if (event.key === "Escape" && query !== "") {
								event.preventDefault();
								setQuery("");
							}
						}}
					/>
				</div>
			</SidebarHeader>
			<SidebarContent className="gap-0 px-2 pb-2">
				<nav aria-label="Settings navigation" className="flex flex-col gap-3 pt-1">
					{groups.map((group) => (
						<SidebarGroup key={group} className="p-0">
							<SidebarGroupLabel className="h-6 px-2 text-2xs font-medium text-ink-muted/75">
								{group}
							</SidebarGroupLabel>
							<SidebarMenu className="gap-0.5">
								{matches
									.filter((section) => section.group === group)
									.map(({ to, label, icon: Icon }) => {
										const current = matchRoute({ to }) !== false;
										return (
											<SidebarMenuItem key={to}>
												<SidebarMenuButton
													asChild
													isActive={current}
													className="h-7 gap-2 rounded-md px-2 text-ui text-ink-muted transition-none hover:bg-selection-subtle hover:text-ink data-[active=true]:bg-selection-current data-[active=true]:font-medium data-[active=true]:text-ink [&>svg]:size-[15px]"
												>
													<Link to={to} aria-current={current ? "page" : undefined}>
														<Icon size={15} className="shrink-0" aria-hidden />
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
