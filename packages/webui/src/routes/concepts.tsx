import { createFileRoute } from "@tanstack/react-router";

const concepts = [
	{
		title: "Main process",
		copy: "Owns the native app lifecycle, windows, menus, process spawning, and privileged OS access.",
	},
	{
		title: "Preload bridge",
		copy: "Defines the safe API surface shared with the renderer through context isolation.",
	},
	{
		title: "Renderer app",
		copy: "A regular React app that can focus on routing, state, and UX without direct Node access.",
	},
	{
		title: "Why hash routing in Electron",
		copy: "The production renderer is loaded from a local HTML file. Hash routes avoid path resolution problems that browser history would create there.",
	},
];

export const Route = createFileRoute("/concepts")({
	component: ConceptsRoute,
});

function ConceptsRoute() {
	return (
		<section className="stack">
			<header className="section-header">
				<p className="eyebrow">Build Order</p>
				<h2>Concepts we’ll layer in next</h2>
				<p className="copy">
					We’re keeping the renderer intentionally small. Server startup, auth bootstrap, and streaming transport
					belong in the next iterations, after this shell is stable.
				</p>
			</header>

			<div className="concept-list">
				{concepts.map((concept) => (
					<article key={concept.title} className="panel">
						<h3>{concept.title}</h3>
						<p className="copy">{concept.copy}</p>
					</article>
				))}
			</div>
		</section>
	);
}
