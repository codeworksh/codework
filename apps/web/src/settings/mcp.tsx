import {
	ArrowClockwiseIcon,
	CaretRightIcon,
	GlobeIcon,
	HardDrivesIcon,
	PlugsConnectedIcon,
	PlusIcon,
	TrashIcon,
	WarningIcon,
} from "@phosphor-icons/react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Code, Group, Page, quietField, Row, Section } from "./blocks";
import { EmptyState, Segmented, StatusDot, type StatusTone, Stepper } from "./controls";
import { Badge } from "./servers/local";

type Exposure = "direct" | "deferred" | "codemode" | "hidden";
type SharingScope = "session" | "space" | "app";
type ConfigLayer = "user" | "project";
type ServerState = "connected" | "authenticate" | "failed" | "disconnected" | "disabled";

interface McpToolItem {
	readonly name: string;
	readonly exposure: Exposure;
}

interface McpServerEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly transport: "stdio" | "http";
	readonly endpoint: string;
	readonly layer: ConfigLayer;
	readonly configPath: string;
	readonly scope: SharingScope;
	readonly exposure: Exposure;
	readonly enabled: boolean;
	readonly state: ServerState;
	readonly oauthSignedIn?: boolean | undefined;
	readonly error?: string | undefined;
	readonly resources: boolean;
	readonly tools: readonly McpToolItem[];
	readonly skipped?: readonly string[] | undefined;
}

const INITIAL_SERVERS: readonly McpServerEntry[] = [
	{
		id: "linear",
		name: "linear",
		description: "Search, create, and update Linear issues, cycles, and projects.",
		transport: "http",
		endpoint: "https://mcp.linear.app/mcp",
		layer: "user",
		configPath: "~/.codework/mcp.json",
		scope: "app",
		exposure: "deferred",
		enabled: true,
		state: "connected",
		oauthSignedIn: true,
		resources: true,
		tools: [
			{ name: "list_issues", exposure: "deferred" },
			{ name: "get_issue", exposure: "deferred" },
			{ name: "create_issue", exposure: "deferred" },
			{ name: "update_issue", exposure: "deferred" },
			{ name: "list_projects", exposure: "deferred" },
			{ name: "list_teams", exposure: "deferred" },
		],
	},
	{
		id: "filesystem",
		name: "filesystem",
		description: "Read and manage workspace files through the MCP reference server.",
		transport: "stdio",
		endpoint: "npx -y @modelcontextprotocol/server-filesystem .",
		layer: "project",
		configPath: ".codework/mcp.json",
		scope: "session",
		exposure: "direct",
		enabled: true,
		state: "connected",
		resources: true,
		tools: [
			{ name: "read_text_file", exposure: "direct" },
			{ name: "write_file", exposure: "direct" },
			{ name: "list_directory", exposure: "direct" },
			{ name: "search_files", exposure: "direct" },
		],
	},
	{
		id: "sentry",
		name: "sentry",
		description: "Inspect production issues, stack traces, and release health from Sentry.",
		transport: "http",
		endpoint: "https://mcp.sentry.dev/mcp",
		layer: "user",
		configPath: "~/.codework/mcp.json",
		scope: "space",
		exposure: "deferred",
		enabled: true,
		state: "authenticate",
		oauthSignedIn: false,
		error: 'MCP server "sentry" requires sign-in. Authenticate via OAuth to load its tools.',
		resources: false,
		tools: [],
	},
	{
		id: "postgres",
		name: "postgres",
		description: "Inspect schema and run read-only SQL queries against local Postgres.",
		transport: "stdio",
		endpoint: "uvx mcp-server-postgres --dsn ${DATABASE_URL}",
		layer: "project",
		configPath: ".codework/mcp.json",
		scope: "session",
		exposure: "direct",
		enabled: true,
		state: "failed",
		error: "Environment variable DATABASE_URL is not set or empty.",
		resources: true,
		tools: [{ name: "query", exposure: "direct" }],
		skipped: ["raw_admin_dump"],
	},
	{
		id: "playwright",
		name: "playwright",
		description: "Drive a headless browser for UI inspection and end-to-end verification.",
		transport: "stdio",
		endpoint: "npx @playwright/mcp@latest",
		layer: "user",
		configPath: "~/.codework/mcp.json",
		scope: "session",
		exposure: "deferred",
		enabled: false,
		state: "disabled",
		resources: false,
		tools: [
			{ name: "browser_navigate", exposure: "deferred" },
			{ name: "browser_snapshot", exposure: "deferred" },
			{ name: "browser_click", exposure: "deferred" },
		],
	},
];

