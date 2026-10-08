import { useRef, useState } from "react";
import {
	focus,
	moveWidgetRelative,
	tagBit,
	tileInsertionTargetAtPoint,
	type InsertionTarget,
	type Widget,
	type WidgetId,
	type WidgetOrder,
} from "webwm";
import { useArrangedWidgets, useElementSize } from "webwm/react";

import { Frame } from "./frame";

const desktop = tagBit(0);
const nmaster = 1;

const widgets: Widget[] = [
	{ id: "chat", tags: desktop, minWidth: 320, minHeight: 200 },
	{ id: "files", tags: desktop, minWidth: 220, minHeight: 140 },
	{ id: "terminal", tags: desktop, minWidth: 220, minHeight: 140 },
	{ id: "preview", tags: desktop, minWidth: 220, minHeight: 140 },
];

const titles: Record<WidgetId, string> = {
	chat: "Chat",
	files: "Files",
	terminal: "Terminal",
	preview: "Preview",
};

interface Drag {
	readonly widgetId: WidgetId;
	readonly deltaX: number;
	readonly deltaY: number;
	readonly target: InsertionTarget | null;
}

export function Desktop() {
	const [order, setOrder] = useState<WidgetOrder>({
		tileOrder: widgets.map(({ id }) => id),
		focusOrder: widgets.map(({ id }) => id),
	});
	const [layout, setLayout] = useState<"tile" | "monocle">("tile");
	const [pinned, setPinned] = useState<ReadonlySet<WidgetId>>(() => new Set());
	const [drag, setDrag] = useState<Drag | null>(null);
	const [ref, size] = useElementSize<HTMLDivElement>();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const focusedId = order.focusOrder[0];
	const arrangement = useArrangedWidgets(
		widgets,
		order,
		{ x: 0, y: 0, w: size.width, h: size.height },
		{
			activeTags: desktop,
			layout,
			...(focusedId === undefined ? {} : { focusedWidgetId: focusedId }),
			nmaster,
			mfact: 0.6,
		},
	);

	const targetAt = (clientX: number, clientY: number) => {
		const surface = surfaceRef.current?.getBoundingClientRect();
		if (!surface) return null;
		// The narrow-window fallback is one column, so it has no master area.
		const masters = arrangement.mode === "stack" ? 0 : nmaster;
		return tileInsertionTargetAtPoint(arrangement.placements, clientX - surface.left, clientY - surface.top, masters);
	};

	const focusWidget = (widgetId: WidgetId) => setOrder((current) => focus(widgets, current, desktop, widgetId).order);

	const toggleMax = (widgetId: WidgetId) => {
		setDrag(null);
		if (layout === "monocle" && widgetId === focusedId) {
			setLayout("tile");
			return;
		}
		focusWidget(widgetId);
		setLayout("monocle");
	};

	const togglePin = (widgetId: WidgetId) =>
		setPinned((current) => {
			const next = new Set(current);
			if (!next.delete(widgetId)) next.add(widgetId);
			return next;
		});

	// With each frame's p-1 inset, p-1 here gives even 8px gaps at edges and between frames.
	return (
		<main className="box-border h-full overflow-auto p-1" ref={ref}>
			<div
				ref={surfaceRef}
				className="relative"
				style={{ width: arrangement.contentBounds.w, height: arrangement.contentBounds.h }}
			>
				{arrangement.placements.map(({ widget, rect }) => (
					<Frame
						key={widget.id}
						title={titles[widget.id] ?? widget.id}
						rect={rect}
						focused={widget.id === focusedId}
						pinned={pinned.has(widget.id)}
						maximized={layout === "monocle"}
						canDrag={layout === "tile" && !pinned.has(widget.id)}
						offset={drag?.widgetId === widget.id ? drag : null}
						onFocus={() => focusWidget(widget.id)}
						onPin={() => togglePin(widget.id)}
						onMaximize={() => toggleMax(widget.id)}
						onDragStart={() => setDrag({ widgetId: widget.id, deltaX: 0, deltaY: 0, target: null })}
						onDragMove={({ clientX, clientY, deltaX, deltaY }) =>
							setDrag({ widgetId: widget.id, deltaX, deltaY, target: targetAt(clientX, clientY) })
						}
						onDragEnd={({ clientX, clientY }) => {
							const target = targetAt(clientX, clientY);
							if (target)
								setOrder((current) => moveWidgetRelative(current, widget.id, target.widgetId, target.edge));
							setDrag(null);
						}}
						onDragCancel={() => setDrag(null)}
					/>
				))}
				{drag?.target && (
					<div
						className="pointer-events-none absolute z-20 h-0.5 -translate-y-px rounded-full bg-ink/40"
						style={{
							left: drag.target.indicator.x + 12,
							top: drag.target.indicator.y,
							width: drag.target.indicator.w - 24,
						}}
					/>
				)}
			</div>
		</main>
	);
}
