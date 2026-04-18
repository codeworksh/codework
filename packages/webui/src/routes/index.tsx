import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isElectron } from "../platform.ts";

type AppInfo = {
	name: string;
	version: string;
	platform: string;
};

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function HomeRoute() {
	const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

	useEffect(() => {
		if (!window.desktop) {
			return;
		}

		void window.desktop.getAppInfo().then((info) => {
			setAppInfo(info);
		});
	}, []);

	return (
		<section className="panel-grid">
			<article className="panel panel-hero">
				<p className="eyebrow">Initial Slice</p>
				<h2>Web UI lives outside Electron now</h2>
				<p className="copy">
					This mirrors the T3Code direction that matters for us: Electron owns the native shell, and the actual
					app UI is a separate TanStack Router React app loaded inside it.
				</p>
			</article>

			<article className="panel">
				<h3>Renderer Routing</h3>
				<p className="copy">
					The app uses TanStack Router file routes. Inside Electron it switches to hash history so deep links
					work from a file-backed renderer build.
				</p>
				<code className="inline-code">{isElectron ? "createHashHistory()" : "createBrowserHistory()"}</code>
			</article>

			<article className="panel">
				<h3>Main ↔ Preload ↔ Renderer</h3>
				<p className="copy">
					The renderer only talks to Electron through the preload bridge. That keeps Node APIs out of React and
					gives us a clean place to add server/auth APIs next.
				</p>
				{appInfo ? (
					<dl className="meta-list">
						<div>
							<dt>App</dt>
							<dd>{appInfo.name}</dd>
						</div>
						<div>
							<dt>Version</dt>
							<dd>{appInfo.version}</dd>
						</div>
						<div>
							<dt>Platform</dt>
							<dd>{appInfo.platform}</dd>
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
