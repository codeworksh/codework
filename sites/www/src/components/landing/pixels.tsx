import { bandOf, type Glyph } from "./wordmark";

/** A glyph as crisp SVG cells: banded like the hero word, or flat in the current colour. */
export function Pixels({ glyph, banded = false, className }: { glyph: Glyph; banded?: boolean; className?: string }) {
	return (
		<svg
			viewBox={`0 0 ${glyph.width} ${glyph.height}`}
			shapeRendering="crispEdges"
			aria-hidden="true"
			className={className}
		>
			{glyph.rows.flatMap((bits, y) =>
				[...bits.matchAll(/1+/g)].map((run) => (
					<rect
						key={`${y}-${run.index}`}
						x={run.index}
						y={y}
						width={run[0].length}
						height={1}
						fill={banded ? `var(--t-field-${bandOf(y, glyph.height)})` : "currentColor"}
					/>
				)),
			)}
		</svg>
	);
}
