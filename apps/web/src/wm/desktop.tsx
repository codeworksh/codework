import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import {
	focus,
	hasMasterStack,
	isVisible,
	masterStackMfactRange,
	mfactFromPointer,
	moveWidgetRelative,
	tileInsertionTargetAtPoint,
	type Bounds,
	type InsertionTarget,
	type Widget,
	type WidgetId,
} from "webwm";
import { useArrangedWidgets, useElementSize } from "webwm/react";

import type { Frame as FrameApi, Shell } from "../sdk";
import { FrameContext, ShellContext } from "../sdk/shell";
import { builtins, registry } from "../widgets";
import { Divider } from "./divider";
import { Frame } from "./frame";
import { add, initialDesk, type Instance, remove, focus as raise, update } from "./instances";
import { resolve } from "./resolver";
import { firstWorkspace, workspaceRoute, workspaceTag } from "./workspaces";

const nmaster = 1;

/** Frame title, icon, and body for one instance, resolved through the widget registry. */
function describe(instance: Instance) {
	const definition = registry.get(instance.kind);
	return {
		title: instance.title ?? definition?.title ?? instance.id,
		icon: definition?.icon,
		body:
			definition === undefined ? (
				<p className="p-3 text-ink-muted">Missing widget: {instance.kind}</p>
			) : (
				definition.render({
					instanceId: instance.id,
					props: instance.props,
					address: instance.address,
					params: instance.params ?? {},
				})
			),
	};
}

interface HostProps {
	readonly instanceId: string;
	readonly shell: Shell;
	readonly retitle: (instanceId: string, title: string) => void;
	readonly children: ReactNode;
}

/** Gives a widget its shell and frame; the frame stays stable so widgets can use it in effects. */
function Host({ instanceId, shell, retitle, children }: HostProps) {
	const frame = useMemo<FrameApi>(
		() => ({ instanceId, setTitle: (title) => retitle(instanceId, title) }),
		[instanceId, retitle],
	);
	return (
		<ShellContext value={shell}>
			<FrameContext value={frame}>{children}</FrameContext>
		</ShellContext>
	);
}

/** Per-workspace view settings, like dwm's pertag: each workspace keeps its own split. */
interface View {
	readonly layout: "tile" | "monocle";
	readonly mfact: number;
}

const defaultView: View = { layout: "tile", mfact: 0.6 };

interface Drag {
	readonly widgetId: WidgetId;
	readonly deltaX: number;
	readonly deltaY: number;
	readonly target: InsertionTarget | null;
}

interface DesktopProps {
	readonly workspace: number;
}

