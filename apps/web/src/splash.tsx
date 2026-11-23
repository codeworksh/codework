import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { isSignedInApp } from "./auth";
import { serversAtom } from "./kernel/servers";
import { settledAtom } from "./setup";

// A status that is slow to come is shown when it comes; the app does not wait longer for it.
const LONGEST = 2_000;

/** Fades the splash in index.html away; it is gone once the fade ends. */
export function reveal() {
	const shell = document.getElementById("boot-shell");
	if (shell === null || shell.classList.contains("done")) return;
	shell.classList.add("done");
	const remove = () => shell.remove();
	shell.addEventListener("transitionend", remove, { once: true });
	// No transition runs with reduced motion, nor in a window that is hidden.
	setTimeout(remove, 400);
}

/**
 * Keeps the splash up over the mounted app until the servers' status first arrives and the setup check
 * has opened the first page, so the first frame shown is the page that stays. Reading the status starts it.
 */
export function Splash() {
	const status = useAtomValue(serversAtom);
	const settled = useAtomValue(settledAtom);
	// Without sign-in there is no setup check to wait for.
	const known = status._tag !== "Initial" && (settled || !isSignedInApp);
	useEffect(() => {
		if (known) return reveal();
		const timer = setTimeout(reveal, LONGEST);
		return () => clearTimeout(timer);
	}, [known]);
	return null;
}
