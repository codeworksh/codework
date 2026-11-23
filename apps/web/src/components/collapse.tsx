import { type ReactNode, useState } from "react";

/**
 * Opens and closes its content by height and opacity together, so the card grows and shrinks instead of
 * jumping. Closed content stays mounted, inert, so it can animate out. The content is clipped only while
 * it moves: open, focus rings and shadows show whole. `onOpened` runs once it has finished opening, the
 * moment to focus a field inside without the motion fighting the browser's scroll-into-view.
 */
export function Collapse({
	open,
	onOpened,
	children,
}: {
	readonly open: boolean;
	readonly onOpened?: (() => void) | undefined;
	readonly children: ReactNode;
}) {
	const [settled, setSettled] = useState(open);
	// Each open or close starts clipped again until its motion ends.
	const [lastOpen, setLastOpen] = useState(open);
	if (open !== lastOpen) {
		setLastOpen(open);
		setSettled(false);
	}
	return (
		<div
			inert={!open}
			onTransitionEnd={(event) => {
				if (!open || event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
				setSettled(true);
				onOpened?.();
			}}
			// Reduced motion keeps a 1ms transition, so its end still arrives.
			className={`grid transition-[grid-template-rows,opacity] duration-250 ease-(--ease-out) motion-reduce:duration-1 ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
		>
			<div className={open && settled ? "min-h-0" : "min-h-0 overflow-hidden"}>{children}</div>
		</div>
	);
}
