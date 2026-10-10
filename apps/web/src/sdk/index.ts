// The public widget SDK: what built-in and third-party widgets import.
export {
	defineWidget,
	type Navigation,
	type Params,
	type Priority,
	type Widget,
	type WidgetDefinition,
	type WidgetProps,
} from "./widget";
export {
	type Frame,
	type OpenMode,
	openMode,
	type OpenOptions,
	type Placement,
	type Shell,
	useFrame,
	useShell,
} from "./shell";
export { isMac } from "../kernel/platform";
export { runQuery, Server } from "../kernel/rpc";
