import { DotsSixVerticalIcon, PlusIcon, StackIcon, TrashIcon } from "@phosphor-icons/react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import { isMac } from "@codeworksh/widget/view";
import { shortcutLabel } from "../shell/switcher";
import { deskAtom, deskKey, only } from "../wm/instances";
import {
	deleteTab,
	reorderTabs,
	lastTabAtom,
	MAX_TABS,
	updateTab,
	useCreateTab,
	useTabs,
	type Tab,
	tabsKey,
	tabTag,
} from "../wm/tabs";
import { Group, Keys, SavingInput, Page, Row, Section } from "./blocks";

/** Move one id to its final position, shared by drag and keyboard reordering. */
function moveTo(ids: readonly string[], from: number, to: number): string[] {
	const next = [...ids];
	const [id] = next.splice(from, 1);
	if (id !== undefined) next.splice(to, 0, id);
	return next;
}

const sameOrder = (ids: readonly string[], tabs: readonly Tab[]) =>
	ids.length === tabs.length && ids.every((id, index) => tabs[index]?.id === id);

/** List, create, rename, reorder (drag the grip), and delete tabs. */
export function TabsSettings() {
	const tabs = useTabs();
	const create = useCreateTab();
	const desk = useAtomValue(deskAtom);
	const current = useAtomValue(lastTabAtom);
	const [adding, setAdding] = useState(false);
	const reorder = useAtomSet(reorderTabs, { mode: "promise" });
	const [error, setError] = useState<string | null>(null);
	// The new tab, whose name field takes focus.
	const [created, setCreated] = useState<string | null>(null);
	// Order while dragging and until the server's list catches up with it.
	const [order, setOrder] = useState<readonly string[] | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	if (order !== null && dragging === null && sameOrder(order, tabs)) setOrder(null);

	const byId = new Map(tabs.map((tab) => [tab.id, tab]));
	const listed = order === null ? tabs : order.flatMap((id) => byId.get(id) ?? []);

	const run = (action: () => Promise<unknown>) => {
		setError(null);
		action().catch((cause: unknown) => setError(messageOf(cause)));
	};

	const addTab = () => {
		setAdding(true);
		run(async () => {
			try {
				const tab = await create({ name: `Tab ${tabs.length + 1}` });
				setCreated(tab.id);
			} finally {
				setAdding(false);
			}
		});
	};

	const saveOrder = (ids: readonly string[]) => {
		setOrder(ids);
		run(async () => {
			try {
				await reorder({ payload: { ids }, reactivityKeys: tabsKey });
			} catch (cause) {
				setOrder(null);
				throw cause;
			}
		});
	};

	const dragOver = (overId: string) => {
		if (dragging === null || dragging === overId) return;
		const ids = listed.map((tab) => tab.id);
		setOrder(moveTo(ids, ids.indexOf(dragging), ids.indexOf(overId)));
	};

	const dragEnd = () => {
		setDragging(null);
		if (order !== null && !sameOrder(order, tabs)) saveOrder(order);
	};

	return (
		<Page
			title="Tabs"
			description="Keep related sessions together, each tab with its own panel layout"
			actions={
				<Button
					size="sm"
					variant="secondary"
					disabled={adding || tabs.length >= MAX_TABS}
					title={tabs.length >= MAX_TABS ? `All ${MAX_TABS} tabs are in use` : undefined}
					onClick={addTab}
				>
					<PlusIcon aria-hidden />
					{adding ? "Creating…" : "New"}
				</Button>
			}
		>
			<Section title="Your Tabs">
				<Group>
					{listed.map((tab, index) => {
						const panels = desk.instances.filter((instance) => (instance.tags & tabTag(tab)) !== 0).length;
						return (
							<div
								key={tab.id}
								data-tab={tab.id}
								className={`group/tab flex items-center gap-3 px-4 py-3 ${dragging === tab.id ? "bg-selection-subtle opacity-50" : ""}`}
								onDragOver={(event) => {
									event.preventDefault();
									dragOver(tab.id);
								}}
								onDrop={(event) => event.preventDefault()}
							>
								<button
									type="button"
									draggable={listed.length > 1}
									disabled={listed.length < 2}
									aria-label={`Reorder ${tab.name}`}
									title="Drag to reorder, or use the up and down arrow keys"
									aria-describedby="tab-order-help"
									className="grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-brand active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
									onKeyDown={(event) => {
										if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
										event.preventDefault();
										const target = index + (event.key === "ArrowUp" ? -1 : 1);
										if (target >= 0 && target < listed.length)
											saveOrder(
												moveTo(
													listed.map(({ id }) => id),
													index,
													target,
												),
											);
									}}
									onDragStart={(event) => {
										event.dataTransfer.effectAllowed = "move";
										const row = event.currentTarget.parentElement;
										if (row) event.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2);
										setDragging(tab.id);
									}}
									onDragEnd={dragEnd}
								>
									<DotsSixVerticalIcon weight="bold" className="size-4" aria-hidden />
								</button>
								<span className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-ink/3 text-ink-muted @min-[440px]:flex">
									<StackIcon className="size-4" aria-hidden />
								</span>
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<div className="flex min-w-0 items-center gap-2">
										<NameField
											key={tab.id === created ? "created" : tab.id}
											tab={tab}
											autoFocus={tab.id === created}
											onError={setError}
										/>
										{tab.id === current && (
											<span className="hidden shrink-0 rounded-md bg-brand/10 px-1.5 py-0.5 text-2xs font-medium text-brand @min-[560px]:inline">
												Current
											</span>
										)}
									</div>
									<p className="px-2 text-xs text-ink-muted">
										{panels} {panels === 1 ? "panel" : "panels"} ·{" "}
										{tab.layout === "monocle" ? "Focused view" : "Tiled view"}
									</p>
								</div>
								<Keys>{shortcutLabel(index + 1)}</Keys>
								<DeleteButton tab={tab} onError={setError} />
							</div>
						);
					})}
					{listed.length === 0 && (
						<div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
							<StackIcon className="mb-1 size-6 text-ink-muted" aria-hidden />
							<p className="font-medium">No Tabs Yet</p>
							<p className="text-ink-muted">Create a tab to organize your sessions.</p>
						</div>
					)}
				</Group>
				<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-1 text-xs text-ink-muted">
					<p id="tab-order-help" className="max-w-sm leading-relaxed">
						Rename inline; changes save automatically. Drag the handles or use ↑ ↓ while a handle is focused to
						reorder tabs and shortcuts.
					</p>
					<span className="shrink-0 tabular-nums">
						{tabs.length} of {MAX_TABS} tabs
					</span>
				</div>
				{error !== null && (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				)}
			</Section>
			<Section title="Shortcuts">
				<Group>
					<Row title="Switch Tab" description="Jump to a tab by its position in your list">
						<Keys>
							{shortcutLabel(1)}–{MAX_TABS}
						</Keys>
					</Row>
					<Row title="Open Settings">
						<Keys>{isMac ? "⌘," : "Ctrl+,"}</Keys>
					</Row>
				</Group>
			</Section>
		</Page>
	);
}

