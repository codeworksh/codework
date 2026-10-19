import type { Desk as SavedDesk } from "@codeworksh/contract";
import type { Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { attachWidget, detachWidget, focusWidget, moveWidgetRelative, type WidgetOrder } from "webwm";

import type { Params } from "@codeworksh/widget/view";
import { Server } from "../kernel/rpc";

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
	/** A pinned frame stays put: it can't be dragged, and opens never replace what it shows. */
	readonly pinned: boolean;
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

/** The workspaces delete names this key too: the server drops the deleted workspace's widgets. */
export const deskKey = ["desk"];

export const deskQueryAtom = Server.query("desk.get", undefined, { reactivityKeys: deskKey });

// Kept alive so a save started as the desktop unmounts still lands.
export const saveDesk = Server.mutation("desk.save").pipe(Atom.keepAlive);

const empty: Desk = { instances: [], order: { tileOrder: [], focusOrder: [] } };

const isParams = (json: Schema.Json | undefined): json is Schema.JsonObject =>
	typeof json === "object" && json !== null && !Array.isArray(json);

// Memoized so the same server desk always maps to the same object, which saving compares against.
const loaded = new WeakMap<SavedDesk, Desk>();

function fromSaved(saved: SavedDesk): Desk {
	const cached = loaded.get(saved);
	if (cached !== undefined) return cached;
	const desk: Desk = {
		instances: saved.instances.map(({ params, ...instance }) => ({
			...instance,
			...(isParams(params) ? { params } : {}),
		})),
		order: { tileOrder: saved.tileOrder, focusOrder: saved.focusOrder },
	};
	loaded.set(saved, desk);
	return desk;
}

// Widgets hand the shell JSON-shaped props and params; the server checks them as JSON.
export const toSaved = ({ instances, order }: Desk): SavedDesk => ({
	instances: instances.map(({ props, params, ...instance }) => ({
		...instance,
		props: props as Schema.Json,
		...(params === undefined ? {} : { params: params as Schema.Json }),
	})),
	tileOrder: order.tileOrder,
	focusOrder: order.focusOrder,
});

/** The desk as the server last sent it; undefined until it loads. */
export const loadedDeskAtom = Atom.make((get) => {
	const result = get(deskQueryAtom);
	return AsyncResult.isSuccess(result) ? fromSaved(result.value) : undefined;
});

// Local edits, tied to the server desk they were made on: a refetch (a workspace deleted) replaces them.
const editsAtom = Atom.make<{ readonly base: Desk; readonly desk: Desk } | undefined>(undefined).pipe(Atom.keepAlive);

/** The desk the UI edits, empty until it loads; the client owns it from then on and saves it back. */
export const deskAtom = Atom.writable<Desk, Desk>(
	(get) => {
		const base = get(loadedDeskAtom);
		const edits = get(editsAtom);
		if (base === undefined) return empty;
		return edits?.base === base ? edits.desk : base;
	},
	(ctx, desk) => {
		const base = ctx.get(loadedDeskAtom);
		if (base !== undefined) ctx.set(editsAtom, { base, desk });
	},
).pipe(Atom.keepAlive);

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

/** Instances that appear only on the workspace with this tag mask. */
export const only = (desk: Desk, tag: number) => desk.instances.filter((instance) => instance.tags === tag);

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
