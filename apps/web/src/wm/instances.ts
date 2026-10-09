import { attachWidget, detachWidget, focusWidget, moveWidgetRelative, type WidgetOrder } from "webwm";

import type { Params } from "../sdk";
import { workspaceTag } from "./workspaces";

/**
 * One placed copy of a widget. The window manager owns instances; a widget only
 * ever sees its own id, address, params, and decoded props.
 */
export interface Instance {
	readonly id: string;
	/** Registered widget kind; an unknown kind renders a "missing widget" frame. */
	readonly kind: string;
	/** webwm tag mask: the workspaces this instance appears on. */
	readonly tags: number;
	/** Saved settings, decoded by the widget's own schema before it renders. */
	readonly props: unknown;
	/** Overrides the widget's default title. */
	readonly title?: string;
	/** What the instance shows when opened by address; opening it again focuses this instance. */
	readonly address?: string;
	readonly params?: Params;
	/** The instance whose `open` created this one; only it may replace this one's address. */
	readonly openedBy?: string;
}

/** Every instance plus webwm's tile and focus order over them. */
export interface Desk {
	readonly instances: readonly Instance[];
	readonly order: WidgetOrder;
}

const [main, code, notes] = [workspaceTag(1), workspaceTag(2), workspaceTag(3)];

// Hardcoded until instances live in SQLite. Tile order follows this list, so
// Files is the master on Main and Projects on Code; Chat and Terminal sit on
// two workspaces at once.
const seed: readonly Instance[] = [
	{
		id: "files",
		kind: "codework:explorer",
		tags: main,
		props: { root: "/Users/sanchitrk/Developer/codeworksh/codework" },
	},
	{ id: "projects", kind: "codework:projects", tags: code, props: {} },
	{ id: "chat", kind: "codework:placeholder", title: "Chat", tags: main | code, props: {} },
	{ id: "terminal", kind: "codework:placeholder", title: "Terminal", tags: main | code, props: {} },
	{ id: "preview", kind: "codework:placeholder", title: "Preview", tags: main, props: {} },
	{ id: "editor", kind: "codework:placeholder", title: "Editor", tags: code, props: {} },
	{ id: "notes", kind: "codework:placeholder", title: "Notes", tags: notes, props: {} },
];

const ids = seed.map(({ id }) => id);
export const initialDesk: Desk = { instances: seed, order: { tileOrder: ids, focusOrder: ids } };

/** Adds a focused instance to the tile order right after `after`, or last. */
export function add(desk: Desk, instance: Instance, after?: string): Desk {
	const attached = attachWidget(desk.order, instance.id);
	const target = after ?? desk.order.tileOrder.at(-1);
	return {
		instances: [...desk.instances, instance],
		order: target === undefined ? attached : moveWidgetRelative(attached, instance.id, target, "after"),
	};
}

export const remove = (desk: Desk, id: string): Desk => ({
	instances: desk.instances.filter((instance) => instance.id !== id),
	order: detachWidget(desk.order, id),
});

export const focus = (desk: Desk, id: string): Desk => ({ ...desk, order: focusWidget(desk.order, id) });

/** Shows another address in an instance; the old address's params go with it. */
export const retarget = (desk: Desk, id: string, address: string, params: Params | undefined): Desk => ({
	...desk,
	instances: desk.instances.map((instance) => {
		if (instance.id !== id) return instance;
		const { params: _params, ...kept } = instance;
		return { ...kept, address, ...(params === undefined ? {} : { params }) };
	}),
});

export function update(desk: Desk, id: string, patch: Partial<Instance>): Desk {
	const current = desk.instances.find((instance) => instance.id === id);
	if (current === undefined || Object.entries(patch).every(([key, value]) => current[key as keyof Instance] === value))
		return desk;
	return {
		...desk,
		instances: desk.instances.map((instance) => (instance === current ? { ...instance, ...patch } : instance)),
	};
}
