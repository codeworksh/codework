import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback, useContext, useEffect, useRef } from "react";

import { type Desk, deskAtom, loadedDeskAtom, saveDesk, toSaved } from "./instances";

const DELAY = 300;

/**
 * Saves the desk once edits settle, holding off while `paused` (a frame mid-drag). Leaving the page
 * or unmounting saves at once. The desk as loaded, or as last saved, is never sent again. The
 * returned `flush` saves the desk now.
 */
export function useSaveDesk(paused: boolean) {
	const desk = useAtomValue(deskAtom);
	const registry = useContext(RegistryContext);
	const save = useAtomSet(saveDesk, { mode: "promise" });
	const sent = useRef<Desk>(undefined);
	// One save at a time, in order: a later desk must never be overwritten by an earlier one landing late.
	const queue = useRef(Promise.resolve());

	// Read from the registry, not a render: a desk just set, or set after unmounting, has not rendered.
	const flush = useCallback(() => {
		const next = registry.get(deskAtom);
		const loaded = registry.get(loadedDeskAtom);
		if (loaded === undefined || next === loaded || next === sent.current) return queue.current;
		sent.current = next;
		queue.current = queue.current.then(() =>
			save({ payload: toSaved(next) }).then(
				() => undefined,
				() => undefined,
			),
		);
		return queue.current;
	}, [registry, save]);

	useEffect(() => {
		if (paused) return;
		const timer = setTimeout(() => void flush(), DELAY);
		return () => clearTimeout(timer);
	}, [desk, paused, flush]);

	useEffect(() => {
		const now = () => void flush();
		window.addEventListener("pagehide", now);
		window.addEventListener("beforeunload", now);
		return () => {
			window.removeEventListener("pagehide", now);
			window.removeEventListener("beforeunload", now);
			now();
		};
	}, [flush]);

	return flush;
}
