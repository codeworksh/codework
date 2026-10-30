import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { serversAtom } from "./kernel/servers";

// A status that is slow to come is shown when it comes; the app does not wait longer for it.
const LONGEST = 2_000;

/** Fades the splash in index.html away; it is gone once the fade ends. */
function reveal() {
	const shell = document.getElementById("boot-shell");
	if (shell === null || shell.classList.contains("done")) return;
	shell.classList.add("done");
	const remove = () => shell.remove();
	shell.addEventListener("transitionend", remove, { once: true });
	// No transition runs with reduced motion, nor in a window that is hidden.
	setTimeout(remove, 400);
}

/**
 * Keeps the splash up over the mounted app until the servers' status first arrives, so the first
 * frame shown already says whether the default server works. Reading the status starts it.
 */
export function Splash() {
	const known = useAtomValue(serversAtom)._tag !== "Initial";
	useEffect(() => {
		if (known) return reveal();
		const timer = setTimeout(reveal, LONGEST);
		return () => clearTimeout(timer);
	}, [known]);
	return null;
}
