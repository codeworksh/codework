import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
	component: RootLayout,
});

function RootLayout() {
	return (
		<div className="app-shell">
			<header className="app-header">
				<div>
					<p className="eyebrow">Codework desktop</p>
					<h1>Electron shell, React renderer</h1>
				</div>
				<nav className="app-nav" aria-label="Primary">
					<Link to="/" className="nav-link" activeProps={{ className: "nav-link nav-link-active" }}>
						Overview
					</Link>
					<Link
						to="/concepts"
						className="nav-link"
						activeProps={{ className: "nav-link nav-link-active" }}
					>
						Concepts
					</Link>
				</nav>
			</header>
			<main className="app-main">
				<Outlet />
			</main>
		</div>
	);
}