export function Desktop({ workspace }: DesktopProps) {
	const [desk, setDesk] = useState(initialDesk);
	const navigate = useNavigate();
	const [views, setViews] = useState<ReadonlyMap<number, View>>(() => new Map());
	const [pinned, setPinned] = useState<ReadonlySet<WidgetId>>(() => new Set());
	const [drag, setDrag] = useState<Drag | null>(null);
	const [resizing, setResizing] = useState(false);
	const [ref, size] = useElementSize<HTMLDivElement>();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const activeTags = workspaceTag(workspace);
	const { instances, order } = desk;
	// webwm only needs identity, tags, and minimum sizes; those come from the
	// widget's definition so the layout respects what each widget can shrink to.
	const widgets: Widget[] = useMemo(
		() =>
			instances.map(({ id, kind, tags }) => {
				const definition = registry.get(kind);
				return { id, tags, minWidth: definition?.minWidth ?? 220, minHeight: definition?.minHeight ?? 140 };
			}),
		[instances],
	);
	const byId = new Map(instances.map((instance) => [instance.id, instance]));
	const { layout, mfact } = views.get(workspace) ?? defaultView;
	const setView = (patch: Partial<View>) =>
		setViews((current) => new Map(current).set(workspace, { ...(current.get(workspace) ?? defaultView), ...patch }));
	const setLayout = (next: View["layout"]) => setView({ layout: next });
	const setMfact = (next: number) => setView({ mfact: next });
	// Focus is the most recently focused widget that is visible on this workspace.
	const focusedId = focus(widgets, order, activeTags).widget?.id;
	const bounds: Bounds = { x: 0, y: 0, w: size.width, h: size.height };
	const tiled = order.tileOrder.flatMap((id) =>
		widgets.filter((widget) => widget.id === id && isVisible(widget, activeTags)),
	);
	// Both columns must keep their widgets' minimum widths, so mfact is clamped to that range.
	const range = layout === "tile" && bounds.w > 0 ? masterStackMfactRange(tiled, bounds, nmaster) : null;
	const effectiveMfact = range ? Math.min(range.max, Math.max(range.min, mfact)) : mfact;
	const arrangement = useArrangedWidgets(widgets, order, bounds, {
		activeTags,
		layout,
		...(focusedId === undefined ? {} : { focusedWidgetId: focusedId }),
		nmaster,
		mfact: effectiveMfact,
	});

	const targetAt = (clientX: number, clientY: number) => {
		const surface = surfaceRef.current?.getBoundingClientRect();
		if (!surface) return null;
		// The narrow-window fallback is one column, so it has no master area.
		const masters = arrangement.mode === "stack" ? 0 : nmaster;
		return tileInsertionTargetAtPoint(arrangement.placements, clientX - surface.left, clientY - surface.top, masters);
	};

	const showDivider =
		range !== null && arrangement.mode !== "stack" && hasMasterStack(arrangement.placements.length, nmaster);

	const resizeTo = (clientX: number) => {
		const surface = surfaceRef.current?.getBoundingClientRect();
		if (surface && range) setMfact(mfactFromPointer(clientX - surface.left, bounds, range));
	};

	const focusWidget = (widgetId: WidgetId) =>
		setDesk((current) => ({ ...current, order: focus(widgets, current.order, activeTags, widgetId).order }));

	// Focuses an instance, switching to a workspace that shows it when this one does not.
	const reveal = (instance: Instance) => {
		setDesk((current) => raise(current, instance.id));
		if ((instance.tags & activeTags) === 0) void navigate(workspaceRoute(firstWorkspace(instance.tags)));
	};

	const retitle = useCallback(
		(instanceId: string, title: string) => setDesk((current) => update(current, instanceId, { title })),
		[],
	);

	/** The shell API as seen by one widget: it is the default target and where new widgets land next to. */
	const shellFor = (caller: string): Shell => ({
		open(address, { kind, placement = "next", fresh = false, params } = {}) {
			// The most recently focused instance showing the address wins.
			const existing = fresh
				? undefined
				: order.focusOrder
						.map((id) => byId.get(id))
						.find((instance) => instance?.address === address && (kind === undefined || instance.kind === kind));
			if (existing !== undefined) {
				if (params !== undefined) setDesk((current) => update(current, existing.id, { params }));
				reveal(existing);
				return;
			}
			const widget = resolve(builtins, address, kind);
			if (widget === undefined) throw new Error(`No widget opens ${address}`);
			const instance: Instance = {
				id: `${widget.kind}/${crypto.randomUUID().slice(0, 8)}`,
				kind: widget.kind,
				tags: activeTags,
				props: {},
				address,
				...(params === undefined ? {} : { params }),
			};
			setDesk((current) => add(current, instance, placement === "next" ? caller : undefined));
		},
		focus(instanceId = caller) {
			const instance = byId.get(instanceId);
			if (instance !== undefined) reveal(instance);
		},
		close(instanceId = caller) {
			setDesk((current) =>
				current.instances.some(({ id }) => id === instanceId) ? remove(current, instanceId) : current,
			);
		},
	});

	const toggleMax = (widgetId: WidgetId) => {
		setDrag(null);
		if (layout === "monocle" && widgetId === focusedId) {
			setLayout("tile");
			return;
		}
		focusWidget(widgetId);
		setLayout("monocle");
	};

	const togglePin = (widgetId: WidgetId) =>
		setPinned((current) => {
			const next = new Set(current);
			if (!next.delete(widgetId)) next.add(widgetId);
			return next;
		});

	// With each frame's p-1 inset, p-1 here gives even 8px gaps at edges and between frames.
	return (
		<main className="box-border h-full overflow-auto p-1" ref={ref}>
			<div
				ref={surfaceRef}
				className="relative"
				style={{ width: arrangement.contentBounds.w, height: arrangement.contentBounds.h }}
			>
				{arrangement.placements.map(({ widget, rect }) => {
					const instance = byId.get(widget.id);
					if (instance === undefined) return null;
					const { title, icon, body } = describe(instance);
					return (
						<Frame
							key={widget.id}
							title={title}
							icon={icon}
							rect={rect}
							focused={widget.id === focusedId}
							pinned={pinned.has(widget.id)}
							maximized={layout === "monocle"}
							canDrag={layout === "tile" && !pinned.has(widget.id)}
							offset={drag?.widgetId === widget.id ? drag : null}
							animate={!resizing}
							onFocus={() => focusWidget(widget.id)}
							onPin={() => togglePin(widget.id)}
							onMaximize={() => toggleMax(widget.id)}
							onClose={() => setDesk((current) => remove(current, widget.id))}
							onDragStart={() => setDrag({ widgetId: widget.id, deltaX: 0, deltaY: 0, target: null })}
							onDragMove={({ clientX, clientY, deltaX, deltaY }) =>
								setDrag({ widgetId: widget.id, deltaX, deltaY, target: targetAt(clientX, clientY) })
							}
							onDragEnd={({ clientX, clientY }) => {
								const target = targetAt(clientX, clientY);
								if (target)
									setDesk((current) => ({
										...current,
										order: moveWidgetRelative(current.order, widget.id, target.widgetId, target.edge),
									}));
								setDrag(null);
							}}
							onDragCancel={() => setDrag(null)}
						>
							<Host instanceId={widget.id} shell={shellFor(widget.id)} retitle={retitle}>
								{body}
							</Host>
						</Frame>
					);
				})}
				{drag?.target && (
					<div
						className="pointer-events-none absolute z-20 h-0.5 -translate-y-px rounded-full bg-ink/40"
						style={{
							left: drag.target.indicator.x + 12,
							top: drag.target.indicator.y,
							width: drag.target.indicator.w - 24,
						}}
					/>
				)}
				{showDivider && range && (
					<Divider
						left={Math.floor(bounds.w * effectiveMfact)}
						height={arrangement.contentBounds.h}
						mfact={effectiveMfact}
						range={range}
						onResizeStart={() => setResizing(true)}
						onResize={resizeTo}
						onResizeEnd={() => setResizing(false)}
						onChange={setMfact}
					/>
				)}
			</div>
		</main>
	);
}
