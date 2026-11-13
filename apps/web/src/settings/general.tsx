import { ArrowClockwiseIcon, CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { isMac } from "@codeworksh/widget/view";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Code, Group, Keys, Page, quietField, Row, Section } from "./blocks";
import { Badge } from "./servers/local";

const VERSION = "0.4.2";
const HOME_PATH = "~/.codework";

const EDITORS = [
	{ id: "cursor", label: "Cursor" },
	{ id: "vscode", label: "VS Code" },
	{ id: "zed", label: "Zed" },
	{ id: "system", label: "System default" },
] as const;

const TERMINALS = [
	{ id: "ghostty", label: "Ghostty" },
	{ id: "iterm", label: "iTerm2" },
	{ id: "warp", label: "Warp" },
	{ id: "terminal", label: "Terminal" },
] as const;

const RELEASE_HIGHLIGHTS = [
	"Streamable HTTP and stdio MCP server support with OAuth 2.1 sign-in and deferred tool search.",
	"Thread forking at any committed message with inherited conversation history.",
	"Multi-workspace tiling and monocle window layouts with keyboard navigation.",
	"Local and cloud sandbox drivers for isolated session execution.",
] as const;

export function GeneralSettings() {
	const [notifications, setNotifications] = useState(true);
	const [sounds, setSounds] = useState(false);
	const [quickComposer, setQuickComposer] = useState(true);
	const [confirmDelete, setConfirmDelete] = useState(true);
	const [editor, setEditor] = useState<string>("cursor");
	const [terminal, setTerminal] = useState<string>("ghostty");
	const [checking, setChecking] = useState(false);
	const [updateStatus, setUpdateStatus] = useState("CodeWork is up to date.");
	const [whatsNewOpen, setWhatsNewOpen] = useState(false);
	const [copied, setCopied] = useState(false);

	const checkUpdates = () => {
		setChecking(true);
		setTimeout(() => {
			setChecking(false);
			setUpdateStatus(`Checked just now · v${VERSION} is the latest release.`);
		}, 600);
	};

	const copyHome = () => {
		void navigator.clipboard?.writeText(HOME_PATH);
		setCopied(true);
		setTimeout(() => setCopied(false), 1800);
	};

	return (
		<Page title="General" description="How CodeWork alerts you, opens external tools, and stays up to date.">
			<Section title="Alerts">
				<Group>
					<Row
						title="Notifications"
						description="Alert when a background thread settles, fails, or needs your attention."
					>
						<Switch aria-label="Notifications" checked={notifications} onCheckedChange={setNotifications} />
					</Row>
					<Row title="Sounds" description="Play subtle audio cues for completed turns, errors, and updates.">
						<Switch aria-label="Sounds" checked={sounds} onCheckedChange={setSounds} />
					</Row>
				</Group>
			</Section>

			<Section title="Behavior">
				<Group>
					<Row
						title="Quick composer"
						description={
							<>
								Press <Keys>{isMac ? "⌘⇧Space" : "Ctrl+Shift+Space"}</Keys> from any app to start or steer a
								session.
							</>
						}
					>
						<Switch aria-label="Quick composer" checked={quickComposer} onCheckedChange={setQuickComposer} />
					</Row>
					<Row
						title="Confirm before deleting sessions"
						description="Ask for confirmation before permanently removing a session and its threads."
					>
						<Switch
							aria-label="Confirm before deleting sessions"
							checked={confirmDelete}
							onCheckedChange={setConfirmDelete}
						/>
					</Row>
					<Row title="External editor" description="Application used when opening project files or configuration.">
						<Select value={editor} onValueChange={setEditor}>
							<SelectTrigger size="sm" aria-label="External editor" className={`${quietField} min-w-36 text-xs`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{EDITORS.map((item) => (
									<SelectItem key={item.id} value={item.id} className="text-xs">
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Row>
					<Row title="Default terminal" description="Terminal launched when opening a session's working folder.">
						<Select value={terminal} onValueChange={setTerminal}>
							<SelectTrigger
								size="sm"
								aria-label="Default terminal"
								className={`${quietField} min-w-36 text-xs`}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TERMINALS.map((item) => (
									<SelectItem key={item.id} value={item.id} className="text-xs">
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Row>
				</Group>
			</Section>

			<Section title="About">
				<Group>
					<Row
						title={
							<span className="inline-flex items-center gap-2">
								<span>Version</span>
								<span className="font-mono text-xs font-normal text-ink-muted">v{VERSION}</span>
								<Badge tone="success">Latest</Badge>
							</span>
						}
						description={updateStatus}
					>
						<div className="flex shrink-0 items-center gap-2">
							<Button size="sm" variant="secondary" onClick={() => setWhatsNewOpen(true)}>
								What’s new
							</Button>
							<Button size="sm" variant="secondary" disabled={checking} onClick={checkUpdates}>
								<ArrowClockwiseIcon className={`size-3.5 ${checking ? "animate-spin" : ""}`} aria-hidden />
								{checking ? "Checking…" : "Check for updates"}
							</Button>
						</div>
					</Row>
					<Row
						title="Configuration directory"
						description={
							<>
								User settings (<Code>settings.jsonc</Code>), MCP servers (<Code>mcp.json</Code>), and OAuth
								tokens live in <Code>{HOME_PATH}</Code>.
							</>
						}
					>
						<Button size="sm" variant="ghost" className="text-ink-muted" onClick={copyHome}>
							{copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
							{copied ? "Copied" : "Copy path"}
						</Button>
					</Row>
				</Group>
			</Section>

			{whatsNewOpen && (
				<Dialog open onOpenChange={(next) => !next && setWhatsNewOpen(false)}>
					<DialogContent className="gap-4 text-sm sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>What’s new in CodeWork v{VERSION}</DialogTitle>
							<DialogDescription>Highlights from the latest release.</DialogDescription>
						</DialogHeader>
						<ul className="flex flex-col gap-2.5 text-ui text-ink-secondary">
							{RELEASE_HIGHLIGHTS.map((item) => (
								<li key={item} className="flex items-start gap-2.5">
									<span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
									<span>{item}</span>
								</li>
							))}
						</ul>
						<DialogFooter>
							<Button onClick={() => setWhatsNewOpen(false)}>Done</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</Page>
	);
}
