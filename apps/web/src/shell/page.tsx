import { RegistryContext } from "@effect/atom-react";
import { HostContext, type Shell, ShellContext } from "@codeworksh/widget/view";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, useContext, useLayoutEffect, useMemo, useRef } from "react";

import { makeHost } from "../kernel/host";
import { useOpenElsewhere } from "../wm/open";

/**
 * A page of its own, outside any workspace, with a widget's host so a widget's view can run on it:
 * `instanceId` keeps its saved state apart from any frame's, and what it opens goes to a workspace
 * as the sidebar opens sessions.
 */
export function Page({
	instanceId,
	title,
	icon: Icon,
	children,
}: {
	readonly instanceId: string;
	readonly title: string;
	readonly icon: LucideIcon;
	readonly children: ReactNode;
}) {
	const registry = useContext(RegistryContext);
	const host = makeHost({ registry, package: "codework", instanceId });
	const openElsewhere = useOpenElsewhere();
	// Read through a ref, so the shell stays stable while the desk changes.
	const opener = useRef(openElsewhere);
	useLayoutEffect(() => {
		opener.current = openElsewhere;
	});
	const shell = useMemo<Shell>(
		() => ({
			open: (address, options) => void opener.current(address, title, options?.mode ?? "replace"),
			focus: () => {},
			close: () => {},
		}),
		[title],
	);
	return (
		<ShellContext value={shell}>
			<HostContext value={host}>
				<div className="flex h-full min-h-0 flex-col">
					<header className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-4">
						<Icon className="size-4 text-ink-muted" strokeWidth={1.75} aria-hidden />
						<h1 className="text-ui font-medium text-ink">{title}</h1>
					</header>
					<div className="min-h-0 flex-1">{children}</div>
				</div>
			</HostContext>
		</ShellContext>
	);
}
