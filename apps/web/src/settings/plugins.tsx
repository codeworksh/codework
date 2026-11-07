import { Plus, Puzzle, RefreshCw, Trash2 } from "@/components/vuesax";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Code, Group, Page, quietField, Section } from "./blocks";
import { EmptyState, Segmented, StatusDot } from "./controls";
import { Badge } from "./servers/local";

interface BuiltinPlugin {
	readonly id: string;
	readonly domain: "tool" | "prompt";
	readonly description: string;
	readonly optIn?: boolean;
	readonly enabled: boolean;
}

interface ExternalPlugin {
	readonly id: string;
	readonly spec: string;
	readonly kind: "npm" | "local";
	readonly layer: "user" | "project";
	readonly domain: "tool" | "prompt" | "mcp" | "sandbox";
	readonly description: string;
	readonly enabled: boolean;
}

const INITIAL_BUILTINS: readonly BuiltinPlugin[] = [
	{
		id: "codework.tool.bash",
		domain: "tool",
		description: "Execute shell commands in the session's active sandbox.",
		enabled: true,
	},
	{
		id: "codework.tool.read",
		domain: "tool",
		description: "Read file contents and inspect images with line offset and limit.",
		enabled: true,
	},
	{
		id: "codework.tool.write",
		domain: "tool",
		description: "Create new files or overwrite existing files in the workspace.",
		enabled: true,
	},
	{
		id: "codework.tool.edit",
		domain: "tool",
		description: "Perform targeted, non-overlapping text replacements in files.",
		enabled: true,
	},
	{
		id: "codework.tool.grep",
		domain: "tool",
		description: "Search file contents with regular expressions and glob filters.",
		optIn: true,
		enabled: true,
	},
	{
		id: "codework.tool.find",
		domain: "tool",
		description: "Find files by name and glob pattern across the workspace.",
		optIn: true,
		enabled: true,
	},
	{
		id: "codework.tool.toolsearch",
		domain: "tool",
		description: "Discover and activate deferred tools from MCP servers and plugins.",
		enabled: true,
	},
	{
		id: "codework.prompt.default",
		domain: "prompt",
		description: "Render the default system prompt foundation and workspace environment sections.",
		enabled: true,
	},
];

const INITIAL_EXTERNAL: readonly ExternalPlugin[] = [
	{
		id: "proc",
		spec: "@codeworksh/codework-tool-proc@0.3.1",
		kind: "npm",
		layer: "user",
		domain: "tool",
		description: "Manage long-running background processes and inspect their output streams.",
		enabled: true,
	},
	{
		id: "prompt-life",
		spec: "@codeworksh/codework-prompt-life@0.2.0",
		kind: "npm",
		layer: "user",
		domain: "prompt",
		description: "Inject persistent project notes and session continuity context into the prompt.",
		enabled: true,
	},
	{
		id: "house-style",
		spec: "./extras/plugins/house-style.ts",
		kind: "local",
		layer: "project",
		domain: "prompt",
		description: "Project-specific TypeScript, Effect, and testing conventions for this repository.",
		enabled: true,
	},
];

