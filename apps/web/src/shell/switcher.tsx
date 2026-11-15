import { StackIcon, XIcon } from "@phosphor-icons/react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { isMac } from "@codeworksh/widget/view";
import { registry } from "../widgets";
import { threadRef } from "../widgets/session/address";
import { useRunDisplay } from "../widgets/session/display";
import { threadKey } from "../widgets/session/schema";
import { runStatesAtom } from "../widgets/session/projects";
import { RunMark } from "../widgets/session/run";
import { chromeAtom, chromeOf, focusedAtom, tabOwnerAtom } from "../wm/chrome";
import { deskAtom, deskKey } from "../wm/instances";
import { deleteTab, updateTab, type Tab, tabRoute, tabsKey, tabTag } from "../wm/tabs";

interface SwitcherProps {
	readonly tabs: readonly Tab[];
	/** The tab on screen; none while settings is open. */
	readonly active: Tab | undefined;
}

/**
 * Tabs, like a browser's: a label that the tab's focused frame decides (its
 * `setTab`), shortened at its end when the bar runs out of room. The active tab is the URL, so a tab is a link.
 * The label is saved with its tab, so after a restart a tab not opened yet still names what it shows.
 */
export function Switcher({ tabs, active }: SwitcherProps) {
	// `shown` is written while rendering the tabs and read back by later renders, which the compiler cannot memoize.
	"use no memo";
	const { instances, order } = useAtomValue(deskAtom);
	const chrome = useAtomValue(chromeAtom);
	const focusedOn = useAtomValue(focusedAtom);
	const owners = useAtomValue(tabOwnerAtom);
	// Each frame's own thread: a fork's tab spins for the fork's run, not its session's main thread.
	const keyOf = (address: string | undefined) => {
		const ref = threadRef(address);
		return ref === undefined ? "" : threadKey(ref);
	};
	const runStates = useAtomValue(runStatesAtom(instances.map((instance) => keyOf(instance.address)).join("\n")));
	const navigate = useNavigate();
	const remove = useAtomSet(deleteTab, { mode: "promise" });
	// No confirm, like a browser tab; closing the one on screen moves to a neighbour first.
	const close = async (tab: Tab, index: number) => {
		if (tab.id === active?.id) {
			const next = tabs[index + 1] ?? tabs[index - 1];
			await navigate(next === undefined ? { to: "/" } : tabRoute(next));
		}
		// The server drops the tab's widgets, so the desk reloads with the list.
		await remove({ payload: { id: tab.id }, reactivityKeys: [...tabsKey, ...deskKey] }).catch(() => undefined);
	};
	// What each tab showed last, kept while a frame that will set the tab is still loading.
	const shown = useRef(new Map<string, string>());
	const showing = (tab: Tab) => {
		const { text } = labelOf(tab);
		shown.current.set(tab.id, text);
		return text;
	};
	/** The tab's label, and whether a frame set it just now (and so it is worth saving). */
	const labelOf = (tab: Tab): { readonly text: string; readonly live: boolean } => {
		const tag = tabTag(tab);
		const onTab = (instance: (typeof instances)[number] | undefined) =>
			instance !== undefined && (instance.tags & tag) !== 0;
		// The frame that claimed the label keeps it while it is still on this tab.
		const owner = instances.find((instance) => instance.id === owners.get(tab.id));
		const claimed = owner !== undefined && onTab(owner) ? chrome.get(owner.id)?.tab : undefined;
		if (claimed !== undefined) return { text: claimed, live: true };
		// Its own last focus once it has been on screen, else its main frame (first in tile order), so
		// focusing a frame shared with another tab never relabels a tab not yet visited.
		const remembered = instances.find((instance) => instance.id === focusedOn.get(tab.id));
		const focused = onTab(remembered)
			? remembered
			: order.tileOrder.map((id) => instances.find((instance) => instance.id === id)).find(onTab);
		if (focused === undefined) return { text: tab.name, live: false };
		const frame = chrome.get(focused.id);
		// The focused frame decides what the tab says; without a say, the tab's name and its title.
		if (frame?.tab !== undefined) return { text: frame.tab, live: true };
		// Before its frame has said anything since a restart, what it said last time.
		if (tab.label !== undefined) return { text: tab.label, live: false };
		const kept = shown.current.get(tab.id);
		if (registry.get(focused.kind)?.ownsTab === true && kept !== undefined) return { text: kept, live: false };
		const title = chromeOf(focused, frame).title;
		// A frame named like its tab adds nothing to the label.
		const text = title.toLowerCase() === tab.name.toLowerCase() ? tab.name : `${tab.name} / ${title}`;
		return { text, live: false };
	};

	// Saves a tab a frame set once it differs from the stored one; the last value sent is remembered,
	// so the list refetch it triggers does not send it again.
	const save = useAtomSet(updateTab);
	const sent = useRef(new Map<string, string>());
	// oxlint-disable-next-line react/refs -- see "use no memo" above.
	const changed = tabs.flatMap((tab) => {
		const { text, live } = labelOf(tab);
		return live && text !== tab.label ? [[tab.id, text] as const] : [];
	});
	useEffect(() => {
		for (const [id, label] of changed) {
			if (sent.current.get(id) === label) continue;
			sent.current.set(id, label);
			save({ payload: { id, label }, reactivityKeys: tabsKey });
		}
	});

	return (
		<nav aria-label="Tabs" className="flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]">
			{/* oxlint-disable-next-line react/refs -- see "use no memo" above. */}
			{tabs.map((tab, index) => {
				const current = tab.id === active?.id;
				const label = showing(tab);
				const threads = instances.flatMap((instance) => {
					const key = keyOf(instance.address);
					return key !== "" && (instance.tags & tabTag(tab)) !== 0
						? [{ key, runState: runStates.get(key) ?? "idle" }]
						: [];
				});
				return (
					<div key={tab.id} className="group/tab relative flex h-tab w-56 min-w-16 shrink basis-56">
						<Link
							{...tabRoute(tab)}
							aria-current={current ? "page" : undefined}
							title={`${label}\n${shortcutLabel(index + 1)}`}
							className={`flex size-full min-w-0 items-center gap-2 rounded-md pr-8 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring ${
								current
									? "bg-selection-current text-ink"
									: "bg-ink/4 text-ink-muted hover:bg-selection hover:text-ink"
							}`}
						>
							<TabIcon threads={threads} current={current} />
							<span className="truncate text-xs font-medium">{label}</span>
						</Link>
						<button
							type="button"
							aria-label={`Close ${tab.name}`}
							title={`Close ${tab.name}`}
							onClick={() => void close(tab, index)}
							className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md text-ink-muted opacity-0 group-hover/tab:opacity-100 hover:bg-ink/8 hover:text-ink focus-visible:opacity-100"
						>
							<XIcon className="size-3.5" aria-hidden />
						</button>
					</div>
				);
			})}
		</nav>
	);
}

