import { Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

/** Settings replaces the sessions list within the same app shell and sidebar controls. */
export function SettingsSidebar() {
	const matchRoute = useMatchRoute();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const matches = search(query);
	const groups = [...new Set(matches.map((section) => section.group))];
	return (
		<Sidebar collapsible="offcanvas" className="shell-sidebar select-none">
			<SidebarHeader className="gap-1 px-2 pt-2 pb-2">
				<h1 className="flex h-8 items-center px-2.5 text-[13px] font-semibold text-ink">Settings</h1>
				<div className="relative">
					<Search
						className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted"
						aria-hidden
					/>
					<SidebarInput
						type="search"
						placeholder="Search"
						aria-label="Search settings"
						value={query}
						className="h-8 rounded-lg border-transparent bg-transparent pl-8 text-[13px] shadow-none focus-visible:bg-ink/5"
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
			<SidebarContent className="px-2 pb-2">
				<nav aria-label="Settings navigation">
					{groups.map((group) => (
						<SidebarGroup key={group} className="px-0">
							<SidebarGroupLabel className="px-2.5 text-[11px] text-ink-muted">{group}</SidebarGroupLabel>
							<SidebarMenu>
								{matches
									.filter((section) => section.group === group)
									.map(({ to, label, icon: Icon }) => {
										const current = matchRoute({ to }) !== false;
										return (
											<SidebarMenuItem key={to}>
												<SidebarMenuButton
													asChild
													isActive={current}
													className="h-8 rounded-lg px-2.5 text-[13px] text-ink-muted data-[active=true]:bg-ink/8 data-[active=true]:text-ink"
												>
													<Link to={to} aria-current={current ? "page" : undefined}>
														<Icon className="size-4" strokeWidth={1.5} aria-hidden />
														<span>{label}</span>
													</Link>
												</SidebarMenuButton>
											</SidebarMenuItem>
										);
									})}
							</SidebarMenu>
						</SidebarGroup>
					))}
					{matches.length === 0 && (
						<p className="px-2.5 py-2 text-[12px] text-ink-muted">No settings match “{query}”.</p>
					)}
				</nav>
			</SidebarContent>
			<SidebarRail />
		</Sidebar>
	);
}

export function SettingsLayout() {
	const viewport = useRef<HTMLElement>(null);
	const content = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = viewport.current;
		const body = content.current;
		if (element === null || body === null) return;
		const update = () => {
			element.style.setProperty("--scroll-top", element.scrollTop > 1 ? "transparent" : "black");
			element.style.setProperty(
				"--scroll-bottom",
				element.scrollTop + element.clientHeight < element.scrollHeight - 1 ? "transparent" : "black",
			);
		};
		const observer = new ResizeObserver(update);
		observer.observe(element);
		observer.observe(body);
		element.addEventListener("scroll", update, { passive: true });
		update();
		return () => {
			observer.disconnect();
			element.removeEventListener("scroll", update);
		};
	}, []);
	return (
		<main ref={viewport} className="settings-scroll h-full min-h-0 min-w-0 overflow-auto">
			<div ref={content}>
				<Outlet />
			</div>
		</main>
	);
}
