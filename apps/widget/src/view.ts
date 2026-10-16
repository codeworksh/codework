// The view half of the widget SDK: what built-in and third-party widget views import.
export {
	defineWidget,
	type Navigation,
	type Params,
	type Priority,
	type Widget,
	type WidgetDefinition,
	type WidgetProps,
} from "./view/widget";
export {
	type Frame,
	FrameContext,
	type OpenMode,
	openMode,
	type OpenOptions,
	type Placement,
	type Shell,
	ShellContext,
	type Tab,
	useFrame,
	useShell,
} from "./view/shell";
export { type Bus, type Host, HostContext, type Kv, useBus, useEvents, useKv } from "./view/host";
export { isMac } from "./view/platform";
export type { Event, Synced } from "./event";
