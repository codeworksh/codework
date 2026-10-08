/** C and terminal cursor, drawn on the site's pixel grid in theme ink. */
export function Logo({ className = "", label }: { className?: string; label?: string }) {
	return (
		<svg
			viewBox="0 0 10 10"
			shapeRendering="crispEdges"
			className={`inline-block shrink-0 align-middle text-brand ${className}`}
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			<path fill="currentColor" d="M0 0h10v2H2v6h8v2H0Z" />
			<rect x="8" y="4" width="2" height="2" fill="var(--t-field-crest, currentColor)" />
		</svg>
	);
}
