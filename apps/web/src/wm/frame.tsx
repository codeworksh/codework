import {
	CaretRightIcon,
	CornersInIcon,
	CornersOutIcon,
	DotsSixVerticalIcon,
	DotsThreeIcon,
	type Icon,
	PlusIcon,
	PushPinIcon,
	PushPinSlashIcon,
	StackIcon,
	XIcon,
} from "@phosphor-icons/react";
import { isValidElement, type ReactNode } from "react";
import type { Rect } from "webwm";
import { useDragHandle } from "webwm/react";
import type { DragMovement } from "webwm/dom";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FrameIcon } from "@codeworksh/widget/view";
import { MENU_ROW } from "@/components/menu";
import { shortcutLabel } from "../shell/switcher";
import { Title } from "./title";

/** A workspace a frame can move to. */
export interface Destination {
	readonly id: string;
	readonly name: string;
	/** Its place in the switcher, which is also its Cmd+N key. */
	readonly position: number;
}

interface FrameProps {
	readonly title: string;
	/** Before the title, quieter: what the title belongs to. */
	readonly lead?: string | undefined;
	readonly icon?: FrameIcon | undefined;
	readonly children?: ReactNode;
	readonly rect: Rect;
	/** Shown as its header only, at `FRAME_HEADER_HEIGHT`; focusing it opens it again. */
	readonly collapsed: boolean;
	/** In a column's overflow: not shown at all, but kept mounted so its widget keeps working. */
	readonly hidden: boolean;
	readonly focused: boolean;
	readonly pinned: boolean;
	readonly maximized: boolean;
	/** A lone frame shares the app surface instead of drawing a separate card. */
	readonly integrated: boolean;
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
	/** The widget's own rows in the frame menu, below Move. */
	readonly menu?: ReactNode;
	readonly onClose: () => void;
	readonly onDragStart: () => void;
	readonly onDragMove: (movement: DragMovement) => void;
	readonly onDragEnd: (movement: DragMovement) => void;
	readonly onDragCancel: () => void;
}

/** The 36px header plus its bottom border, with no outer inset. */
export const FRAME_HEADER_HEIGHT = 37;

export function Frame(props: FrameProps) {
	const { title, lead, icon, rect, collapsed, focused, pinned, maximized, canDrag, offset, animate } = props;
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
			// Named so a widget's own `group-hover` rows never react to the pointer anywhere in the frame.
			className={`group/frame absolute top-0 left-0 box-border ${offset ? "z-10 opacity-90" : animate ? "transition-[transform,width,height] duration-200 ease-out" : ""}`}
			data-focused={focused}
			data-collapsed={collapsed}
			hidden={props.hidden}
			style={{ width: rect.w, height: rect.h, transform: `translate(${x}px, ${y}px)` }}
			onPointerDown={props.onFocus}
		>
			<div
				className={`flex h-full flex-col overflow-hidden ${props.integrated ? "bg-transparent" : "border-r border-b border-edge bg-frame group-data-[focused=true]/frame:border-edge-focus"} ${offset ? "shadow-[0_12px_32px_-12px_var(--cw-shadow-far)]" : ""}`}
			>
				<header className="flex h-pane shrink-0 items-center gap-2 border-b border-edge px-3 select-none">
					<div
						ref={handleRef}
						className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 ${canDrag ? "cursor-grab active:cursor-grabbing" : ""}`}
					>
						{canDrag && <DotsSixVerticalIcon className="size-3 shrink-0 text-ink-muted/40" aria-hidden />}
						{icon !== undefined && <IconOf icon={icon} className="size-3.5 shrink-0 text-ink-muted" />}
						{lead !== undefined && (
							<>
								<span className="max-w-1/3 shrink-0 truncate text-ui text-ink-muted" title={lead}>
									{lead}
								</span>
								<CaretRightIcon className="size-3 shrink-0 text-ink-muted/40" aria-hidden />
							</>
						)}
						<Title
							text={title}
							className="flex-1 font-medium text-ink-muted transition-colors duration-150 ease-out group-data-[focused=true]/frame:text-ink"
						/>
					</div>
					<div className="flex shrink-0 items-center gap-0.5 border-l border-edge pl-2">
						<Action
							icon={pinned ? PushPinSlashIcon : PushPinIcon}
							label={pinned ? "Unpin" : "Pin"}
							active={pinned}
							onClick={props.onPin}
						/>
						<Action
							icon={maximized ? CornersInIcon : CornersOutIcon}
							label={maximized ? "Restore" : "Maximize"}
							active={false}
							onClick={props.onMaximize}
						/>
						<More destinations={props.destinations} onMove={props.onMove} onMoveNew={props.onMoveNew}>
							{props.menu}
						</More>
						<Action icon={XIcon} label="Close" active={false} onClick={props.onClose} />
					</div>
				</header>
				{/* A collapsed frame keeps its widget mounted, so it keeps working and keeps its state. */}
				<div className="min-h-0 flex-1 overflow-hidden" hidden={collapsed}>
					{props.children}
				</div>
			</div>
		</article>
	);
}

/** The frame menu: Move, then the widget's own rows. */
function More({
	destinations,
	onMove,
	onMoveNew,
	children,
}: {
	readonly destinations: readonly Destination[];
	readonly onMove: (workspaceId: string) => void;
	readonly onMoveNew: (() => void) | undefined;
	readonly children?: ReactNode;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="More"
				title="More"
				className={`${actionClass} data-[state=open]:bg-ink/8 data-[state=open]:text-ink`}
			>
				<DotsThreeIcon className="size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuSub>
					<DropdownMenuSubTrigger className={`${MENU_ROW} [&>svg:last-child]:size-3.5`}>
						<StackIcon />
						Move
					</DropdownMenuSubTrigger>
					{/* Shifted up by its padding and border, so its first row lines up with the trigger. */}
					<DropdownMenuSubContent alignOffset={-5} className="max-w-64 min-w-44">
						{destinations.map(({ id, name, position }) => (
							<DropdownMenuItem key={id} title={name} className={MENU_ROW} onSelect={() => onMove(id)}>
								<StackIcon />
								<span className="truncate">{name}</span>
								<DropdownMenuShortcut>{shortcutLabel(position)}</DropdownMenuShortcut>
							</DropdownMenuItem>
						))}
						{destinations.length > 0 && <DropdownMenuSeparator />}
						<DropdownMenuItem
							className={MENU_ROW}
							disabled={onMoveNew === undefined}
							onSelect={() => onMoveNew?.()}
						>
							<PlusIcon />
							New Tab
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const actionClass =
	"grid size-6 place-items-center rounded-md text-ink-muted/80 transition-[transform,background-color,color] duration-150 ease-out outline-none hover:bg-ink/8 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-95 aria-pressed:text-ink";

interface ActionProps {
	readonly icon: Icon;
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
			<Icon className="size-3.5" />
		</button>
	);
}

/** A frame icon as drawn: an element as given, a icon component at `className`. */
export function IconOf({ icon: Icon, className }: { readonly icon: FrameIcon; readonly className?: string }) {
	return isValidElement(Icon) ? Icon : <Icon className={className} aria-hidden />;
}
