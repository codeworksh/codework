import type { Schema } from "effect";
import { createContext, useContext, useEffect, useRef } from "react";

import type { Event, Publish, Request, Synced } from "../event";
import { required } from "./shell";

/**
 * The event log as a view sees it. The host stamps `source` with the calling instance, and a
 * view publishes only under its own package's topics.
 */
export interface Bus {
	publish(input: Omit<Publish, "source">): Promise<Event>;
	/** Publishes a request and resolves with its reply; rejects when none arrives in time. */
	request(input: Omit<Request, "source">): Promise<Event>;
	/**
	 * Calls `onItem` with the stored events after `after`, then `Synced`, then each live event.
	 * Without `after` nothing is replayed. Returns the unsubscribe.
	 */
	subscribe(
		input: { readonly topics: ReadonlyArray<string>; readonly after?: number | undefined },
		onItem: (item: Event | Synced) => void,
	): () => void;
}

/** JSON storage scoped to the widget's package. */
export interface Kv {
	get(key: string): Promise<Schema.Json | undefined>;
	set(key: string, value: Schema.Json): Promise<void>;
}

export interface Host {
	readonly bus: Bus;
	readonly kv: Kv;
}

export const HostContext = createContext<Host | null>(null);

export const useBus = () => required(useContext(HostContext), "useBus").bus;

export const useKv = () => required(useContext(HostContext), "useKv").kv;

/**
 * Subscribes while mounted; `undefined` holds off, e.g. until a snapshot says where to start.
 * Changing the topics or `after` resubscribes.
 */
export function useEvents(
	input: { readonly topics: ReadonlyArray<string>; readonly after?: number | undefined } | undefined,
	onItem: (item: Event | Synced) => void,
) {
	const bus = useBus();
	const handler = useRef(onItem);
	useEffect(() => {
		handler.current = onItem;
	});
	const topics = input?.topics.join("\n");
	const after = input?.after;
	useEffect(() => {
		if (topics === undefined) return;
		return bus.subscribe({ topics: topics.split("\n"), after }, (item) => handler.current(item));
	}, [bus, topics, after]);
}
