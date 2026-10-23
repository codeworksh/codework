import type { LucideIcon } from "lucide-react";
import { createContext, type ReactElement, useContext } from "react";

import { isMac } from "./platform";
import type { Params } from "./widget";

/** Where a newly opened widget lands in the tile order. */
export type Placement = "next" | "end";

/**
 * "replace" (default) focuses the address when open, else shows it in a
 * replaceable frame this widget opened earlier, else opens a frame. "new"
 * always opens another frame.
 */
export type OpenMode = "replace" | "new";

export interface OpenOptions {
	/** Opens with this widget kind instead of resolving the address. */
	readonly kind?: string;
	/** "next" (default) lands right after the widget that opened it. */
	readonly placement?: Placement;
	readonly mode?: OpenMode;
	readonly params?: Params;
}

export interface Shell {
	/**
	 * Shows an address with the best widget for it. Focusing an open address
	 * switches workspace if needed.
	 */
	open(address: string, options?: OpenOptions): void;
	/** Focuses an instance; the calling widget by default. */
	focus(instanceId?: string): void;
	/** Closes an instance; the calling widget by default. */
	close(instanceId?: string): void;
}

/** A frame's icon: a Lucide icon, or an element drawn at icon size (a project's badge). */
export type FrameIcon = LucideIcon | ReactElement;

/** What a workspace's tab shows: a title, and a quieter line beneath it. */
export interface Tab {
	readonly title: string;
	readonly subtitle?: string;
}

export interface Frame {
	readonly instanceId: string;
	/**
	 * Replaces the default title; a title too long for the frame is shortened in the middle.
	 * `lead` goes before it, quieter, for what the title belongs to (a session's project).
	 */
	readonly setTitle: (title: string, lead?: string) => void;
	/** Replaces the default icon. */
	readonly setIcon: (icon: FrameIcon) => void;
	/**
	 * What the workspace's tab shows while this frame is the workspace's focused one. Without it the
	 * tab shows the workspace's name over this frame's title.
	 */
	readonly setTab: (tab: Tab) => void;
}

/**
 * The platform's open-in-new convention for a click: Cmd-click on macOS,
 * Ctrl-click elsewhere, or a middle click.
 */
export const openMode = (event: {
	readonly metaKey: boolean;
	readonly ctrlKey: boolean;
	readonly button: number;
}): OpenMode => ((isMac ? event.metaKey : event.ctrlKey) || event.button === 1 ? "new" : "replace");

export const ShellContext = createContext<Shell | null>(null);
export const FrameContext = createContext<Frame | null>(null);

/** A hook's context value, which only a widget rendered by the host has. */
export const required = <A,>(value: A | null, hook: string): A => {
	if (value === null) throw new Error(`${hook} must be called inside a widget`);
	return value;
};

/** Navigation for the calling widget: open addresses, focus and close instances. */
export const useShell = () => required(useContext(ShellContext), "useShell");

/** The calling widget's frame. */
export const useFrame = () => required(useContext(FrameContext), "useFrame");
