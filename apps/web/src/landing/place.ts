import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

/**
 * Where a new project lives: nowhere yet, or a folder on disk. Memory sessions are not offered
 * until they outlive the server that made them; the Session backend can still create them.
 */
export type Place = { kind: "none" } | { kind: "folder"; path: string };

// A folder shows by its name alone; the trigger's tooltip carries the full path.
export const placeLabel = (place: Place) =>
	place.kind === "none" ? "Select Project" : (place.path.split("/").findLast(Boolean) ?? place.path);

/** The start page's folder, kept while the app runs so coming back to the page finds it again. */
export const placeAtom = Atom.make<Place>({ kind: "none" }).pipe(Atom.keepAlive);

const bridge = window.desktopBridge;

/**
 * Picks the start page's folder in the native dialog (Finder on macOS), which opens on the current
 * folder, or home before one is picked. Only the desktop app can open it; absent elsewhere.
 */
export function usePickFolder() {
	const [place, setPlace] = useAtom(placeAtom);
	if (bridge === undefined) return undefined;
	return async () => {
		const picked = await bridge.pickFolder(place.kind === "folder" ? place.path : bridge.home);
		if (picked !== null) setPlace({ kind: "folder", path: picked });
	};
}
