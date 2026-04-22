import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./styles.css";

import { isElectron } from "./env.ts";
import { getRouter } from "./router.tsx";
import { APP_DISPLAY_NAME } from "./branding.ts";
import { initializeThemeSync } from "./lib/theme.ts";
import { syncDocumentWindowControlsOverlayClass } from "./lib/window-controls-overlay.ts";

const MIN_BOOT_SHELL_MS = 700;
const BOOT_SHELL_FADE_MS = 200;

function dismissBootShell(): void {
	const bootShell = document.getElementById("boot-shell");

	if (!bootShell || bootShell.dataset.state) {
		return;
	}

	bootShell.dataset.state = "scheduled";

	const startedAt = Number(document.documentElement.dataset.bootShellStartedAt);
	const elapsed = Number.isFinite(startedAt) ? performance.now() - startedAt : MIN_BOOT_SHELL_MS;
	const remaining = Math.max(0, MIN_BOOT_SHELL_MS - elapsed);

	window.setTimeout(() => {
		bootShell.dataset.state = "leaving";
		bootShell.classList.add("is-leaving");

		window.setTimeout(() => {
			bootShell.remove();
		}, BOOT_SHELL_FADE_MS);
	}, remaining);
}

function BootShellDismissal() {
	React.useEffect(() => {
		dismissBootShell();
	}, []);

	return null;
}

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();
const router = getRouter(history);

initializeThemeSync();

if (isElectron) {
	syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<BootShellDismissal />
		<RouterProvider router={router} />
	</React.StrictMode>,
);
