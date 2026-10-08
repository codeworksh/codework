import { useRef, useState } from "react";
import {
	focus,
	hasMasterStack,
	masterStackMfactRange,
	mfactFromPointer,
	moveWidgetRelative,
	tagBit,
	tileInsertionTargetAtPoint,
	type Bounds,
	type InsertionTarget,
	type Widget,
	type WidgetId,
	type WidgetOrder,
} from "webwm";
import { useArrangedWidgets, useElementSize } from "webwm/react";

import { Divider } from "./divider";
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
	const [mfact, setMfact] = useState(0.6);
	const [resizing, setResizing] = useState(false);
	const [ref, size] = useElementSize<HTMLDivElement>();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const focusedId = order.focusOrder[0];
	const bounds: Bounds = { x: 0, y: 0, w: size.width, h: size.height };
	const tiled = order.tileOrder.flatMap((id) => widgets.filter((widget) => widget.id === id));
	// Both columns must keep their widgets' minimum widths, so mfact is clamped to that range.
	const range = layout === "tile" && bounds.w > 0 ? masterStackMfactRange(tiled, bounds, nmaster) : null;
	const effectiveMfact = range ? Math.min(range.max, Math.max(range.min, mfact)) : mfact;
	const arrangement = useArrangedWidgets(widgets, order, bounds, {
		activeTags: desktop,
		layout,
		...(focusedId === undefined ? {} : { focusedWidgetId: focusedId }),
		nmaster,
		mfact: effectiveMfact,
	});

	const targetAt = (clientX: number, clientY: number) => {
		const surface = surfaceRef.current?.getBoundingClientRect();
		if (!surface) return null;
		// The narrow-window fallback is one column, so it has no master area.
		const masters = arrangement.mode === "stack" ? 0 : nmaster;
		return tileInsertionTargetAtPoint(arrangement.placements, clientX - surface.left, clientY - surface.top, masters);
	};

	const showDivider =
		range !== null && arrangement.mode !== "stack" && hasMasterStack(arrangement.placements.length, nmaster);

	const resizeTo = (clientX: number) => {
		const surface = surfaceRef.current?.getBoundingClientRect();
		if (surface && range) setMfact(mfactFromPointer(clientX - surface.left, bounds, range));
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
						animate={!resizing}
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
				{showDivider && range && (
					<Divider
						left={Math.floor(bounds.w * effectiveMfact)}
						height={arrangement.contentBounds.h}
						mfact={effectiveMfact}
						range={range}
						onResizeStart={() => setResizing(true)}
						onResize={resizeTo}
						onResizeEnd={() => setResizing(false)}
						onChange={setMfact}
					/>
				)}
			</div>
		</main>
	);
}
