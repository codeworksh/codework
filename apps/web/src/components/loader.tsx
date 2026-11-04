const pixels = [
	[0, 0],
	[6, 0],
	[12, 0],
	[12, 6],
	[12, 12],
	[6, 12],
	[0, 12],
	[0, 6],
] as const;

export function PixelLoader() {
	return (
		<svg viewBox="0 0 16 16" className="size-3" fill="currentColor" shapeRendering="crispEdges" aria-hidden>
			{pixels.map(([x, y], index) => (
				<rect
					key={`${x},${y}`}
					x={x}
					y={y}
					width="4"
					height="4"
					className="pixel-loader-cell"
					style={{ animationDelay: `${index * 120 - 960}ms`, opacity: 1 - index / 10 }}
				/>
			))}
		</svg>
	);
}
