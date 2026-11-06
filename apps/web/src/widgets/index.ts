import type { Widget } from "@codeworksh/widget/view";
import { session } from "./session";
import { threads } from "./threads";

/** Widgets that ship with the app. Registry-installed widgets join these by kind. */
export const builtins: readonly Widget[] = [threads, session];

export const registry: ReadonlyMap<string, Widget> = new Map(builtins.map((widget) => [widget.kind, widget]));
