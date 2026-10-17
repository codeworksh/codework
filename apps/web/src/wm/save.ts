import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef } from "react";

import { type Desk, deskAtom, loadedDeskAtom, saveDesk, toSaved } from "./instances";

const DELAY = 300;

/**
 * Saves the desk once edits settle, holding off while `paused` (a frame mid-drag). Leaving the page
 * or unmounting saves at once. The desk as loaded, or as last saved, is never sent again.
 */
export function useSaveDesk(paused: boolean) {
	const desk = useAtomValue(deskAtom);
	const loaded = useAtomValue(loadedDeskAtom);
	const save = useAtomSet(saveDesk);
	const latest = useRef({ desk, loaded });
	const sent = useRef<Desk>(undefined);

	useEffect(() => {
		latest.current = { desk, loaded };
	});

	const flush = useCallback(() => {
		const { desk, loaded } = latest.current;
		if (loaded === undefined || desk === loaded || desk === sent.current) return;
		sent.current = desk;
		save({ payload: toSaved(desk) });
	}, [save]);

	useEffect(() => {
		if (paused) return;
		const timer = setTimeout(flush, DELAY);
		return () => clearTimeout(timer);
	}, [desk, paused, flush]);

	useEffect(() => {
		window.addEventListener("pagehide", flush);
		window.addEventListener("beforeunload", flush);
		return () => {
			window.removeEventListener("pagehide", flush);
			window.removeEventListener("beforeunload", flush);
			flush();
		};
	}, [flush]);
}
