import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "@codeworksh/bridge";
import { isElectron } from "../env";
import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function HomeRoute() {
	const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);

	useEffect(() => {
		const bridge = window.desktopBridge;
		if (!bridge) {
			return;
		}

		void bridge.getUpdateState().then((state) => {
			setUpdateState(state);
		});

		return bridge.onUpdateState((state) => {
			setUpdateState(state);
		});
	}, []);

	return (
		<section className="panel-grid">
			<article className="panel panel-hero">
				<p className="eyebrow">Initial Slice</p>
				<h2>Web UI lives outside Electron now</h2>
				<p className="copy">
					This mirrors the T3Code direction that matters for us: Electron owns the native shell, and the actual app
					UI is a separate TanStack Router React app loaded inside it.
				</p>
			</article>

			<article className="panel">
				<h3>Renderer Routing</h3>
				<p className="copy">
					The app uses TanStack Router file routes. Inside Electron it switches to hash history so deep links work
					from a file-backed renderer build.
				</p>
				<code className="inline-code">{isElectron ? "createHashHistory()" : "createBrowserHistory()"}</code>
			</article>

			<article className="panel">
				<h3>Main ↔ Preload ↔ Renderer</h3>
				<p className="copy">
					The renderer only talks to Electron through the preload bridge. That keeps Node APIs out of React and now
					exposes the same desktop branding/update shape we want to keep growing toward T3Code.
				</p>
				{updateState ? (
					<dl className="meta-list">
						<div>
							<dt>App</dt>
							<dd>{APP_DISPLAY_NAME}</dd>
						</div>
						<div>
							<dt>Version</dt>
							<dd>{APP_VERSION}</dd>
						</div>
						<div>
							<dt>Update Channel</dt>
							<dd>{updateState.channel}</dd>
						</div>
						<div>
							<dt>Update Status</dt>
							<dd>{updateState.status}</dd>
						</div>
					</dl>
				) : (
					<p className="muted">Waiting for preload bridge…</p>
				)}
			</article>

			<article className="panel">
				<h3>Next Build Step</h3>
				<p className="copy">
					Add our own local server process in the main process, then expose just enough IPC for auth/bootstrap so
					the web app can connect without importing Electron internals.
				</p>
			</article>
		</section>
	);
}
