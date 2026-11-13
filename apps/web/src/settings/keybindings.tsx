import { ArrowCounterClockwiseIcon, KeyboardIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { isMac } from "@codeworksh/widget/view";
import { type KeyboardEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Group, Keys, Page, quietField, Section } from "./blocks";
import { EmptyState } from "./controls";
import { Badge } from "./servers/local";

interface ShortcutItem {
	readonly id: string;
	readonly group: "Navigation" | "Session & Composer" | "Window Layout";
	readonly label: string;
	readonly when: string;
	readonly defaultMac: string;
	readonly defaultOther: string;
	readonly fixed?: boolean;
}

const SHORTCUTS: readonly ShortcutItem[] = [
	{
		id: "palette",
		group: "Navigation",
		label: "Command palette",
		when: "Always",
		defaultMac: "⌘K",
		defaultOther: "Ctrl+K",
	},
	{
		id: "workspaces",
		group: "Navigation",
		label: "Switch to workspace 1–9",
		when: "Always",
		defaultMac: "⌘1 … ⌘9",
		defaultOther: "Ctrl+1 … Ctrl+9",
		fixed: true,
	},
	{
		id: "threads",
		group: "Navigation",
		label: "Go to Threads",
		when: "Always",
		defaultMac: "⌘⇧T",
		defaultOther: "Ctrl+Shift+T",
	},
	{
		id: "projects",
		group: "Navigation",
		label: "Go to Projects",
		when: "Always",
		defaultMac: "⌘⇧P",
		defaultOther: "Ctrl+Shift+P",
	},
	{
		id: "sidebar",
		group: "Navigation",
		label: "Toggle sidebar",
		when: "Always",
		defaultMac: "⌘B",
		defaultOther: "Ctrl+B",
	},
	{
		id: "settings",
		group: "Navigation",
		label: "Open Settings",
		when: "Always",
		defaultMac: "⌘,",
		defaultOther: "Ctrl+,",
	},
	{
		id: "send",
		group: "Session & Composer",
		label: "Send prompt or steer active turn",
		when: "Composer focused",
		defaultMac: "Enter",
		defaultOther: "Enter",
		fixed: true,
	},
	{
		id: "followup",
		group: "Session & Composer",
		label: "Queue follow-up for next turn",
		when: "Composer focused",
		defaultMac: "⌘Enter",
		defaultOther: "Ctrl+Enter",
	},
	{
		id: "stop",
		group: "Session & Composer",
		label: "Stop running thread",
		when: "Thread running",
		defaultMac: "Esc",
		defaultOther: "Esc",
		fixed: true,
	},
	{
		id: "new-session",
		group: "Session & Composer",
		label: "New session",
		when: "Always",
		defaultMac: "⌘N",
		defaultOther: "Ctrl+N",
	},
	{
		id: "fork-thread",
		group: "Session & Composer",
		label: "Fork conversation at latest turn",
		when: "Session focused",
		defaultMac: "⌘⇧F",
		defaultOther: "Ctrl+Shift+F",
	},
	{
		id: "model-picker",
		group: "Session & Composer",
		label: "Switch model",
		when: "Session focused",
		defaultMac: "⌘M",
		defaultOther: "Ctrl+M",
	},
	{
		id: "layout-toggle",
		group: "Window Layout",
		label: "Toggle Tiled / Focused view",
		when: "Workspace active",
		defaultMac: "⌘⇧L",
		defaultOther: "Ctrl+Shift+L",
	},
	{
		id: "panel-next",
		group: "Window Layout",
		label: "Focus next panel",
		when: "Workspace active",
		defaultMac: "⌘]",
		defaultOther: "Ctrl+]",
	},
	{
		id: "panel-prev",
		group: "Window Layout",
		label: "Focus previous panel",
		when: "Workspace active",
		defaultMac: "⌘[",
		defaultOther: "Ctrl+[",
	},
	{
		id: "panel-pin",
		group: "Window Layout",
		label: "Pin or unpin focused panel",
		when: "Workspace active",
		defaultMac: "⌘⇧I",
		defaultOther: "Ctrl+Shift+I",
	},
	{
		id: "panel-close",
		group: "Window Layout",
		label: "Close focused panel",
		when: "Workspace active",
		defaultMac: "⌘W",
		defaultOther: "Ctrl+W",
	},
];

const GROUPS = ["Navigation", "Session & Composer", "Window Layout"] as const;

function formatRecordedKey(event: KeyboardEvent<HTMLButtonElement>): string | null {
	if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
	const parts: string[] = [];
	if (isMac) {
		if (event.ctrlKey) parts.push("⌃");
		if (event.altKey) parts.push("⌥");
		if (event.shiftKey) parts.push("⇧");
		if (event.metaKey) parts.push("⌘");
	} else {
		if (event.ctrlKey) parts.push("Ctrl+");
		if (event.altKey) parts.push("Alt+");
		if (event.shiftKey) parts.push("Shift+");
		if (event.metaKey) parts.push("Meta+");
	}
	const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
	return `${parts.join("")}${key}`;
}

export function KeybindingsSettings() {
	const [query, setQuery] = useState("");
	const [custom, setCustom] = useState<Readonly<Record<string, string>>>({});
	const [recordingId, setRecordingId] = useState<string | null>(null);

	const normalized = query.trim().toLowerCase();
	const filtered = SHORTCUTS.filter((item) => {
		if (normalized === "") return true;
		const binding = custom[item.id] ?? (isMac ? item.defaultMac : item.defaultOther);
		return `${item.label} ${item.group} ${item.when} ${binding}`.toLowerCase().includes(normalized);
	});

	const hasCustom = Object.keys(custom).length > 0;

	return (
		<Page
			title="Keybindings"
			description="Every keyboard shortcut handled across workspaces, conversations, and the command palette."
			actions={
				hasCustom ? (
					<Button size="sm" variant="secondary" onClick={() => setCustom({})}>
						<ArrowCounterClockwiseIcon className="size-3.5" aria-hidden />
						Reset all
					</Button>
				) : undefined
			}
		>
			<div className="relative">
				<MagnifyingGlassIcon
					className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-muted"
					aria-hidden
				/>
				<Input
					type="search"
					value={query}
					placeholder="Filter shortcuts by command or key…"
					aria-label="Filter keybindings"
					className={`${quietField} h-8 pl-8 text-xs`}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>

			{filtered.length === 0 ? (
				<EmptyState
					icon={<KeyboardIcon className="size-6" />}
					title="No matching shortcuts"
					description={`No keybinding matches “${query}”.`}
				/>
			) : (
				GROUPS.map((group) => {
					const items = filtered.filter((item) => item.group === group);
					if (items.length === 0) return null;
					return (
						<Section key={group} title={group}>
							<Group>
								{items.map((item) => {
									const defaultKeys = isMac ? item.defaultMac : item.defaultOther;
									const currentKeys = custom[item.id] ?? defaultKeys;
									const modified = custom[item.id] !== undefined && custom[item.id] !== defaultKeys;
									const recording = recordingId === item.id;
									return (
										<div
											key={item.id}
											className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-ui"
										>
											<div className="flex min-w-0 flex-1 flex-col gap-0.5">
												<div className="flex items-center gap-2">
													<span className="truncate font-medium text-ink">{item.label}</span>
													{modified && <Badge tone="info">Modified</Badge>}
												</div>
												<span className="text-xs text-ink-muted">{item.when}</span>
											</div>
											<div className="flex shrink-0 items-center gap-1.5">
												{modified && (
													<Button
														size="icon-xs"
														variant="ghost"
														aria-label={`Reset ${item.label} shortcut`}
														title="Reset to default"
														onClick={() =>
															setCustom((prev) => {
																const { [item.id]: _, ...rest } = prev;
																return rest;
															})
														}
													>
														<ArrowCounterClockwiseIcon className="size-3.5" />
													</Button>
												)}
												{item.fixed ? (
													<span title="Built-in shortcut">
														<Keys>{currentKeys}</Keys>
													</span>
												) : (
													<button
														type="button"
														aria-label={`Change shortcut for ${item.label}`}
														title="Click to record a new shortcut"
														onClick={() => setRecordingId(recording ? null : item.id)}
														onBlur={() => recording && setRecordingId(null)}
														onKeyDown={(event) => {
															if (!recording) return;
															event.preventDefault();
															event.stopPropagation();
															if (event.key === "Escape") {
																setRecordingId(null);
																return;
															}
															const next = formatRecordedKey(event);
															if (next !== null) {
																setCustom((prev) => ({ ...prev, [item.id]: next }));
																setRecordingId(null);
															}
														}}
														className={`rounded-md border px-2 py-0.5 font-sans text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
															recording
																? "border-brand bg-brand/10 text-brand"
																: "border-edge bg-ink/5 text-ink-muted hover:border-edge-focus hover:text-ink"
														}`}
													>
														{recording ? "Press keys… (Esc to cancel)" : currentKeys}
													</button>
												)}
											</div>
										</div>
									);
								})}
							</Group>
						</Section>
					);
				})
			)}
		</Page>
	);
}
