import { AppWindow, GripVertical, Maximize2, Minimize2, Pin, PinOff, Plus, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Rect } from "webwm";
import { useDragHandle } from "webwm/react";
import type { DragMovement } from "webwm/dom";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Title } from "./title";

/** A workspace a frame can move to. */
export interface Destination {
	readonly id: string;
	readonly name: string;
	readonly icon: LucideIcon;
}

interface FrameProps {
	readonly title: string;
	/** Before the title, quieter: what the title belongs to. */
	readonly lead?: string | undefined;
	readonly icon?: LucideIcon | undefined;
	readonly children?: ReactNode;
	readonly rect: Rect;
	/** Shown as its header only, at `FRAME_HEADER_HEIGHT`; focusing it opens it again. */
	readonly collapsed: boolean;
	/** In a column's overflow: not shown at all, but kept mounted so its widget keeps working. */
	readonly hidden: boolean;
	readonly focused: boolean;
	readonly pinned: boolean;
	readonly maximized: boolean;
	readonly canDrag: boolean;
	readonly offset: { readonly deltaX: number; readonly deltaY: number } | null;
	/** Ease into new slots; off while the column divider is dragged so frames track the pointer. */
	readonly animate: boolean;
	/** The other workspaces, listed by the move menu. */
	readonly destinations: readonly Destination[];
	readonly onFocus: () => void;
	readonly onPin: () => void;
	readonly onMaximize: () => void;
	readonly onMove: (workspaceId: string) => void;
	/** Moves the frame to a new workspace; unset while all workspaces are in use. */
	readonly onMoveNew: (() => void) | undefined;
	readonly onClose: () => void;
	readonly onDragStart: () => void;
	readonly onDragMove: (movement: DragMovement) => void;
	readonly onDragEnd: (movement: DragMovement) => void;
	readonly onDragCancel: () => void;
}

/** A frame's full height when collapsed to its header: the header row plus the frame's inset and border. */
export const FRAME_HEADER_HEIGHT = 46;

export function Frame(props: FrameProps) {
	const { title, lead, icon: Icon, rect, collapsed, focused, pinned, maximized, canDrag, offset, animate } = props;
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
			data-collapsed={collapsed}
			hidden={props.hidden}
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
						{Icon && <Icon className="mr-0.5 size-4 shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden />}
						{lead !== undefined && <Lead text={lead} />}
						<Title text={title} className="font-semibold text-ink-muted group-data-[focused=true]:text-ink" />
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
					<Move destinations={props.destinations} onMove={props.onMove} onMoveNew={props.onMoveNew} />
					<Action icon={X} label="Close" active={false} onClick={props.onClose} />
				</header>
				{/* A collapsed frame keeps its widget mounted, so it keeps working and keeps its state. */}
				<div className="min-h-0 flex-1 overflow-hidden" hidden={collapsed}>
					{props.children}
				</div>
			</div>
		</article>
	);
}

/** Up to a third of the header, so the title it leads keeps the room. */
function Lead({ text }: { readonly text: string }) {
	return (
		<span className="flex max-w-1/3 shrink-0 items-center gap-1 text-ink-muted/70" title={text}>
			<span className="truncate">{text}</span>
			<span className="text-ink-muted/40" aria-hidden>
				/
			</span>
		</span>
	);
}

function Move({
	destinations,
	onMove,
	onMoveNew,
}: {
	readonly destinations: readonly Destination[];
	readonly onMove: (workspaceId: string) => void;
	readonly onMoveNew: (() => void) | undefined;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Move"
				title="Move"
				className={`${actionClass} data-[state=open]:bg-ink/8 data-[state=open]:text-ink`}
			>
				<AppWindow className="size-3.5" strokeWidth={1.75} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-48">
				<DropdownMenuLabel>Move</DropdownMenuLabel>
				{destinations.map(({ id, name, icon: Icon }) => (
					<DropdownMenuItem key={id} onSelect={() => onMove(id)}>
						<Icon strokeWidth={1.75} />
						<span className="truncate">{name}</span>
					</DropdownMenuItem>
				))}
				{destinations.length > 0 && <DropdownMenuSeparator />}
				<DropdownMenuItem disabled={onMoveNew === undefined} onSelect={() => onMoveNew?.()}>
					<Plus strokeWidth={1.75} />
					<span>New Workspace</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const actionClass =
	"grid size-6 place-items-center rounded-md text-ink-muted/60 transition-colors hover:bg-ink/8 hover:text-ink aria-pressed:text-ink";

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
			className={actionClass}
			onClick={onClick}
		>
			<Icon className="size-3.5" strokeWidth={1.75} />
		</button>
	);
}
