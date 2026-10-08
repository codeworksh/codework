import { DEPTH, outlineOf, type Glyph } from "./wordmark";

/** Crisp SVG cells, with optional outline echoes behind the wordmark. */
export function Pixels({ glyph, depth = false, className }: { glyph: Glyph; depth?: boolean; className?: string }) {
	const outline = depth
		? outlineOf(glyph)
				.map(({ x1, y1, x2, y2 }) => `M${x1} ${y1}L${x2} ${y2}`)
				.join(" ")
		: "";
	return (
		<svg
			viewBox={`0 0 ${glyph.width} ${glyph.height}`}
			shapeRendering="crispEdges"
			aria-hidden="true"
			className={className}
		>
			{depth &&
				DEPTH.map(({ offset, ink }) => (
					<path
						key={offset}
						d={outline}
						transform={`translate(${offset} ${offset})`}
						fill="none"
						stroke={`var(--t-field-${ink})`}
						strokeWidth={0.08}
					/>
				))}
			{glyph.rows.flatMap((bits, y) =>
				[...bits.matchAll(/1+|2+/g)].map((run) => (
					<rect
						key={`${y}-${run.index}`}
						x={run.index}
						y={y}
						width={run[0].length}
						height={1}
						fill={run[0][0] === "2" ? "var(--t-field-crest)" : "currentColor"}
					/>
				)),
			)}
		</svg>
	);
}