export function PluginsSettings() {
	const [builtins, setBuiltins] = useState<readonly BuiltinPlugin[]>(INITIAL_BUILTINS);
	const [external, setExternal] = useState<readonly ExternalPlugin[]>(INITIAL_EXTERNAL);
	const [reloading, setReloading] = useState(false);
	const [reloadNote, setReloadNote] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);

	const reloadAll = () => {
		setReloading(true);
		setTimeout(() => {
			setReloading(false);
			setReloadNote(
				`Reloaded ${builtins.filter((b) => b.enabled).length + external.filter((e) => e.enabled).length} active plugins.`,
			);
		}, 450);
	};

	return (
		<Page
			title="Plugins"
			description="Extend CodeWork with npm packages or local modules that register tools, prompt sections, MCP servers, and sandbox drivers."
			actions={
				<div className="flex items-center gap-2">
					<Button size="sm" variant="ghost" disabled={reloading} className="text-ink-muted" onClick={reloadAll}>
						<RefreshCw className={`size-3.5 ${reloading ? "animate-spin" : ""}`} aria-hidden />
						<span className="hidden @min-[560px]:inline">{reloading ? "Reloading…" : "Reload"}</span>
					</Button>
					<Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
						<Plus aria-hidden />
						Add Plugin
					</Button>
				</div>
			}
		>
			{reloadNote !== null && (
				<div className="flex items-center justify-between rounded-lg border border-edge/60 bg-ink/3 px-3.5 py-2 text-xs text-ink-muted">
					<StatusDot tone="success">{reloadNote}</StatusDot>
					<button type="button" className="text-ink-muted hover:text-ink" onClick={() => setReloadNote(null)}>
						Dismiss
					</button>
				</div>
			)}

			<Section title="Installed & Local Plugins">
				{external.length === 0 ? (
					<EmptyState
						icon={<Puzzle className="size-6" />}
						title="No external plugins configured"
						description="Add an npm package or a local TypeScript/JavaScript module to settings.jsonc."
					/>
				) : (
					<Group>
						{external.map((plugin) => (
							<div key={plugin.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
								<div className="flex min-w-0 flex-1 items-start gap-3">
									<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-edge bg-ink/3 text-ink-muted">
										<Puzzle className="size-4" strokeWidth={1.75} aria-hidden />
									</span>
									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<div className="flex flex-wrap items-center gap-2">
											<span className="truncate font-mono text-ui font-medium text-ink">{plugin.spec}</span>
											<Badge tone={plugin.kind === "npm" ? "info" : "muted"}>{plugin.kind}</Badge>
											<Badge tone="muted">{plugin.domain}</Badge>
											<Badge tone="muted">{plugin.layer}</Badge>
										</div>
										<p className="text-xs text-ink-muted">{plugin.description}</p>
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<Button
										size="icon-xs"
										variant="ghost"
										aria-label={`Remove ${plugin.spec}`}
										title="Remove plugin"
										className="text-ink-muted hover:text-destructive"
										onClick={() => setExternal((current) => current.filter((item) => item.id !== plugin.id))}
									>
										<Trash2 className="size-3.5" />
									</Button>
									<Switch
										aria-label={`Enable ${plugin.spec}`}
										checked={plugin.enabled}
										onCheckedChange={(enabled) =>
											setExternal((current) =>
												current.map((item) => (item.id === plugin.id ? { ...item, enabled } : item)),
											)
										}
									/>
								</div>
							</div>
						))}
					</Group>
				)}
			</Section>

			<Section title="Built-in Plugins">
				<Group>
					{builtins.map((plugin) => (
						<div key={plugin.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<div className="flex flex-wrap items-center gap-2">
									<Code>{plugin.id}</Code>
									<Badge tone="muted">{plugin.domain}</Badge>
									{plugin.optIn && <Badge tone="info">Opt-in</Badge>}
								</div>
								<span className="text-xs text-ink-muted">{plugin.description}</span>
							</div>
							<Switch
								aria-label={`Enable ${plugin.id}`}
								checked={plugin.enabled}
								onCheckedChange={(enabled) =>
									setBuiltins((current) =>
										current.map((item) => (item.id === plugin.id ? { ...item, enabled } : item)),
									)
								}
							/>
						</div>
					))}
				</Group>
			</Section>

			{adding && (
				<AddPluginDialog
					onClose={() => setAdding(false)}
					onAdd={(entry) => {
						setExternal((current) => [...current, entry]);
						setAdding(false);
					}}
				/>
			)}
		</Page>
	);
}

function AddPluginDialog({
	onClose,
	onAdd,
}: {
	readonly onClose: () => void;
	readonly onAdd: (plugin: ExternalPlugin) => void;
}) {
	const [layer, setLayer] = useState<"user" | "project">("user");
	const [spec, setSpec] = useState("");
	const [description, setDescription] = useState("");

	const trimmed = spec.trim();
	const isLocal =
		trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed.startsWith("file:");

	const submit = () => {
		if (!trimmed) return;
		onAdd({
			id: `plugin-${Date.now()}`,
			spec: trimmed,
			kind: isLocal ? "local" : "npm",
			layer,
			domain: "tool",
			description:
				description.trim() || (isLocal ? "Local workspace plugin module." : "Installed npm plugin package."),
			enabled: true,
		});
	};

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-4 text-sm sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add Plugin</DialogTitle>
					<DialogDescription>
						Register an npm package or local module in{" "}
						<Code>{layer === "user" ? "~/.codework/settings.jsonc" : ".codework/settings.jsonc"}</Code>.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center justify-between">
					<span className="text-xs text-ink-muted">Settings layer</span>
					<Segmented
						label="Plugin layer"
						value={layer}
						options={[
							{ value: "user", label: "User" },
							{ value: "project", label: "Project" },
						]}
						onChange={setLayer}
					/>
				</div>

				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-xs text-ink-muted">
						<span>Package specifier or relative path</span>
						<Input
							value={spec}
							autoFocus
							placeholder="@acme/codework-tool-deploy@^1.0.0 or ./plugins/custom.ts"
							className={`${quietField} font-mono text-xs`}
							onChange={(event) => setSpec(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-ink-muted">
						<span>Notes (optional)</span>
						<Input
							value={description}
							placeholder="What this plugin provides."
							className={`${quietField} text-xs`}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</label>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button disabled={!trimmed} onClick={submit}>
						Add Plugin
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
