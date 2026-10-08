import { useState } from "react";
import { focus, tagBit, type Widget, type WidgetId, type WidgetOrder } from "webwm";
import { useArrangedWidgets, useElementSize } from "webwm/react";

import { Frame } from "./frame";

const desktop = tagBit(0);

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

export function Desktop() {
	const [order, setOrder] = useState<WidgetOrder>({
		tileOrder: widgets.map(({ id }) => id),
		focusOrder: widgets.map(({ id }) => id),
	});
	const [ref, size] = useElementSize<HTMLDivElement>();
	const arrangement = useArrangedWidgets(
		widgets,
		order,
		{ x: 0, y: 0, w: size.width, h: size.height },
		{ activeTags: desktop, layout: "tile", nmaster: 1, mfact: 0.6 },
	);
	const focusedId = order.focusOrder[0];

	// With each frame's p-1 inset, p-1 here gives even 8px gaps at edges and between frames.
	return (
		<main className="box-border h-full overflow-auto p-1" ref={ref}>
			<div className="relative" style={{ width: arrangement.contentBounds.w, height: arrangement.contentBounds.h }}>
				{arrangement.placements.map(({ widget, rect }) => (
					<Frame
						key={widget.id}
						title={titles[widget.id] ?? widget.id}
						rect={rect}
						focused={widget.id === focusedId}
						onFocus={() => setOrder(focus(widgets, order, desktop, widget.id).order)}
					/>
				))}
			</div>
		</main>
	);
}
