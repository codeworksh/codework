import { RegistryProvider } from "@effect/atom-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserHistory, createHashHistory, RouterProvider } from "@tanstack/react-router";

import { isElectron } from "./env";
import { getRouter } from "./router";
import "./style.css";

// Electron loads the app from a file-backed shell, so hash history avoids path
// resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();
const router = getRouter(history);

// The app mounts once the first route's split chunks have loaded, so it is whole when the splash
// over it fades (see Splash).
export const startup = router.load().then(() => {
	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<RegistryProvider>
				<RouterProvider router={router} />
			</RegistryProvider>
		</React.StrictMode>,
	);
});
