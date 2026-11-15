import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";

import type { OpenMode } from "@codeworksh/widget/view";
import { deskAtom } from "./instances";
import { lastTabAtom, MAX_TABS, openInTabRoute, useCreateTab, useTabs, type Tab, tabTag } from "./tabs";

/** Where to open: in a frame (`OpenMode`), or in a tab of its own. */
export type Placement = OpenMode | "tab";

/**
 * Opens an address from outside a frame (the sidebar, the start page), picking its tab:
 * 1. where it is already open (the frame looked at last), unless a new tab is asked for,
 * 2. else the tab on screen,
 * 3. else the last-used tab if it shows nothing,
 * 4. else a new auto tab named `name` while fewer than nine exist,
 * 5. else the last-used tab.
 * A "tab" placement skips to 4. The tab then opens it (see the route's `open`
 * search); `mode` "new" asks for a new frame.
 */
export function useOpenElsewhere() {
	const tabs = useTabs();
	const { instances, order } = useAtomValue(deskAtom);
	const lastId = useAtomValue(lastTabAtom);
	const { tabId: currentId } = useParams({ strict: false });
	const create = useCreateTab();
	const navigate = useNavigate();

	return async (address: string, name: string, placement: Placement) => {
		const mode: OpenMode = placement === "tab" ? "new" : placement;
		const go = (tab: Tab) => navigate(openInTabRoute(tab, address, mode));
		const shows = (tab: Tab) => instances.filter((instance) => (instance.tags & tabTag(tab)) !== 0);
		const last = tabs.find((tab) => tab.id === lastId) ?? tabs[0];

		if (placement !== "tab") {
			const recent = order.focusOrder.flatMap((id) => instances.find((instance) => instance.id === id) ?? []);
			const open = recent.find((instance) => instance.address === address);
			const home = open && tabs.find((tab) => (open.tags & tabTag(tab)) !== 0);
			if (home !== undefined) return go(home);

			const current = tabs.find((tab) => tab.id === currentId);
			if (current !== undefined) return go(current);

			if (last !== undefined && shows(last).length === 0) return go(last);
		}

		if (tabs.length < MAX_TABS) {
			const created = await create({ name, auto: true }).catch(() => undefined);
			if (created !== undefined) return go(created);
		}
		if (last !== undefined) return go(last);
	};
}
