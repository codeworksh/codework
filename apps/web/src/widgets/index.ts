import type { Widget } from "../sdk";
import { explorer } from "./explorer";
import { placeholder } from "./placeholder";

/** Widgets that ship with the app. Registry-installed widgets join these by kind. */
export const builtins: readonly Widget[] = [explorer, placeholder];

export const registry: ReadonlyMap<string, Widget> = new Map(builtins.map((widget) => [widget.kind, widget]));