function stateMeta(server: McpServerEntry): { tone: StatusTone; badge: string; detail: string } {
	if (!server.enabled || server.state === "disabled") {
		return { tone: "muted", badge: "Disabled", detail: "Disabled in configuration" };
	}
	switch (server.state) {
		case "connected":
			return {
				tone: "success",
				badge: "Connected",
				detail: `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}${server.resources ? " · resources" : ""}`,
			};
		case "authenticate":
			return { tone: "warning", badge: "Needs sign-in", detail: "OAuth authentication required" };
		case "failed":
			return { tone: "danger", badge: "Failed", detail: server.error ?? "Connection failed" };
		case "disconnected":
			return { tone: "muted", badge: "Disconnected", detail: "Closed until reconnected" };
	}
}

export function McpSettings() {
	const [servers, setServers] = useState<readonly McpServerEntry[]>(INITIAL_SERVERS);
	const [filter, setFilter] = useState<"all" | ConfigLayer>("all");
	const [expandedId, setExpandedId] = useState<string | null>("linear");
	const [refreshing, setRefreshing] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);

	const [toolSearchEnabled, setToolSearchEnabled] = useState(true);
	const [startupTimeoutSec, setStartupTimeoutSec] = useState(10);
	const [idleTimeoutMin, setIdleTimeoutMin] = useState(10);

	const visible = servers.filter((server) => filter === "all" || server.layer === filter);

	const refreshAll = () => {
		setRefreshing(true);
		setTimeout(() => setRefreshing(false), 500);
	};

	const updateServer = (id: string, patch: Partial<McpServerEntry>) => {
		setServers((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
	};

	const signInServer = (server: McpServerEntry) => {
		setBusyId(server.id);
		setTimeout(() => {
			updateServer(server.id, {
				state: "connected",
				oauthSignedIn: true,
				error: undefined,
				tools:
					server.tools.length > 0
						? server.tools
						: [
								{ name: "list_issues", exposure: server.exposure },
								{ name: "get_event_trace", exposure: server.exposure },
								{ name: "search_releases", exposure: server.exposure },
							],
			});
			setBusyId(null);
		}, 500);
	};

	const reconnectServer = (server: McpServerEntry) => {
		setBusyId(server.id);
		setTimeout(() => {
			updateServer(server.id, {
				state: "connected",
				error: undefined,
			});
			setBusyId(null);
		}, 450);
	};

	return (
		<Page
			title="MCP"
			description="Connect Model Context Protocol servers over stdio or streamable HTTP and control how their tools reach the model."
			actions={
				<div className="flex items-center gap-2">
					<Button size="sm" variant="ghost" disabled={refreshing} className="text-ink-muted" onClick={refreshAll}>
						<ArrowClockwiseIcon className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
						<span className="hidden @min-[560px]:inline">{refreshing ? "Checking…" : "Refresh"}</span>
					</Button>
					<Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
						<PlusIcon aria-hidden />
						Add Server
					</Button>
				</div>
			}
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Segmented
					label="Filter MCP servers by configuration layer"
					value={filter}
					options={[
						{ value: "all", label: `All (${servers.length})` },
						{ value: "user", label: `User (${servers.filter((s) => s.layer === "user").length})` },
						{ value: "project", label: `Project (${servers.filter((s) => s.layer === "project").length})` },
					]}
					onChange={setFilter}
				/>
				<span className="text-xs text-ink-muted">
					Tools reach the model as <Code>mcp__&lt;server&gt;__&lt;tool&gt;</Code>
				</span>
			</div>

			<Section title="Configured Servers">
				{visible.length === 0 ? (
					<EmptyState
						icon={<PlugsConnectedIcon className="size-6" />}
						title="No MCP servers in this scope"
						description="Add a stdio or streamable HTTP MCP server to give its tools and resources to the model."
						action={
							<Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
								<PlusIcon aria-hidden />
								Add Server
							</Button>
						}
					/>
				) : (
					<Group>
						{visible.map((server) => {
							const meta = stateMeta(server);
							const expanded = expandedId === server.id;
							const busy = busyId === server.id;
							return (
								<div key={server.id} className="flex flex-col">
									<div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
										<button
											type="button"
											aria-expanded={expanded}
											aria-label={`${expanded ? "Collapse" : "Expand"} ${server.name} details`}
											onClick={() => setExpandedId(expanded ? null : server.id)}
											className="flex min-w-0 flex-1 items-start gap-3 text-left outline-none"
										>
											<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-edge bg-ink/3 text-ink-muted">
												{server.transport === "http" ? (
													<GlobeIcon className="size-4" aria-hidden />
												) : (
													<HardDrivesIcon className="size-4" aria-hidden />
												)}
											</span>
											<div className="flex min-w-0 flex-1 flex-col gap-1">
												<div className="flex flex-wrap items-center gap-2">
													<span className="font-mono text-ui font-medium text-ink">{server.name}</span>
													<Badge tone={meta.tone}>{meta.badge}</Badge>
													<Badge tone="muted">{server.transport}</Badge>
													<Badge tone="muted">{server.layer}</Badge>
													{server.exposure === "deferred" && <Badge tone="info">deferred</Badge>}
												</div>
												<p className="truncate text-xs text-ink-muted">{server.description}</p>
												<StatusDot tone={meta.tone}>
													{meta.detail} · scope: {server.scope} · {server.configPath}
												</StatusDot>
											</div>
											<CaretRightIcon
												className={`mt-1 size-4 shrink-0 text-ink-muted transition-transform ${
													expanded ? "rotate-90" : ""
												}`}
												aria-hidden
											/>
										</button>

										<div className="flex shrink-0 items-center gap-2">
											{server.enabled && server.state === "authenticate" && (
												<Button
													size="sm"
													variant="secondary"
													disabled={busy}
													onClick={() => signInServer(server)}
												>
													{busy ? "Signing in…" : "Sign in"}
												</Button>
											)}
											{server.enabled && (server.state === "failed" || server.state === "disconnected") && (
												<Button
													size="sm"
													variant="secondary"
													disabled={busy}
													onClick={() => reconnectServer(server)}
												>
													<ArrowClockwiseIcon
														className={`size-3.5 ${busy ? "animate-spin" : ""}`}
														aria-hidden
													/>
													{busy ? "Reconnecting…" : "Reconnect"}
												</Button>
											)}
											<Switch
												aria-label={`Enable ${server.name}`}
												checked={server.enabled}
												onCheckedChange={(enabled) =>
													updateServer(server.id, {
														enabled,
														state: enabled ? "connected" : "disabled",
													})
												}
											/>
										</div>
									</div>

									{expanded && (
										<div className="flex flex-col gap-3 border-t border-edge/40 bg-ink/2 px-4 py-3.5 text-xs">
											{server.error !== undefined && (
												<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive">
													<WarningIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
													<span>{server.error}</span>
												</div>
											)}

											{server.skipped !== undefined && server.skipped.length > 0 && (
												<div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
													<WarningIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
													<span>
														Skipped {server.skipped.length} invalid tool schema (
														{server.skipped.join(", ")}). See <Code>~/.codework/mcp.log</Code>.
													</span>
												</div>
											)}

											<div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-3">
												<div className="flex flex-col gap-1">
													<span className="text-ink-muted">
														{server.transport === "http" ? "Endpoint URL" : "Command"}
													</span>
													<code className="truncate rounded-md border border-edge/60 bg-ink/4 px-2 py-1.5 font-mono text-2xs text-ink">
														{server.endpoint}
													</code>
												</div>
												<div className="flex flex-col gap-1">
													<span className="text-ink-muted">Tool exposure</span>
													<Select
														value={server.exposure}
														onValueChange={(value) =>
															updateServer(server.id, { exposure: value as Exposure })
														}
													>
														<SelectTrigger
															size="sm"
															aria-label={`${server.name} tool exposure`}
															className={`${quietField} h-7 w-full text-xs`}
														>
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															<SelectItem value="direct" className="text-xs">
																direct (always in prompt)
															</SelectItem>
															<SelectItem value="deferred" className="text-xs">
																deferred (via toolsearch)
															</SelectItem>
															<SelectItem value="codemode" className="text-xs">
																codemode (scripts only)
															</SelectItem>
															<SelectItem value="hidden" className="text-xs">
																hidden
															</SelectItem>
														</SelectContent>
													</Select>
												</div>
												<div className="flex flex-col gap-1">
													<span className="text-ink-muted">Instance sharing scope</span>
													<Select
														value={server.scope}
														onValueChange={(value) =>
															updateServer(server.id, { scope: value as SharingScope })
														}
													>
														<SelectTrigger
															size="sm"
															aria-label={`${server.name} sharing scope`}
															className={`${quietField} h-7 w-full text-xs`}
														>
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															<SelectItem value="session" className="text-xs">
																session (isolated per session)
															</SelectItem>
															<SelectItem value="space" className="text-xs">
																space (shared per folder)
															</SelectItem>
															<SelectItem value="app" className="text-xs">
																app (shared across sessions)
															</SelectItem>
														</SelectContent>
													</Select>
												</div>
											</div>

											{server.tools.length > 0 && (
												<div className="flex flex-col gap-1.5">
													<span className="text-ink-muted">
														Tools ({server.tools.length}){server.resources && " + MCP resource tools"}
													</span>
													<div className="flex flex-wrap gap-1.5">
														{server.tools.map((tool) => (
															<span
																key={tool.name}
																className="inline-flex items-center gap-1.5 rounded-md border border-edge/60 bg-ink/4 px-2 py-0.5 font-mono text-2xs text-ink"
															>
																<span>{tool.name}</span>
																<span className="text-ink-muted">· {server.exposure}</span>
															</span>
														))}
													</div>
												</div>
											)}

											<div className="flex items-center justify-between pt-1">
												<span className="text-2xs text-ink-muted">
													Defined in <Code>{server.configPath}</Code>
												</span>
												<div className="flex items-center gap-2">
													{server.enabled && server.state === "connected" && (
														<Button
															size="xs"
															variant="ghost"
															className="text-ink-muted"
															onClick={() => updateServer(server.id, { state: "disconnected" })}
														>
															Disconnect
														</Button>
													)}
													{server.oauthSignedIn && (
														<Button
															size="xs"
															variant="ghost"
															className="text-ink-muted"
															onClick={() =>
																updateServer(server.id, {
																	oauthSignedIn: false,
																	state: "authenticate",
																	error: `Signed out of "${server.name}".`,
																})
															}
														>
															Sign out OAuth
														</Button>
													)}
													<Button
														size="xs"
														variant="ghost"
														className="text-destructive hover:text-destructive"
														onClick={() =>
															setServers((current) => current.filter((item) => item.id !== server.id))
														}
													>
														<TrashIcon className="size-3" aria-hidden />
														Remove
													</Button>
												</div>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</Group>
				)}
			</Section>

			<Section title="Discovery & Timeouts">
				<Group>
					<Row
						title={
							<span className="inline-flex items-center gap-2">
								<span>Deferred tool search</span>
								<Code>codework.tool.toolsearch</Code>
							</span>
						}
						description="Let the model search and load tools on demand from servers configured with deferred exposure."
					>
						<Switch
							aria-label="Deferred tool search"
							checked={toolSearchEnabled}
							onCheckedChange={setToolSearchEnabled}
						/>
					</Row>
					<Row
						title="Startup wait"
						description="How long a turn or toolsearch waits for newly started servers to finish connecting."
					>
						<Stepper
							label="Startup wait in seconds"
							value={startupTimeoutSec}
							min={2}
							max={60}
							step={2}
							unit="seconds"
							onChange={setStartupTimeoutSec}
						/>
					</Row>
					<Row
						title="Idle connection timeout"
						description="Close running MCP server instances after this long with no active turn."
					>
						<Stepper
							label="Idle connection timeout in minutes"
							value={idleTimeoutMin}
							min={1}
							max={60}
							step={1}
							unit="minutes"
							onChange={setIdleTimeoutMin}
						/>
					</Row>
				</Group>
			</Section>

			{adding && (
				<AddMcpServerDialog
					onClose={() => setAdding(false)}
					onAdd={(entry) => {
						setServers((current) => [...current, entry]);
						setExpandedId(entry.id);
						setAdding(false);
					}}
				/>
			)}
		</Page>
	);
}

function AddMcpServerDialog({
	onClose,
	onAdd,
}: {
	readonly onClose: () => void;
	readonly onAdd: (server: McpServerEntry) => void;
}) {
	const [transport, setTransport] = useState<"stdio" | "http">("stdio");
	const [layer, setLayer] = useState<ConfigLayer>("user");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [endpoint, setEndpoint] = useState("");
	const [exposure, setExposure] = useState<Exposure>("direct");
	const [scope, setScope] = useState<SharingScope>("session");

	const canSubmit = name.trim() !== "" && endpoint.trim() !== "";

	const submit = () => {
		if (!canSubmit) return;
		const cleanName = name.trim().replace(/[^A-Za-z0-9_-]/g, "-");
		onAdd({
			id: `${cleanName}-${Date.now()}`,
			name: cleanName,
			description: description.trim() || `Custom ${transport.toUpperCase()} MCP server.`,
			transport,
			endpoint: endpoint.trim(),
			layer,
			configPath: layer === "user" ? "~/.codework/mcp.json" : ".codework/mcp.json",
			scope,
			exposure,
			enabled: true,
			state: "connected",
			resources: false,
			tools: [{ name: "example_tool", exposure }],
		});
	};

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-4 text-sm sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add MCP Server</DialogTitle>
					<DialogDescription>
						Write a new entry to <Code>{layer === "user" ? "~/.codework/mcp.json" : ".codework/mcp.json"}</Code>.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-wrap items-center justify-between gap-2">
					<Segmented
						label="Transport"
						value={transport}
						options={[
							{ value: "stdio", label: "Stdio process" },
							{ value: "http", label: "Streamable HTTP" },
						]}
						onChange={setTransport}
					/>
					<Segmented
						label="Configuration file"
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
						<span>Server name</span>
						<Input
							value={name}
							autoFocus
							placeholder="github"
							className={`${quietField} font-mono text-xs`}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-ink-muted">
						<span>{transport === "stdio" ? "Command & arguments" : "Server URL"}</span>
						<Input
							value={endpoint}
							placeholder={
								transport === "stdio"
									? "npx -y @modelcontextprotocol/server-github"
									: "https://mcp.example.com/mcp"
							}
							className={`${quietField} font-mono text-xs`}
							onChange={(event) => setEndpoint(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-ink-muted">
						<span>Description (shown in system prompt for deferred servers)</span>
						<Input
							value={description}
							placeholder="What this server offers, in a sentence."
							className={`${quietField} text-xs`}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</label>
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1 text-xs text-ink-muted">
							<span>Exposure</span>
							<Select value={exposure} onValueChange={(v) => setExposure(v as Exposure)}>
								<SelectTrigger size="sm" aria-label="Exposure" className={`${quietField} w-full text-xs`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="direct" className="text-xs">
										direct
									</SelectItem>
									<SelectItem value="deferred" className="text-xs">
										deferred
									</SelectItem>
									<SelectItem value="codemode" className="text-xs">
										codemode
									</SelectItem>
									<SelectItem value="hidden" className="text-xs">
										hidden
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1 text-xs text-ink-muted">
							<span>Sharing scope</span>
							<Select value={scope} onValueChange={(v) => setScope(v as SharingScope)}>
								<SelectTrigger size="sm" aria-label="Sharing scope" className={`${quietField} w-full text-xs`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="session" className="text-xs">
										session
									</SelectItem>
									<SelectItem value="space" className="text-xs">
										space
									</SelectItem>
									<SelectItem value="app" className="text-xs">
										app
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button disabled={!canSubmit} onClick={submit}>
						Add Server
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
