import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Tab } from "@codeworksh/contract";
import { Atom, AsyncResult } from "effect/reactivity";
import { useContext } from "react";
import { tagBit } from "webwm";

import { runQuery, Server } from "../kernel/rpc";

export type { Tab };

/** webwm tag bits available, and so the Cmd+1–9 keys; the server enforces it too. */
export const MAX_TABS = 9;

/** Every mutation names this key, so the list refetches after any change. */
export const tabsKey = ["tabs"];

export const tabsAtom = Server.query("tabs.list", undefined, { reactivityKeys: tabsKey });

const createTab = Server.mutation("tabs.create");
export const updateTab = Server.mutation("tabs.update");
export const reorderTabs = Server.mutation("tabs.reorder");
// Kept alive so a delete started as the desktop unmounts (its last frame closed) still lands.
export const deleteTab = Server.mutation("tabs.delete").pipe(Atom.keepAlive);

/** Tabs in switcher order; empty until the server answers. */
export function useTabs(): readonly Tab[] {
	const result = useAtomValue(tabsAtom);
	return AsyncResult.isSuccess(result) ? result.value : [];
}

/** webwm tag mask for the widgets shown on a tab. */
export const tabTag = (tab: Tab) => tagBit(tab.bit);

export const tabRoute = (tab: Tab) => ({ to: "/tabs/$tabId", params: { tabId: tab.id } }) as const;

/** The tab last on screen, for opening things from outside the desktop (the start page). */
export const lastTabAtom = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

/** Settings returns to the last tab still present, or Home when there is none. */
export function useTabReturn() {
	const lastId = useAtomValue(lastTabAtom);
	const tab = useTabs().find(({ id }) => id === lastId);
	return tab === undefined ? { to: "/" as const } : tabRoute(tab);
}

/** A tab route that, once shown, opens `address` there (see the route's `open` search). */
export const openInTabRoute = (tab: Tab, address: string, mode: "replace" | "new") =>
	({
		...tabRoute(tab),
		search: { open: address, ...(mode === "new" ? { mode: "new" as const } : {}) },
	}) as const;

/**
 * Creates a tab and resolves once the shared list includes it. Going to it before then would
 * find a stale list: the shell shows nothing, or sends an empty-looking app back to the start page.
 */
export function useCreateTab() {
	const registry = useContext(RegistryContext);
	const create = useAtomSet(createTab, { mode: "promise" });
	return async (payload: { readonly name: string; readonly auto?: boolean }) => {
		const tab = await create({ payload, reactivityKeys: tabsKey });
		await runQuery(registry, tabsAtom);
		return tab;
	};
}
