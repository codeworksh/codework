import { GripVertical, Maximize2, Minimize2, Pin, PinOff, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Rect } from "webwm";
import { useDragHandle } from "webwm/react";
import type { DragMovement } from "webwm/dom";

import { Title } from "./title";

interface FrameProps {
	readonly title: string;
	readonly icon?: LucideIcon | undefined;
	readonly children?: ReactNode;
	readonly rect: Rect;
	readonly focused: boolean;
	readonly pinned: boolean;
	readonly maximized: boolean;
	readonly canDrag: boolean;
	readonly offset: { readonly deltaX: number; readonly deltaY: number } | null;
	/** Ease into new slots; off while the column divider is dragged so frames track the pointer. */
	readonly animate: boolean;
	readonly onFocus: () => void;
	readonly onPin: () => void;
	readonly onMaximize: () => void;
	readonly onClose: () => void;
	readonly onDragStart: () => void;
	readonly onDragMove: (movement: DragMovement) => void;
	readonly onDragEnd: (movement: DragMovement) => void;
	readonly onDragCancel: () => void;
}

export function Frame(props: FrameProps) {
	const { title, icon: Icon, rect, focused, pinned, maximized, canDrag, offset, animate } = props;
	const handleRef = useDragHandle<HTMLDivElement>({
		canDrag: () => props.canDrag,
		onDragStart: props.onDragStart,
		onDragMove: props.onDragMove,
		onDragEnd: props.onDragEnd,
		onDragCancel: props.onDragCancel,
	});
	const x = rect.x + (offset?.deltaX ?? 0);
	const y = rect.y + (offset?.deltaY ?? 0);

	return (
		<article
			// Settling into a new slot animates; the dragged frame follows the pointer directly.
			className={`group absolute top-0 left-0 box-border p-1 ${offset ? "z-10 opacity-90" : animate ? "transition-[transform,width,height] duration-200 ease-out" : ""}`}
			data-focused={focused}
			style={{ width: rect.w, height: rect.h, transform: `translate(${x}px, ${y}px)` }}
			onPointerDown={props.onFocus}
		>
			<div className="panel flex h-full flex-col overflow-hidden group-data-[focused=true]:border-edge-focus">
				<header className="flex items-center gap-1 py-1.5 pr-2 pl-1.5 select-none">
					<div
						ref={handleRef}
						className={`flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 ${canDrag ? "cursor-grab active:cursor-grabbing" : ""}`}
					>
						<GripVertical
							className={`size-3.5 shrink-0 text-ink-muted/50 ${canDrag ? "" : "invisible"}`}
							aria-hidden
						/>
						{Icon && <Icon className="mr-0.5 size-3.5 shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden />}
						<Title text={title} className="font-medium text-ink-muted group-data-[focused=true]:text-ink" />
					</div>
					<Action
						icon={pinned ? PinOff : Pin}
						label={pinned ? "Unpin" : "Pin"}
						active={pinned}
						onClick={props.onPin}
					/>
					<Action
						icon={maximized ? Minimize2 : Maximize2}
						label={maximized ? "Restore" : "Maximize"}
						active={false}
						onClick={props.onMaximize}
					/>
					<Action icon={X} label="Close" active={false} onClick={props.onClose} />
				</header>
				<div className="min-h-0 flex-1 overflow-hidden">{props.children}</div>
			</div>
		</article>
	);
}

interface ActionProps {
	readonly icon: LucideIcon;
	readonly label: string;
	readonly active: boolean;
	readonly onClick: () => void;
}

function Action({ icon: Icon, label, active, onClick }: ActionProps) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-pressed={active}
			className="grid size-6 place-items-center rounded-md text-ink-muted/60 transition-colors hover:bg-ink/8 hover:text-ink aria-pressed:text-ink"
			onClick={onClick}
		>
			<Icon className="size-3.5" strokeWidth={1.75} />
		</button>
	);
}
