import { forwardRef, type ComponentProps, type ComponentType } from "react";

export type { VuesaxName } from "@/assets/vuesax";
import type { VuesaxName } from "@/assets/vuesax";

const files = import.meta.glob<string>("../assets/vuesax/**/*.svg", {
	eager: true,
	query: "?url&no-inline",
	import: "default",
});

export type IconComponent = ComponentType<IconProps>;

type IconProps = Omit<ComponentProps<"svg">, "name"> & { readonly size?: number | string };

/** A CSS mask preserves the source SVG while drawing it in the UI's text color. */
function Vuesax({ name, size = 24, style, ...props }: IconProps & { readonly name: VuesaxName }) {
	const url = files[`../assets/vuesax/${name}.svg`];
	return (
		<svg
			width={size}
			height={size}
			aria-hidden="true"
			focusable="false"
			style={{
				backgroundColor: "currentColor",
				mask: `url("${url}") center / contain no-repeat`,
				...style,
			}}
			{...props}
		/>
	);
}

function icon(name: VuesaxName) {
	const Icon = forwardRef<SVGSVGElement, IconProps>((props, ref) => <Vuesax name={name} ref={ref} {...props} />);
	Icon.displayName = `Vuesax(${name})`;
	return Icon;
}

export const ThreadsIcon = icon("community/linear/task-square");
export const WorkspaceIcon = icon("community/linear/layer");
export const GlobeIcon = icon("original/linear/global");
export const TagIcon = icon("original/linear/tag");
export const ArrowLeft = icon("community/linear/arrow-left");
export const ArrowRight = icon("community/linear/arrow-right");
export const ArrowUp = icon("community/linear/arrow-up-1");
export const Check = icon("community/linear/tick-circle");
export const ChevronDown = icon("community/linear/arrow-down");
export const ChevronRight = icon("community/linear/arrow-right-1");
export const ChevronUp = icon("community/linear/arrow-up");
export const CircleAlert = icon("community/linear/info-circle");
export const Clock = icon("community/linear/clock");
export const Copy = icon("community/linear/copy");
export const Download = icon("community/linear/document-download");
export const FileSearch = icon("community/linear/search-status");
export const FolderTree = icon("community/linear/folder-connection");
export const Gauge = icon("community/linear/speedometer");
export const GitBranch = icon("community/linear/hierarchy");
export const GitFork = icon("community/linear/hierarchy-2");
export const Link = icon("community/linear/link");
export const ListFilter = icon("community/linear/filter");
export const MessageSquare = icon("community/linear/message-text");
export const Minus = icon("community/linear/minus");
export const MoreHorizontal = icon("community/linear/more");
export const Palette = icon("community/linear/color-swatch");
export const Pencil = icon("community/linear/edit-2");
export const Plus = icon("community/linear/add");
export const RefreshCw = icon("community/linear/refresh");
export const Search = icon("community/linear/search-normal-1");
export const SendHorizontal = icon("community/linear/send-2");
export const Server = icon("community/linear/driver");
export const Settings = icon("community/linear/setting-2");
export const SlidersHorizontal = icon("community/linear/setting-4");
export const Trash2 = icon("community/linear/trash");
export const TriangleAlert = icon("community/linear/warning-2");
export const Undo2 = icon("community/linear/undo");
export const PanelLeftIcon = icon("community/linear/sidebar-left");
export const EditIcon = icon("community/linear/edit");

// Closest matches in the supplied collection. Labels distinguish folder actions and toggle states.
export const X = icon("community/linear/close-circle");
export const Square = icon("community/linear/stop");
export const GripVertical = icon("community/linear/menu-1");
export const Maximize2 = icon("community/linear/maximize-4");
export const Minimize2 = icon("community/linear/row-horizontal");
export const Pin = icon("community/linear/bookmark");
export const PinOff = icon("community/linear/bookmark-2");
export const Lock = icon("community/linear/grid-lock");
export const LockOpen = icon("community/linear/grid-1");
export const Box = icon("community/linear/box");
export const ListEnd = icon("community/linear/task");
export const Folder = icon("community/linear/folder-connection");
export const FolderOpen = icon("community/linear/folder-connection");
export const FolderGit2 = icon("community/linear/folder-connection");
export const FolderPlus = icon("community/linear/add");
export const FolderUp = icon("community/linear/arrow-up-1");
export const CornerDownLeft = icon("community/linear/arrow-left");
export const CornerDownRight = icon("community/linear/arrow-right");
export const CircleDashed = icon("community/linear/refresh");
export const Keyboard = icon("community/linear/keyboard");
export const Sparkles = icon("community/linear/magic-star");
export const Archive = icon("community/linear/archive");
export const Cpu = icon("community/linear/cpu");
export const Puzzle = icon("community/linear/main-component");
export const DocumentText = icon("community/linear/document-text");
export const CloudConnection = icon("community/linear/cloud-connection");
