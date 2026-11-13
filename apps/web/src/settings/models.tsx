import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { ProviderIcon } from "@/components/provider";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Code, Group, Page, quietField, Row, Section } from "./blocks";
import { Segmented, StatusDot, Stepper } from "./controls";
import { Badge } from "./servers/local";

interface OAuthAccount {
	readonly id: "openai-codex" | "github-copilot";
	readonly providerIcon: string;
	readonly name: string;
	readonly subtitle: string;
	readonly connected: boolean;
	readonly detail: string;
}

interface EnvProvider {
	readonly id: string;
	readonly name: string;
	readonly envVar: string;
	readonly modelsCount: number;
	readonly configured: boolean;
}

const DEFAULT_MODELS = [
	{ value: "openai/gpt-5.4", provider: "openai", label: "GPT-5.4 (OpenAI)" },
	{ value: "openai-codex/gpt-5.3-codex", provider: "openai-codex", label: "GPT-5.3 Codex (Codex OAuth)" },
	{ value: "anthropic/claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6 (Anthropic)" },
	{ value: "anthropic/claude-opus-4-6", provider: "anthropic", label: "Claude Opus 4.6 (Anthropic)" },
	{ value: "google/gemini-2.5-pro", provider: "google", label: "Gemini 2.5 Pro (Google)" },
	{
		value: "openrouter/deepseek/deepseek-v4.1-flash",
		provider: "openrouter",
		label: "DeepSeek V4.1 Flash (OpenRouter)",
	},
] as const;

