import { Atom } from "effect/reactivity";

/**
 * Where a new project lives: nowhere yet, or a folder on a machine, by its row id, the default
 * machine's too: a later change of default does not move the folder. Memory sessions are not
 * offered until they outlive the server that made them; the Session backend can still create them.
 */
export type Place =
	| { kind: "none" }
	| {
			kind: "folder";
			path: string;
			machineId: string;
			/** The project's name, when it is one already. */ name?: string;
	  };

// A project shows by its name, else its folder's; the trigger's tooltip carries the full path.
export const placeLabel = (place: Place) =>
	place.kind === "none" ? "Add Project" : (place.name ?? place.path.split("/").findLast(Boolean) ?? place.path);

/** The start page's folder, kept while the app runs so coming back to the page finds it again. */
export const placeAtom = Atom.make<Place>({ kind: "none" }).pipe(Atom.keepAlive);

/**
 * The machine the start page starts sessions on, by its row id; none is the default machine. A
 * machine that can't run a session any more falls back to the default one where it is read.
 */
export const machineAtom = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);
