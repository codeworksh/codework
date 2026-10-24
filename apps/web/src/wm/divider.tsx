import type { MfactRange } from "webwm";
import { useDragHandle } from "webwm/react";

interface DividerProps {
	readonly left: number;
	readonly height: number;
	readonly mfact: number;
	readonly range: MfactRange;
	readonly onResizeStart: () => void;
	readonly onResize: (clientX: number) => void;
	readonly onResizeEnd: () => void;
	readonly onChange: (mfact: number) => void;
}

/** Master/stack column divider: drag or arrow keys change mfact within the range. */
export function Divider({ left, height, mfact, range, onResizeStart, onResize, onResizeEnd, onChange }: DividerProps) {
	const handleRef = useDragHandle<HTMLDivElement>({
		onDragStart: ({ clientX }) => {
			onResizeStart();
			onResize(clientX);
		},
		onDragMove: ({ clientX }) => onResize(clientX),
		onDragEnd: ({ clientX }) => {
			onResize(clientX);
			onResizeEnd();
		},
		onDragCancel: onResizeEnd,
	});

	return (
		<div
			ref={handleRef}
			role="separator"
			aria-label="Resize columns"
			aria-orientation="vertical"
			aria-valuemin={Math.round(range.min * 100)}
			aria-valuemax={Math.round(range.max * 100)}
			aria-valuenow={Math.round(mfact * 100)}
			tabIndex={0}
			className="absolute top-0 z-20 w-2 -translate-x-1/2 cursor-col-resize rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
			style={{ left, height }}
			onKeyDown={(event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const step = event.key === "ArrowLeft" ? -0.05 : 0.05;
				onChange(Math.min(range.max, Math.max(range.min, mfact + step)));
			}}
		/>
	);
}