const THINKING_LEVELS = [
	{ value: "off", label: "Off" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Extra High" },
	{ value: "max", label: "Max" },
] as const;

export function ModelsSettings() {
	const [scope, setScope] = useState<"user" | "project">("user");
	const [oauth, setOauth] = useState<readonly OAuthAccount[]>([
		{
			id: "openai-codex",
			providerIcon: "openai-codex",
			name: "OpenAI Codex",
			subtitle: "ChatGPT Plus or Pro subscription via OAuth",
			connected: true,
			detail: "Connected · acct_94f2a8 · expires in 6d",
		},
		{
			id: "github-copilot",
			providerIcon: "github-copilot",
			name: "GitHub Copilot",
			subtitle: "GitHub Copilot subscription token",
			connected: false,
			detail: "Not signed in",
		},
	]);
	const [busyOauth, setBusyOauth] = useState<string | null>(null);

	const [envProviders] = useState<readonly EnvProvider[]>([
		{ id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", modelsCount: 8, configured: true },
		{ id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", modelsCount: 11, configured: true },
		{ id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY", modelsCount: 42, configured: true },
		{ id: "google", name: "Google Gemini", envVar: "GEMINI_API_KEY", modelsCount: 6, configured: false },
		{ id: "xai", name: "xAI", envVar: "XAI_API_KEY", modelsCount: 4, configured: false },
	]);

	const [defaultModel, setDefaultModel] = useState<string>("anthropic/claude-sonnet-4-6");
	const [thinkingLevel, setThinkingLevel] = useState<string>("medium");
	const [toolExecution, setToolExecution] = useState<"sequential" | "parallel">("sequential");
	const [cacheRetention, setCacheRetention] = useState<"none" | "short" | "long">("short");

	const [maxRetries, setMaxRetries] = useState(3);
	const [baseDelayMs, setBaseDelayMs] = useState(2000);
	const [maxDelayMs, setMaxDelayMs] = useState(60000);

	const toggleOauth = (id: OAuthAccount["id"]) => {
		setBusyOauth(id);
		setTimeout(() => {
			setOauth((current) =>
				current.map((item) =>
					item.id !== id
						? item
						: item.connected
							? { ...item, connected: false, detail: "Not signed in" }
							: {
									...item,
									connected: true,
									detail:
										id === "openai-codex"
											? "Connected · acct_94f2a8 · expires in 7d"
											: "Connected · 14 models available",
								},
				),
			);
			setBusyOauth(null);
		}, 450);
	};

	return (
		<Page
			title="Models"
			description="Sign in to model subscriptions, check provider credentials, and configure default model behavior."
			actions={
				<Segmented
					label="Configuration layer"
					value={scope}
					options={[
						{ value: "user", label: "User" },
						{ value: "project", label: "Project" },
					]}
					onChange={setScope}
				/>
			}
		>
			<Section title="Subscriptions (OAuth)">
				<Group>
					{oauth.map((account) => {
						const busy = busyOauth === account.id;
						return (
							<div
								key={account.id}
								className="flex flex-col items-start gap-3 px-4 py-3 @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:gap-4"
							>
								<div className="flex min-w-0 flex-1 items-start gap-3">
									<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-edge bg-ink/3 text-ink">
										<ProviderIcon id={account.providerIcon} name={account.name} className="size-4" />
									</span>
									<div className="flex min-w-0 flex-1 flex-col gap-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium text-ink">{account.name}</span>
											<Badge tone={account.connected ? "success" : "muted"}>
												{account.connected ? "Connected" : "Signed out"}
											</Badge>
										</div>
										<span className="text-xs text-ink-muted">{account.subtitle}</span>
										<StatusDot tone={account.connected ? "success" : "muted"}>{account.detail}</StatusDot>
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									{account.connected ? (
										<>
											<Button
												size="sm"
												variant="ghost"
												disabled={busy}
												className="text-ink-muted"
												onClick={() => toggleOauth(account.id)}
											>
												<ArrowClockwiseIcon
													className={`size-3.5 ${busy ? "animate-spin" : ""}`}
													aria-hidden
												/>
												Refresh
											</Button>
											<Button
												size="sm"
												variant="secondary"
												disabled={busy}
												onClick={() => toggleOauth(account.id)}
											>
												Sign out
											</Button>
										</>
									) : (
										<Button
											size="sm"
											variant="secondary"
											disabled={busy}
											onClick={() => toggleOauth(account.id)}
										>
											{busy ? "Signing in…" : "Sign in"}
										</Button>
									)}
								</div>
							</div>
						);
					})}
				</Group>
			</Section>

			<Section title="API Key Providers">
				<Group>
					{envProviders.map((provider) => (
						<div key={provider.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
							<div className="flex min-w-0 items-center gap-3">
								<span className="grid size-8 shrink-0 place-items-center rounded-lg border border-edge bg-ink/3 text-ink">
									<ProviderIcon id={provider.id} name={provider.name} className="size-4" />
								</span>
								<div className="flex min-w-0 flex-col gap-0.5">
									<div className="flex items-center gap-2">
										<span className="font-medium text-ink">{provider.name}</span>
										<Code>{`\${${provider.envVar}}`}</Code>
									</div>
									<span className="text-xs text-ink-muted">
										{provider.configured
											? `${provider.modelsCount} catalog models enabled`
											: "Set this variable in your provider server environment to enable."}
									</span>
								</div>
							</div>
							<Badge tone={provider.configured ? "success" : "muted"}>
								{provider.configured ? "Detected" : "Not set"}
							</Badge>
						</div>
					))}
				</Group>
			</Section>

			<Section
				title={
					scope === "user"
						? "Default Model (~/.codework/settings.jsonc)"
						: "Project Model (.codework/settings.jsonc)"
				}
			>
				<Group>
					<Row title="Model" description="Model used when a new session or thread does not specify one.">
						<Select value={defaultModel} onValueChange={setDefaultModel}>
							<SelectTrigger size="sm" aria-label="Default model" className={`${quietField} min-w-56 text-xs`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DEFAULT_MODELS.map((item) => (
									<SelectItem key={item.value} value={item.value} className="text-xs">
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Row>
					<Row
						title="Thinking level"
						description="Default reasoning effort; clamped automatically to what the chosen model supports."
					>
						<Select value={thinkingLevel} onValueChange={setThinkingLevel}>
							<SelectTrigger
								size="sm"
								aria-label="Default thinking level"
								className={`${quietField} min-w-36 text-xs`}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{THINKING_LEVELS.map((level) => (
									<SelectItem key={level.value} value={level.value} className="text-xs">
										{level.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Row>
					<Row
						title="Tool execution"
						description="Run multiple tool calls from a single model response one by one or in parallel."
					>
						<Segmented
							label="Tool execution"
							value={toolExecution}
							options={[
								{ value: "sequential", label: "Sequential" },
								{ value: "parallel", label: "Parallel" },
							]}
							onChange={setToolExecution}
						/>
					</Row>
					<Row
						title="Prompt cache retention"
						description="Cache system instructions and conversation prefixes on providers that support it."
					>
						<Segmented
							label="Prompt cache retention"
							value={cacheRetention}
							options={[
								{ value: "none", label: "None" },
								{ value: "short", label: "Short" },
								{ value: "long", label: "Long" },
							]}
							onChange={setCacheRetention}
						/>
					</Row>
				</Group>
			</Section>

			<Section title="Retry Policy">
				<Group>
					<Row
						title="Maximum retries"
						description="Automatic retry attempts on transient rate limits, overloads, or dropped connections."
					>
						<Stepper
							label="Maximum retries"
							value={maxRetries}
							min={0}
							max={10}
							step={1}
							onChange={setMaxRetries}
						/>
					</Row>
					<Row
						title="Base retry delay"
						description="Initial wait before the first retry; doubles after each attempt."
					>
						<Stepper
							label="Base retry delay in milliseconds"
							value={baseDelayMs}
							min={500}
							max={30000}
							step={500}
							unit="ms"
							onChange={setBaseDelayMs}
						/>
					</Row>
					<Row
						title="Maximum retry delay"
						description="Cap on exponential backoff wait time before failing the turn."
					>
						<Stepper
							label="Maximum retry delay in milliseconds"
							value={maxDelayMs}
							min={5000}
							max={300000}
							step={5000}
							unit="ms"
							onChange={setMaxDelayMs}
						/>
					</Row>
				</Group>
			</Section>
		</Page>
	);
}
