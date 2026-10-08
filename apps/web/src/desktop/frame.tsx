import type { Rect } from "webwm";

interface FrameProps {
	readonly title: string;
	readonly rect: Rect;
	readonly focused: boolean;
	readonly onFocus: () => void;
}

export function Frame({ title, rect, focused, onFocus }: FrameProps) {
	return (
		<article
			className="group absolute top-0 left-0 box-border p-1"
			data-focused={focused}
			style={{ width: rect.w, height: rect.h, transform: `translate(${rect.x}px, ${rect.y}px)` }}
			onPointerDown={onFocus}
		>
			{/* Continuous (squircle-like) corners need a larger radius to read as the same roundness. */}
			<div className="flex h-full flex-col overflow-hidden rounded-[16px] border border-edge bg-linear-to-b from-frame-top to-frame to-40% shadow-frame [corner-shape:superellipse(1.25)] group-data-[focused=true]:border-edge-focus">
				<header className="px-3.5 pt-3 pb-2 font-medium text-ink-muted select-none group-data-[focused=true]:text-ink">
					{title}
				</header>
				<div className="flex-1" />
			</div>
		</article>
	);
}
