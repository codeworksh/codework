import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createBrowserHistory, createHashHistory } from "@tanstack/react-router";
import { getRouter } from "./router.tsx";
import { isElectron } from "./platform.ts";
import "./styles.css";

const history = isElectron ? createHashHistory() : createBrowserHistory();
const router = getRouter(history);

document.title = "Codework";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<RouterProvider router={router} />
	</React.StrictMode>,
);