interface RowProps {
	readonly tab: Tab;
	readonly onError: (message: string) => void;
}

/** Renames in place: commits on Enter or blur, Escape restores the saved name. */
function NameField({ tab, autoFocus, onError }: RowProps & { readonly autoFocus: boolean }) {
	const save = useAtomSet(updateTab, { mode: "promise" });
	return (
		<SavingInput
			label={`Name for ${tab.name}`}
			value={tab.name}
			autoFocus={autoFocus}
			// Reads as plain text in the row until hovered or focused.
			className="h-7 min-w-0 flex-1 rounded-md border-transparent bg-transparent px-2 font-medium shadow-none hover:border-edge hover:bg-ink/3 focus-visible:border-edge-focus dark:bg-transparent"
			onCommit={(name) => {
				// A tab keeps its name when the field is cleared.
				if (!name) return;
				save({ payload: { id: tab.id, name }, reactivityKeys: tabsKey }).catch((cause: unknown) =>
					onError(messageOf(cause)),
				);
			}}
		/>
	);
}

/** Deletes after a confirm that says which widgets close with it. */
function DeleteButton({ tab, onError }: RowProps) {
	const remove = useAtomSet(deleteTab, { mode: "promise" });
	const desk = useAtomValue(deskAtom);
	const tag = tabTag(tab);
	const closing = only(desk, tag).length;
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-8 text-ink-muted hover:text-destructive"
					aria-label={`Delete ${tab.name}`}
					title={`Delete ${tab.name}`}
				>
					<TrashIcon />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {tab.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						Its shortcut goes away.{" "}
						{closing === 0
							? "Panels shared with other tabs stay open."
							: `${closing} ${closing === 1 ? "panel" : "panels"} open only here will close; shared panels stay.`}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() =>
							// The server drops the tab's widgets, so the desk reloads with the list.
							remove({ payload: { id: tab.id }, reactivityKeys: [...tabsKey, ...deskKey] }).catch(
								(cause: unknown) => onError(messageOf(cause)),
							)
						}
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
