import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { RegistryContext, useAtom, useAtomSet } from "@effect/atom-react";
import { type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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

import { type Frame as FrameApi, FrameContext, HostContext, type Shell, ShellContext } from "@codeworksh/widget/view";
import { makeHost } from "../kernel/host";
import { iconOf } from "../shell/icons";
import { builtins, registry } from "../widgets";
import { type Chrome, chromeAtom, chromeOf, focusedAtom, tabOwnerAtom } from "./chrome";
import { Divider } from "./divider";
import { Frame, FRAME_HEADER_HEIGHT } from "./frame";
import { Overflow } from "./overflow";
import { add, deskAtom, type Instance, remove, retarget, focus as raise, update } from "./instances";
import { resolve } from "./resolver";
import {
	deleteWorkspace,
	MAX_WORKSPACES,
	updateWorkspace,
	useCreateWorkspace,
	useWorkspaces,
	type Workspace,
	workspaceRoute,
	workspacesKey,
	workspaceTag,
} from "./workspaces";

const nmaster = 1;

/** The opener of what the shell itself opens (an `open` request in the URL), not a widget. */
const SHELL = "shell";

/** Frame title, icon, and body for one instance, resolved through the widget registry. */
function describe(instance: Instance, chrome: Chrome | undefined) {
	const definition = registry.get(instance.kind);
	return {
		...chromeOf(instance, chrome),
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
	/** The widget kind, "<package>:<name>"; its package scopes the widget's topics and kv. */
	readonly kind: string;
	readonly shell: Shell;
	readonly decorate: (instanceId: string, chrome: Chrome) => void;
	readonly children: ReactNode;
}

/** Gives a widget its shell, frame and host; these stay stable so widgets can use them in effects. */
function Host({ instanceId, kind, shell, decorate, children }: HostProps) {
	const atoms = useContext(RegistryContext);
	const pkg = kind.split(":")[0] ?? kind;
	const host = useMemo(() => makeHost({ registry: atoms, package: pkg, instanceId }), [atoms, pkg, instanceId]);
	const frame = useMemo<FrameApi>(
		() => ({
			instanceId,
			setTitle: (title, lead) => decorate(instanceId, { title, lead }),
			setIcon: (icon) => decorate(instanceId, { icon }),
			setTab: (tab) => decorate(instanceId, { tab }),
		}),
		[instanceId, decorate],
	);
	return (
		<ShellContext value={shell}>
			<FrameContext value={frame}>
				<HostContext value={host}>{children}</HostContext>
			</FrameContext>
		</ShellContext>
	);
}

/** Per-workspace view settings, like dwm's pertag: each workspace keeps its own split, saved with it. */
interface View {
	readonly layout: "tile" | "monocle";
	readonly mfact: number;
}

interface Drag {
	readonly widgetId: WidgetId;
	readonly deltaX: number;
	readonly deltaY: number;
	readonly target: InsertionTarget | null;
}

interface DesktopProps {
	readonly workspace: Workspace;
}

export function Desktop({ workspace }: DesktopProps) {
	const [desk, setDesk] = useAtom(deskAtom);
	const workspaces = useWorkspaces();
	const navigate = useNavigate();
	const saveWorkspace = useAtomSet(updateWorkspace);
	const removeWorkspace = useAtomSet(deleteWorkspace, { mode: "promise" });
	const createWorkspace = useCreateWorkspace();
	const { open: requested, mode: requestedMode } = useSearch({ strict: false });
	const { workspaceId: routed } = useParams({ strict: false });
	// Local edits ahead of the database, so dragging the divider never waits on a round trip.
	const [views, setViews] = useState<ReadonlyMap<string, View>>(() => new Map());
	const [chrome, setChrome] = useAtom(chromeAtom);
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
	const saved: View = { layout: workspace.layout, mfact: workspace.mfact };
	const view = views.get(workspace.id) ?? saved;
	const { layout, mfact } = view;
	const setView = (patch: Partial<View>) =>
		setViews((current) => new Map(current).set(workspace.id, { ...(current.get(workspace.id) ?? saved), ...patch }));

	// Writes the view back once it settles; mid-drag splits stay local.
	useEffect(() => {
		if (resizing || (view.layout === workspace.layout && view.mfact === workspace.mfact)) return;
		saveWorkspace({ payload: { id: workspace.id, ...view }, reactivityKeys: workspacesKey });
	}, [resizing, view, workspace, saveWorkspace]);
	const setLayout = (next: View["layout"]) => setView({ layout: next });
	const setMfact = (next: number) => setView({ mfact: next });
	// Focus is the most recently focused widget that is visible on this workspace.
	const focusedId = focus(widgets, order, activeTags).widget?.id;
	const setFocused = useAtomSet(focusedAtom);
	useEffect(() => {
		if (focusedId === undefined) return;
		setFocused((current) =>
			current.get(workspace.id) === focusedId ? current : new Map(current).set(workspace.id, focusedId),
		);
	}, [workspace.id, focusedId, setFocused]);
	// The focused frame takes the tab once it has one to show, which may be after it loads.
	const focusedTab = focusedId === undefined ? undefined : chrome.get(focusedId)?.tab;
	const setTabOwner = useAtomSet(tabOwnerAtom);
	useEffect(() => {
		if (focusedId === undefined || focusedTab === undefined) return;
		setTabOwner((current) =>
			current.get(workspace.id) === focusedId ? current : new Map(current).set(workspace.id, focusedId),
		);
	}, [workspace.id, focusedId, focusedTab, setTabOwner]);
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
		// A stack column too short for all its frames folds the least recently focused to their headers.
		collapsedHeight: FRAME_HEADER_HEIGHT,
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
		if ((instance.tags & activeTags) !== 0) return;
		const home = workspaces.find((candidate) => (instance.tags & workspaceTag(candidate)) !== 0);
		if (home !== undefined) void navigate(workspaceRoute(home));
	};

	const decorate = useCallback(
		(instanceId: string, patch: Chrome) =>
			setChrome((current) => {
				const previous = current.get(instanceId) ?? {};
				const next = { ...previous, ...patch };
				const sameTab = next.tab?.title === previous.tab?.title && next.tab?.subtitle === previous.tab?.subtitle;
				if (next.title === previous.title && next.lead === previous.lead && next.icon === previous.icon && sameTab)
					return current;
				return new Map(current).set(instanceId, next);
			}),
		[],
	);

	// A frame showing something else, or gone, starts from the widget's defaults again.
	const undecorate = (instanceId: string) =>
		setChrome((current) => {
			if (!current.has(instanceId)) return current;
			const next = new Map(current);
			next.delete(instanceId);
			return next;
		});

	// An auto workspace exists to show what was opened into it, so it goes with its last frame.
	const leaving = (instanceId: string, to: { readonly to: "/" } | ReturnType<typeof workspaceRoute>) => {
		const leaver = byId.get(instanceId);
		const emptied =
			leaver !== undefined &&
			(leaver.tags & activeTags) !== 0 &&
			!instances.some((instance) => instance.id !== instanceId && (instance.tags & activeTags) !== 0);
		// Leaving only once the delete lands: leaving first unmounts this and drops the list's refresh.
		if (workspace.auto && emptied) {
			void removeWorkspace({ payload: { id: workspace.id }, reactivityKeys: workspacesKey }).then(
				() => navigate(to),
				() => undefined,
			);
		}
	};

	const close = (instanceId: string) => {
		leaving(instanceId, { to: "/" });
		setDesk((current) =>
			current.instances.some(({ id }) => id === instanceId) ? remove(current, instanceId) : current,
		);
		undecorate(instanceId);
	};

	// Moves a frame off this workspace onto another, focused there; this workspace stays on screen.
	const move = (instanceId: string, destination: Workspace) => {
		leaving(instanceId, workspaceRoute(destination));
		setDrag(null);
		setDesk((current) => raise(update(current, instanceId, { tags: workspaceTag(destination) }), instanceId));
	};

	// A new workspace is auto, so it goes once the frame leaves it; it is named like the frame's tab would be.
	const moveNew = async (instanceId: string) => {
		const instance = byId.get(instanceId);
		if (instance === undefined) return;
		const name = chrome.get(instanceId)?.tab?.title ?? chromeOf(instance, chrome.get(instanceId)).title;
		const created = await createWorkspace({ name, icon: "app-window", auto: true }).catch(() => undefined);
		if (created !== undefined) move(instanceId, created);
	};

	const destinations = workspaces
		.filter((candidate) => candidate.id !== workspace.id)
		.map(({ id, name, icon }) => ({ id, name, icon: iconOf(icon) }));

	/** The shell API as seen by one widget: the default target, and the opener of what it opens. */
	const shellFor = (caller: string): Shell => ({
		open(address, { kind, placement = "next", mode = "replace", params } = {}) {
			// Most recently focused first, so the frame last looked at wins.
			const recent = order.focusOrder.flatMap((id) => byId.get(id) ?? []);
			const widget = resolve(builtins, address, kind);
			if (widget === undefined) throw new Error(`No widget opens ${address}`);
			if (mode === "replace") {
				const existing = recent.find((instance) => instance.address === address && instance.kind === widget.kind);
				if (existing !== undefined) {
					if (params !== undefined) setDesk((current) => update(current, existing.id, { params }));
					reveal(existing);
					return;
				}
				const target = widget.replaceable
					? recent.find(
							(instance) =>
								instance.openedBy === caller &&
								instance.kind === widget.kind &&
								(instance.tags & activeTags) !== 0 &&
								!pinned.has(instance.id),
						)
					: undefined;
				if (target !== undefined) {
					setDesk((current) => raise(retarget(current, target.id, address, params), target.id));
					undecorate(target.id);
					return;
				}
			}
			const instance: Instance = {
				id: `${widget.kind}/${crypto.randomUUID().slice(0, 8)}`,
				kind: widget.kind,
				tags: activeTags,
				props: {},
				address,
				openedBy: caller,
				...(params === undefined ? {} : { params }),
			};
			setDesk((current) => add(current, instance, placement === "next" ? caller : undefined));
		},
		focus(instanceId = caller) {
			const instance = byId.get(instanceId);
			if (instance !== undefined) reveal(instance);
		},
		close(instanceId = caller) {
			close(instanceId);
		},
	});

	// Carries out an `open` request from the URL once, then drops it so Back and reloads don't repeat it.
	// The ref outlives StrictMode's second run; it resets once the URL no longer asks.
	const handled = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (requested === undefined) {
			handled.current = undefined;
			return;
		}
		// A workspace just created may not be listed yet, and the shell shows another meanwhile.
		if (handled.current === requested || routed !== workspace.id) return;
		handled.current = requested;
		shellFor(SHELL).open(requested, { placement: "end", mode: requestedMode ?? "replace" });
		void navigate({ ...workspaceRoute(workspace), search: {}, replace: true });
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
	// The scrollbar gutter is always reserved (on both edges, so gaps stay even): if a
	// scrollbar could take width only when it shows, it would shrink the layout, the
	// overflow would vanish with it, and the layout would jitter between both.
	return (
		<main className="box-border h-full overflow-auto p-1 [scrollbar-gutter:stable_both-edges]" ref={ref}>
			<div
				ref={surfaceRef}
				className="relative"
				style={{ width: arrangement.contentBounds.w, height: arrangement.contentBounds.h }}
			>
				{[
					...arrangement.placements.map((placement) => ({ ...placement, hidden: false })),
					// Overflowed frames stay mounted, hidden, so their widgets keep running and keep state.
					...arrangement.overflow.flatMap(({ widgets: overflowed, rect }) =>
						overflowed.map((widget) => ({ widget, rect, collapsed: true, hidden: true })),
					),
				].map(({ widget, rect, collapsed, hidden }) => {
					const instance = byId.get(widget.id);
					if (instance === undefined) return null;
					const { title, lead, icon, body } = describe(instance, chrome.get(widget.id));
					return (
						<Frame
							key={widget.id}
							title={title}
							lead={lead}
							icon={icon}
							rect={rect}
							collapsed={collapsed === true}
							hidden={hidden}
							focused={widget.id === focusedId}
							pinned={pinned.has(widget.id)}
							maximized={layout === "monocle"}
							canDrag={layout === "tile" && !pinned.has(widget.id)}
							offset={drag?.widgetId === widget.id ? drag : null}
							animate={!resizing}
							onFocus={() => focusWidget(widget.id)}
							onPin={() => togglePin(widget.id)}
							onMaximize={() => toggleMax(widget.id)}
							destinations={destinations}
							onMove={(workspaceId) => {
								const destination = workspaces.find((candidate) => candidate.id === workspaceId);
								if (destination !== undefined) move(widget.id, destination);
							}}
							onMoveNew={workspaces.length < MAX_WORKSPACES ? () => void moveNew(widget.id) : undefined}
							onClose={() => close(widget.id)}
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
							<Host
								key={instance.address}
								instanceId={widget.id}
								kind={instance.kind}
								shell={shellFor(widget.id)}
								decorate={decorate}
							>
								{body}
							</Host>
						</Frame>
					);
				})}
				{arrangement.overflow.map(({ widgets: overflowed, rect }) => (
					<Overflow
						key={`${rect.x}`}
						rect={rect}
						hidden={overflowed.flatMap((widget) => {
							const instance = byId.get(widget.id);
							return instance === undefined
								? []
								: [{ id: widget.id, ...chromeOf(instance, chrome.get(widget.id)) }];
						})}
						onPick={focusWidget}
					/>
				))}
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
