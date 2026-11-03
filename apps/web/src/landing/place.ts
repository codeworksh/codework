import { Atom } from "effect/reactivity";

/**
 * Where a new project lives: nowhere yet, or a folder on disk. Memory sessions are not offered
 * until they outlive the server that made them; the Session backend can still create them.
 */
export type Place = { kind: "none" } | { kind: "folder"; path: string };

// A folder shows by its name alone; the trigger's tooltip carries the full path.
export const placeLabel = (place: Place) =>
	place.kind === "none" ? "New Project" : (place.path.split("/").findLast(Boolean) ?? place.path);

/** The start page's folder, kept while the app runs so coming back to the page finds it again. */
export const placeAtom = Atom.make<Place>({ kind: "none" }).pipe(Atom.keepAlive);
