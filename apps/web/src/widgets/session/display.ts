import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { RunState } from "@codeworksh/widget/codework";
import { Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

/*
 * What the UI shows for a thread's run: the harness's `run_state`, joined by two states only this
 * window knows. `pending` is a prompt sent whose id is not in app.db yet; `stopping` a stop sent
 * while the run is still going. Both hops (UI to app server, app server to CodeWork) fall under
 * them, so a slow link shows wherever it is.
 */

export type Display = "pending" | "stopping" | RunState;

/** What this window sent a thread that app.db does not show yet. */
interface Sent {
	/** Prompt ids not landed as an inbox or entry row. */
	readonly prompts: ReadonlySet<string>;
	readonly stopping: boolean;
}

const NONE: Sent = { prompts: new Set(), stopping: false };

/** By thread key (`threadKey`); a thread with nothing in flight has no entry. */
const sentAtom = Atom.make<ReadonlyMap<string, Sent>>(new Map()).pipe(Atom.keepAlive);

const update = (map: ReadonlyMap<string, Sent>, key: string, change: (sent: Sent) => Sent) => {
	const before = map.get(key) ?? NONE;
	const after = change(before);
	if (after === before) return map;
	const next = new Map(map);
	if (after.prompts.size === 0 && !after.stopping) next.delete(key);
	else next.set(key, after);
	return next;
};

/** The commands that move a thread's client state: a prompt sent or landed, a stop sent or settled. */
export function useSent() {
	const set = useAtomSet(sentAtom);
	return useMemo(() => {
		const change = (key: string, fn: (sent: Sent) => Sent) => set((map) => update(map, key, fn));
		return {
			prompt: (key: string, id: string) =>
				change(key, (sent) => ({ ...sent, prompts: new Set([...sent.prompts, id]) })),
			/** Prompts that are in app.db now, or were refused. */
			landed: (key: string, ids: Iterable<string>) =>
				change(key, (sent) => {
					const prompts = new Set(sent.prompts);
					for (const id of ids) prompts.delete(id);
					return prompts.size === sent.prompts.size ? sent : { ...sent, prompts };
				}),
			stop: (key: string) => change(key, (sent) => (sent.stopping ? sent : { ...sent, stopping: true })),
			unstop: (key: string) => change(key, (sent) => (sent.stopping ? { ...sent, stopping: false } : sent)),
			forget: (key: string) => change(key, () => NONE),
		};
	}, [set]);
}

/** Prompt ids this window sent the thread that have not landed yet. */
export const usePendingPrompts = (key: string) =>
	useAtomValue(
		sentAtom,
		useCallback((map: ReadonlyMap<string, Sent>) => map.get(key)?.prompts ?? NONE.prompts, [key]),
	);

/** A stop shows until the run is idle, then a prompt still in flight, then the run as stored. */
const displayOf = (sent: Sent | undefined, runState: RunState): Display =>
	sent?.stopping === true && runState !== "idle"
		? "stopping"
		: sent !== undefined && sent.prompts.size > 0
			? "pending"
			: runState;

/** How much a state says, so a tab over several threads shows the one that says most. */
const WEIGHT: Record<Display, number> = { idle: 0, pending: 1, starting: 2, running: 3, stopping: 4 };

const isClient = (display: Display) => display === "pending" || display === "stopping";

/** A client state is drawn only after this long, so a local round trip goes straight to the run. */
const SHOW_AFTER_MS = 200;
/** Once drawn, a client state stays at least this long, so quick transitions do not flicker. */
const HOLD_MS = 300;

/**
 * `display` as drawn: the state changes at once, only drawing a client state waits. Moving onto
 * one waits `SHOW_AFTER_MS`; moving off one waits out its `HOLD_MS`.
 */
export function useDrawn(display: Display): Display {
	const [drawn, setDrawn] = useState({ display, at: 0 });
	const immediate = !isClient(display) && !isClient(drawn.display);
	useEffect(() => {
		if (display === drawn.display) return;
		const held = isClient(drawn.display) ? Math.max(0, HOLD_MS - (Date.now() - drawn.at)) : 0;
		const delay = immediate ? 0 : isClient(display) ? Math.max(SHOW_AFTER_MS, held) : held;
		const draw = () => setDrawn({ display, at: Date.now() });
		if (delay === 0) return draw();
		const timer = setTimeout(draw, delay);
		return () => clearTimeout(timer);
	}, [display, drawn, immediate]);
	return immediate ? display : drawn.display;
}

/**
 * Whether each mounted display reads a thread idle, by thread key. Displays read different copies
 * of `run_state` (the view its thread's updates, a tab and the sidebar the sidebar list, the
 * All Threads its own list), each refreshed on its own; a stop clears once all of them read idle, so
 * no display whose copy still says running draws the run again for the moment between.
 */
const idleBy = new Map<string, Map<symbol, boolean>>();

const isRunState = Schema.is(RunState);

const runStatesOf = (reads: string) => {
	const runStates = new Map<string, RunState>();
	for (const line of reads.split("\n")) {
		const [key = "", runState] = line.split("\t");
		if (key !== "" && isRunState(runState)) runStates.set(key, runState);
	}
	return runStates;
};

/** What to draw for these threads' runs, by key and stored run state: the one that says most. */
export function useRunDisplay(threads: ReadonlyArray<{ readonly key: string; readonly runState: RunState }>) {
	const { unstop } = useSent();
	const [self] = useState(() => Symbol("display"));
	const reads = threads.map(({ key, runState }) => `${key}\t${runState}`).join("\n");
	// Built from `reads`, so callers passing a new array every render keep the same map.
	const runStates = useMemo(() => runStatesOf(reads), [reads]);
	// Only these threads' part of what was sent: a send to any other thread renders nothing here.
	const display = useAtomValue(
		sentAtom,
		useCallback(
			(map: ReadonlyMap<string, Sent>) => {
				let most: Display = "idle";
				for (const [key, runState] of runStates) {
					const next = displayOf(map.get(key), runState);
					if (WEIGHT[next] > WEIGHT[most]) most = next;
				}
				return most;
			},
			[runStates],
		),
	);
	const stopping = useAtomValue(
		sentAtom,
		useCallback(
			(map: ReadonlyMap<string, Sent>) =>
				[...runStates.keys()].filter((key) => map.get(key)?.stopping === true).join("\n"),
			[runStates],
		),
	);
	useEffect(() => {
		const keys = new Set(runStates.keys());
		for (const [key, runState] of runStates) {
			const readers = idleBy.get(key) ?? new Map<symbol, boolean>();
			readers.set(self, runState === "idle");
			idleBy.set(key, readers);
		}
		for (const key of stopping.split("\n"))
			if (keys.has(key) && [...idleBy.get(key)!.values()].every(Boolean)) unstop(key);
		return () => {
			for (const key of keys) {
				const readers = idleBy.get(key);
				readers?.delete(self);
				if (readers?.size === 0) idleBy.delete(key);
			}
		};
	}, [runStates, stopping, self, unstop]);
	return useDrawn(display);
}

/** The words for a display, for labels and screen readers. */
export const displayLabel: Record<Display, string> = {
	idle: "Idle",
	pending: "Sending",
	starting: "Starting",
	running: "Agent working",
	stopping: "Stopping",
};
