import { RegistryContext } from "@effect/atom-react";
import { HostContext, type Shell, ShellContext } from "@codeworksh/widget/view";
import { ListTodo } from "lucide-react";
import { useContext, useLayoutEffect, useMemo, useRef } from "react";

import { makeHost } from "../../kernel/host";
import { useOpenElsewhere } from "../../wm/open";
import { AllThreads } from "./threads";

/** The page's own instance, so its display options keep apart from any frame's. */
const PAGE = "page";

/** All Threads as a page of its own, outside any workspace; a thread opens in one as the sidebar opens it. */
export function ThreadsPage() {
	const registry = useContext(RegistryContext);
	const host = useMemo(() => makeHost({ registry, package: "codework", instanceId: PAGE }), [registry]);
	const openElsewhere = useOpenElsewhere();
	// Read through a ref, so the shell stays stable while the desk changes.
	const opener = useRef(openElsewhere);
	useLayoutEffect(() => {
		opener.current = openElsewhere;
	});
	const shell = useMemo<Shell>(
		() => ({
			open: (address, options) => void opener.current(address, "Threads", options?.mode ?? "replace"),
			focus: () => {},
			close: () => {},
		}),
		[],
	);
	return (
		<ShellContext value={shell}>
			<HostContext value={host}>
				<div className="flex h-full min-h-0 flex-col">
					<header className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-4">
						<ListTodo className="size-4 text-ink-muted" strokeWidth={1.75} aria-hidden />
						<h1 className="text-ui font-medium text-ink">All Threads</h1>
					</header>
					<div className="min-h-0 flex-1">
						<AllThreads instanceId={PAGE} props={{}} address={undefined} params={{}} />
					</div>
				</div>
			</HostContext>
		</ShellContext>
	);
}
