import { createContext, useContext } from "react";

import type { Params } from "./widget";

/** Where a newly opened widget lands in the tile order. */
export type Placement = "next" | "end";

export interface OpenOptions {
	/** Opens with this widget kind instead of resolving the address. */
	readonly kind?: string;
	/** "next" (default) lands right after the widget that opened it. */
	readonly placement?: Placement;
	/** Opens another copy even when the address is already open. */
	readonly fresh?: boolean;
	readonly params?: Params;
}

export interface Shell {
	/**
	 * Shows an address. An address already open is focused, switching
	 * workspace if needed; otherwise the best widget for it opens here.
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
