export function App() {
	return (
		<main className="shell">
			<section className="hero">
				<p className="eyebrow">Electron + React + Vite</p>
				<h1>Hello World</h1>
				<p className="copy">
					This desktop app now uses the same overall UI architecture as T3Code: Electron as the shell, with a
					Vite-powered React frontend rendered inside the window.
				</p>
				<div className="cards" aria-label="stack details">
					<article className="card">
						<span className="cardLabel">Renderer</span>
						<strong>React 19</strong>
					</article>
					<article className="card">
						<span className="cardLabel">Bundler</span>
						<strong>Vite</strong>
					</article>
					<article className="card">
						<span className="cardLabel">Shell</span>
						<strong>Electron</strong>
					</article>
				</div>
			</section>
		</main>
	);
}
