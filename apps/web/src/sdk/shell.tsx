import { createContext, useContext } from "react";

import { isMac } from "../kernel/platform";
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

export interface Frame {
	readonly instanceId: string;
	/** Replaces the frame title until the widget closes. */
	readonly setTitle: (title: string) => void;
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

const required = <A,>(value: A | null, hook: string): A => {
	if (value === null) throw new Error(`${hook} must be called inside a widget`);
	return value;
};

/** Navigation for the calling widget: open addresses, focus and close instances. */
export const useShell = () => required(useContext(ShellContext), "useShell");

/** The calling widget's frame. */
export const useFrame = () => required(useContext(FrameContext), "useFrame");