/** A tab's icon: the run of the threads on its tab that says most, else a window. */
function TabIcon({
	threads,
	current,
}: {
	readonly threads: Parameters<typeof useRunDisplay>[0];
	readonly current: boolean;
}) {
	const display = useRunDisplay(threads);
	return (
		<span className={`grid size-4 shrink-0 place-items-center ${current ? "text-ink" : "text-ink-muted"}`}>
			<RunMark display={display} idle={<StackIcon className="size-3.5" aria-hidden />} />
		</span>
	);
}

export const shortcutLabel = (position: number) => `${isMac ? "⌘" : "Ctrl+"}${position}`;

const modifier = (event: KeyboardEvent) => !event.altKey && !event.shiftKey && (isMac ? event.metaKey : event.ctrlKey);

/** Cmd+N on macOS, Ctrl+N elsewhere, like switching browser tabs: the Nth tab in order. */
export function tabShortcut(event: KeyboardEvent, tabs: readonly Tab[]): Tab | undefined {
	if (!modifier(event) || !/^[1-9]$/.test(event.key)) return undefined;
	return tabs[Number(event.key) - 1];
}

/** Cmd+, on macOS, Ctrl+, elsewhere: the platform's settings shortcut. */
export const settingsShortcut = (event: KeyboardEvent) => modifier(event) && event.key === ",";

/** Cmd+K on macOS, Ctrl+K elsewhere: the command palette. */
export const paletteShortcut = (event: KeyboardEvent) => modifier(event) && event.key.toLowerCase() === "k";
