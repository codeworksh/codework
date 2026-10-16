import type { LucideIcon } from "lucide-react";
import { Atom } from "effect/reactivity";

import { registry } from "../widgets";
import type { Instance } from "./instances";

/** What a widget set on its frame at runtime; it outranks the instance and definition. */
export interface Chrome {
	readonly title?: string;
	readonly icon?: LucideIcon;
}

/**
 * Runtime frame chrome by instance id. Shared, so the workspace tabs can name what a workspace
 * shows (like a browser tab shows its page's title) while the desktop draws the frames.
 */
export const chromeAtom = Atom.make<ReadonlyMap<string, Chrome>>(new Map()).pipe(Atom.keepAlive);

/**
 * The frame last focused on each workspace (workspace id → instance id). Focus order is one list for
 * the whole desk, so a frame shown on two workspaces would otherwise name both tabs when clicked on one.
 */
export const focusedAtom = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(Atom.keepAlive);

/** A frame's title and icon: what the widget set, else the instance's, else its definition's. */
export function chromeOf(instance: Instance, chrome: Chrome | undefined) {
	const definition = registry.get(instance.kind);
	return {
		title: chrome?.title ?? instance.title ?? definition?.title ?? instance.id,
		icon: chrome?.icon ?? definition?.icon,
	};
}
