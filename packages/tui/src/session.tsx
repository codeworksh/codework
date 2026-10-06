import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import TextInput from "ink-text-input";
import {
	createSession,
	ensureServerRunning,
	interruptSession,
	promptSession,
	type SessionInfoResult,
	type UsageReport,
} from "./client.ts";
import type { ModelConfig } from "./config.ts";
import { getFormattedLocation, truncateLocation } from "./git.ts";
import { renderMarkdownLines, wrapString } from "./markdown.tsx";
import { registry } from "./registry.ts";
import { Spinner } from "./spinner.tsx";

export interface SessionViewProps {
	readonly initialPrompt: string;
	readonly config: ModelConfig;
	readonly onExit: () => void;
}

interface ConversationTurn {
	readonly id: string;
	readonly prompt: string;
	response: string;
	thinking: string;
	streaming: boolean;
	startTime: number;
	endTime?: number | undefined;
	tokens: number;
	tokensPerSec: number;
	modelName: string;
	error?: string | undefined;
	activeTool?: string | undefined;
	completedTools: readonly string[];
}

interface SessionStats {
	totalTokens: number;
	cost: number;
	turnsCount: number;
}

const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function SessionView({ initialPrompt, config, onExit }: SessionViewProps) {
	const { columns: winCols, rows: winRows } = useWindowSize();
	const columns = Math.max(winCols || 80, 80);
	const rows = Math.max(winRows || 24, 24);

	const sidebarWidth = Math.min(28, Math.max(22, Math.floor(columns * 0.25)));
	const mainWidth = columns - sidebarWidth - 2;

	const [sessionInfo, setSessionInfo] = useState<SessionInfoResult | null>(null);
	const [serverStatus, setServerStatus] = useState<"connecting" | "ready" | "error">("connecting");
	const [serverError, setServerError] = useState<string | null>(null);

	const [turns, setTurns] = useState<readonly ConversationTurn[]>([]);
	const [isStreaming, setIsStreaming] = useState(false);
	const [inputQuery, setInputQuery] = useState("");
	const [inputKey, setInputKey] = useState(0);
	const [scrollOffset, setScrollOffset] = useState<number | null>(null);

	const [stats, setStats] = useState<SessionStats>({
		totalTokens: 0,
		cost: 0,
		turnsCount: 0,
	});

	const activeSessionIdRef = useRef<string | null>(null);
	const isMountedRef = useRef(true);

	// Get friendly names from registry
	const providerDef = registry.get(config.provider);
	const modelDef = providerDef?.getModels().find((m) => m.id === config.model);
	const displayModelName = modelDef?.name ?? config.model;
	const displayProviderName = providerDef?.name ?? config.provider;

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	// Initialize session and send initial prompt
	useEffect(() => {
		let isCancelled = false;

		async function initSession() {
			setServerStatus("connecting");
			const running = await ensureServerRunning();
			if (isCancelled) return;

			if (!running) {
				setServerStatus("error");
				setServerError("Could not connect to CodeWork server (ws://127.0.0.1:7433/rpc)");
				return;
			}

			setServerStatus("ready");

			try {
				const info = await createSession({
					provider: config.provider,
					modelId: config.model,
					thinkingLevel: "high",
				});

				if (isCancelled) return;
				setSessionInfo(info);
				activeSessionIdRef.current = info.id;

				// Dispatch initial prompt
				await runTurn(info.id, initialPrompt);
			} catch (err) {
				if (isCancelled) return;
				setServerStatus("error");
				setServerError(err instanceof Error ? err.message : String(err));
			}
		}

		void initSession();

		return () => {
			isCancelled = true;
		};
	}, []);

	async function runTurn(sessionId: string, text: string) {
		const turnId = Date.now().toString();
		const startTime = Date.now();

		const newTurn: ConversationTurn = {
			id: turnId,
			prompt: text,
			response: "",
			thinking: "",
			streaming: true,
			startTime,
			tokens: 0,
			tokensPerSec: 0,
			modelName: displayModelName,
			completedTools: [],
		};

		setTurns((prev) => [...prev, newTurn]);
		setIsStreaming(true);

		let turnTokens = 0;

		try {
			await promptSession(
				{
					sessionId,
					text,
				},
				{
					onTextDelta: (delta) => {
						if (!isMountedRef.current) return;
						setTurns((prev) =>
							prev.map((t) => {
								if (t.id !== turnId) return t;
								const updatedResponse = t.response + delta;
								turnTokens += Math.max(1, Math.ceil(delta.length / 4));
								const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
								return {
									...t,
									response: updatedResponse,
									tokens: turnTokens,
									tokensPerSec: turnTokens / elapsedSec,
								};
							}),
						);
					},
					onThinkingDelta: (delta) => {
						if (!isMountedRef.current) return;
						setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, thinking: t.thinking + delta } : t)));
					},
					onToolStarted: (tool) => {
						if (!isMountedRef.current) return;
						setTurns((prev) =>
							prev.map((t) => (t.id === turnId ? { ...t, activeTool: tool.label ?? tool.name } : t)),
						);
					},
					onToolSettled: () => {
						if (!isMountedRef.current) return;
						setTurns((prev) =>
							prev.map((t) => {
								if (t.id !== turnId) return t;
								const settled = t.activeTool;
								return {
									...t,
									activeTool: undefined,
									completedTools: settled ? [...t.completedTools, settled] : t.completedTools,
								};
							}),
						);
					},
					onUsage: (usage: UsageReport) => {
						if (!isMountedRef.current) return;
						setStats((prev) => ({
							totalTokens: prev.totalTokens + usage.totalTokens,
							cost: prev.cost + usage.cost,
							turnsCount: prev.turnsCount + 1,
						}));
						setTurns((prev) =>
							prev.map((t) => {
								if (t.id !== turnId) return t;
								const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
								return {
									...t,
									tokens: usage.outputTokens || t.tokens,
									tokensPerSec: (usage.outputTokens || t.tokens) / elapsedSec,
								};
							}),
						);
					},
					onComplete: () => {
						if (!isMountedRef.current) return;
						const endTime = Date.now();
						const elapsedSec = Math.max(0.1, (endTime - startTime) / 1000);
						setTurns((prev) =>
							prev.map((t) => {
								if (t.id !== turnId) return t;
								const settled = t.activeTool;
								return {
									...t,
									streaming: false,
									endTime,
									tokensPerSec: t.tokens > 0 ? t.tokens / elapsedSec : 0,
									activeTool: undefined,
									completedTools: settled ? [...t.completedTools, settled] : t.completedTools,
								};
							}),
						);
						setIsStreaming(false);
					},
					onError: (errMsg) => {
						if (!isMountedRef.current) return;
						setTurns((prev) =>
							prev.map((t) =>
								t.id === turnId
									? {
											...t,
											streaming: false,
											error: errMsg,
											activeTool: undefined,
										}
									: t,
							),
						);
						setIsStreaming(false);
					},
				},
			);
		} catch (err) {
			if (!isMountedRef.current) return;
			const msg = err instanceof Error ? err.message : String(err);
			setTurns((prev) =>
				prev.map((t) => (t.id === turnId ? { ...t, streaming: false, error: msg, activeTool: undefined } : t)),
			);
			setIsStreaming(false);
		}
	}

	useInput((input, key) => {
		// Scrolling controls
		if (key.pageUp) {
			const pageSize = Math.max(1, viewportHeight - 2);
			const currentTop = scrollOffset === null ? maxScroll : scrollOffset;
			const newTop = Math.max(0, currentTop - pageSize);
			setScrollOffset(newTop);
			return;
		}

		if (key.pageDown) {
			const pageSize = Math.max(1, viewportHeight - 2);
			const currentTop = scrollOffset === null ? maxScroll : scrollOffset;
			const newTop = currentTop + pageSize;
			if (newTop >= maxScroll) {
				setScrollOffset(null);
			} else {
				setScrollOffset(newTop);
			}
			return;
		}

		if (key.home) {
			setScrollOffset(0);
			return;
		}

		if (key.end) {
			setScrollOffset(null);
			return;
		}

		if ((key.shift && key.upArrow) || (key.ctrl && key.upArrow) || (key.upArrow && inputQuery === "")) {
			const currentTop = scrollOffset === null ? maxScroll : scrollOffset;
			const newTop = Math.max(0, currentTop - 1);
			setScrollOffset(newTop);
			return;
		}

		if (
			(key.shift && key.downArrow) ||
			(key.ctrl && key.downArrow) ||
			(key.downArrow && inputQuery === "" && scrollOffset !== null)
		) {
			const currentTop = scrollOffset === null ? maxScroll : scrollOffset;
			const newTop = currentTop + 1;
			if (newTop >= maxScroll) {
				setScrollOffset(null);
			} else {
				setScrollOffset(newTop);
			}
			return;
		}

		if (key.ctrl && input === "u") {
			const halfPage = Math.max(1, Math.floor(viewportHeight / 2));
			const currentTop = scrollOffset === null ? maxScroll : scrollOffset;
			setScrollOffset(Math.max(0, currentTop - halfPage));
			return;
		}

		if (key.ctrl && input === "d") {
			const halfPage = Math.max(1, Math.floor(viewportHeight / 2));
			const currentTop = scrollOffset === null ? maxScroll : scrollOffset;
			const newTop = currentTop + halfPage;
			if (newTop >= maxScroll) {
				setScrollOffset(null);
			} else {
				setScrollOffset(newTop);
			}
			return;
		}

		if (key.escape) {
			if (isStreaming && activeSessionIdRef.current) {
				void interruptSession(activeSessionIdRef.current);
				return;
			}
			onExit();
			return;
		}

		if (key.ctrl && input === "c") {
			if (isStreaming && activeSessionIdRef.current) {
				void interruptSession(activeSessionIdRef.current);
				return;
			}
			onExit();
			return;
		}
	});

	const handleSubmitPrompt = (val: string) => {
		if (isStreaming) return;
		const trimmed = val.trim();
		if (!trimmed) return;

		if (trimmed === "/exit") {
			onExit();
			return;
		}

		if (trimmed === "/clear") {
			setTurns([]);
			setScrollOffset(null);
			setInputQuery("");
			return;
		}

		if (activeSessionIdRef.current) {
			setInputQuery("");
			setInputKey((k) => k + 1);
			setScrollOffset(null);
			void runTurn(activeSessionIdRef.current, trimmed);
		}
	};

	// Formatted stats
	const formattedLocation = getFormattedLocation();
	const truncatedLoc = truncateLocation(formattedLocation, sidebarWidth - 3);
	const percentUsed = Math.max(1, Math.round((stats.totalTokens / DEFAULT_CONTEXT_WINDOW) * 100));
	const formattedCost = `$${stats.cost.toFixed(stats.cost > 0 && stats.cost < 0.01 ? 4 : 2)}`;
	const sessionTitle = sessionInfo?.title ?? "Greeting";

	// Prepare flattened, wrapped lines for the conversation transcript
	const contentWidth = Math.max(30, mainWidth - 4);
	const allLines: React.ReactNode[] = [];

	if (serverStatus === "connecting") {
		allLines.push(
			<Box key="status-connecting" flexDirection="row" marginY={1}>
				<Spinner color="#06b6d4" />
				<Text color="#06b6d4"> Connecting to CodeWork server...</Text>
			</Box>,
		);
	}

	if (serverStatus === "error") {
		allLines.push(
			<Box key="status-err" flexDirection="column" marginY={1}>
				<Box flexDirection="row">
					<Text color="#ef4444" bold>
						✗ Server Error:{" "}
					</Text>
					<Text color="#f87171">{serverError}</Text>
				</Box>
				<Text color="#71717a">Press Esc to return</Text>
			</Box>,
		);
	}

	turns.forEach((turn, tIdx) => {
		// User Prompt lines: ❯ in cyan, prompt in cyan
		const promptSublines = wrapString(turn.prompt, Math.max(20, contentWidth - 4));
		promptSublines.forEach((pLine, pIdx) => {
			allLines.push(
				<Box key={`p-${turn.id}-${pIdx}`} flexDirection="row">
					<Text color="#06b6d4" bold>
						{pIdx === 0 ? "❯ " : "  "}
					</Text>
					<Text color="#38bdf8">{pLine}</Text>
				</Box>,
			);
		});
		allLines.push(<Text key={`p-gap-${turn.id}`}> </Text>);

		// Completed tools: ✓ in green
		if (turn.completedTools.length > 0) {
			turn.completedTools.forEach((toolName, cIdx) => {
				allLines.push(
					<Box key={`ctool-${turn.id}-${cIdx}`} flexDirection="row" paddingLeft={1}>
						<Text color="#10b981">✓ </Text>
						<Text color="#34d399">{toolName}</Text>
					</Box>,
				);
			});
		}

		// Active tool: animated spinner in yellow
		if (turn.activeTool) {
			allLines.push(
				<Box key={`tool-${turn.id}`} flexDirection="row" paddingLeft={1}>
					<Spinner color="#f59e0b" />
					<Text color="#fbbf24"> {turn.activeTool}</Text>
					<Text color="#71717a"> executing...</Text>
				</Box>,
			);
		}

		// Thinking activity: animated spinner in yellow
		if (turn.streaming && !turn.response && !turn.activeTool) {
			allLines.push(
				<Box key={`think-${turn.id}`} flexDirection="row" paddingLeft={1}>
					<Spinner color="#f59e0b" />
					<Text color="#fbbf24"> Thinking...</Text>
				</Box>,
			);
			if (turn.thinking) {
				const thinkLines = wrapString(turn.thinking.trim(), Math.max(20, contentWidth - 4));
				const lastFew = thinkLines.slice(-2);
				lastFew.forEach((tLine, thIdx) => {
					allLines.push(
						<Box key={`th-line-${turn.id}-${thIdx}`} paddingLeft={3}>
							<Text color="#a1a1aa">{tLine}</Text>
						</Box>,
					);
				});
			}
		}

		// Assistant Response lines
		if (turn.response) {
			const mdLines = renderMarkdownLines(turn.response, turn.streaming, contentWidth - 2);
			mdLines.forEach((mdLine, mIdx) => {
				allLines.push(
					<Box key={`md-${turn.id}-${mIdx}`} paddingLeft={1}>
						{mdLine}
					</Box>,
				);
			});
		}

		// Error lines: ✗ in red
		if (turn.error) {
			allLines.push(
				<Box key={`err-${turn.id}`} flexDirection="row" paddingLeft={1}>
					<Text color="#ef4444" bold>
						✗{" "}
					</Text>
					<Text color="#f87171">{turn.error}</Text>
				</Box>,
			);
		}

		// Metadata line: ● Build   Gemini 3.8 Flash   11.6s   46.1 tok/s
		if (turn.response.length > 0 || !turn.streaming) {
			const elapsed = turn.endTime
				? ((turn.endTime - turn.startTime) / 1000).toFixed(1)
				: ((Date.now() - turn.startTime) / 1000).toFixed(1);

			allLines.push(
				<Box key={`meta-${turn.id}`} flexDirection="row" marginTop={1} paddingLeft={1} alignItems="center">
					<Text color="#06b6d4">● </Text>
					<Text color="#06b6d4">Build</Text>
					<Text color="#3f3f46"> </Text>
					<Text color="#c084fc">{turn.modelName}</Text>
					<Text color="#3f3f46"> </Text>
					<Text color="#71717a">{elapsed}s</Text>
					{turn.tokensPerSec > 0 && (
						<>
							<Text color="#3f3f46"> </Text>
							<Text color="#52525b">{turn.tokensPerSec.toFixed(1)} tok/s</Text>
						</>
					)}
				</Box>,
			);
		}

		// Gap between turns
		if (tIdx < turns.length - 1) {
			allLines.push(<Text key={`gap-${turn.id}`}> </Text>);
		}
	});

	// Viewport & scrolling calculation
	const inputHeight = 5;
	const footerHeight = 2;
	const totalLines = allLines.length;
	const isScrolledUp =
		scrollOffset !== null && scrollOffset < Math.max(0, totalLines - (rows - inputHeight - footerHeight));
	const bannerHeight = isScrolledUp ? 1 : 0;
	const viewportHeight = Math.max(5, rows - inputHeight - footerHeight - bannerHeight);

	const maxScroll = Math.max(0, totalLines - viewportHeight);
	const effectiveScrollTop = scrollOffset === null ? maxScroll : Math.min(scrollOffset, maxScroll);
	const visibleLines = allLines.slice(effectiveScrollTop, effectiveScrollTop + viewportHeight);

	return (
		<Box width={columns} height={rows} flexDirection="row">
			{/* Left Main Column: Conversation + Bottom Input Area + Bottom Status */}
			<Box flexDirection="column" width={mainWidth} height={rows} justifyContent="space-between" paddingRight={1}>
				{/* Top / Middle: Conversation History */}
				<Box
					flexDirection="column"
					height={viewportHeight}
					justifyContent={totalLines < viewportHeight ? "flex-end" : "flex-start"}
					paddingLeft={1}
				>
					{visibleLines.map((line, idx) => (
						<Box key={`v-${effectiveScrollTop + idx}`}>{line}</Box>
					))}
				</Box>

				{/* Bottom Section of Left Column: Scroll badge + Input Box + Status Line */}
				<Box flexDirection="column" paddingLeft={1}>
					{isScrolledUp && (
						<Box flexDirection="row" paddingLeft={1} marginBottom={0}>
							<Text color="#06b6d4">
								▲ Scrolled up ({maxScroll - effectiveScrollTop} lines below) · PageDown / End to jump to bottom
							</Text>
						</Box>
					)}

					{/* Bottom Input Area */}
					<Box
						flexDirection="column"
						borderStyle="single"
						borderColor={isStreaming ? "#27272a" : "#3f3f46"}
						paddingX={1}
						marginTop={0}
					>
						<Box flexDirection="row">
							{isStreaming ? (
								<Box marginRight={1}>
									<Spinner color="#06b6d4" />
								</Box>
							) : (
								<Text color="#06b6d4" bold>
									❯{" "}
								</Text>
							)}
							<TextInput
								key={inputKey}
								value={inputQuery}
								onChange={setInputQuery}
								onSubmit={handleSubmitPrompt}
								placeholder={isStreaming ? "Agent is working... (Esc to interrupt)" : "Type your message..."}
							/>
						</Box>

						<Box marginY={0}>
							<Text color="#27272a">{"─".repeat(Math.max(20, mainWidth - 6))}</Text>
						</Box>

						<Box flexDirection="row">
							<Text color="#06b6d4">Build</Text>
							<Text color="#3f3f46"> · </Text>
							<Text color="#c084fc">{displayModelName}</Text>
							<Text color="#3f3f46"> · </Text>
							<Text color="#a855f7">{displayProviderName}</Text>
							<Text color="#3f3f46"> · </Text>
							<Text color="#71717a">High</Text>
						</Box>
					</Box>

					{/* Left Status Footer */}
					<Box justifyContent="space-between" paddingX={0} marginTop={0}>
						<Box flexDirection="row">
							<Text color="#52525b">{formattedLocation}</Text>
						</Box>
						<Box flexDirection="row">
							<Text color="#71717a">
								{stats.totalTokens > 0 ? `${(stats.totalTokens / 1000).toFixed(1)}K tokens` : "0 tokens"}
								<Text color="#3f3f46"> · </Text>
								{percentUsed}%<Text color="#3f3f46"> · </Text>
								<Text color={stats.cost > 0 ? "#10b981" : "#71717a"}>{formattedCost}</Text>
								{"   "}
								{totalLines > viewportHeight && (
									<>
										<Text color="#06b6d4">PgUp/PgDn </Text>
										<Text color="#52525b">Scroll </Text>
									</>
								)}
								<Text color="#a1a1aa">Ctrl+P </Text>
								<Text color="#52525b">Commands</Text>
							</Text>
						</Box>
					</Box>
				</Box>
			</Box>

			{/* Right Column (Sidebar) with distinct background color & left border */}
			<Box
				flexDirection="column"
				width={sidebarWidth}
				height={rows}
				backgroundColor="#18181b"
				borderStyle="single"
				borderTop={false}
				borderBottom={false}
				borderRight={false}
				borderLeft={true}
				borderColor="#27272a"
				paddingLeft={1}
				paddingRight={1}
				paddingTop={1}
				justifyContent="space-between"
			>
				{/* Sidebar Top: Session Title and Context Section */}
				<Box flexDirection="column">
					<Text color="#f4f4f5" bold>
						{sessionTitle}
					</Text>

					<Box flexDirection="column" marginTop={1}>
						<Text color="#71717a">Model</Text>
						<Text color="#c084fc">{displayModelName}</Text>
						<Text color="#71717a">{displayProviderName}</Text>
					</Box>

					<Box flexDirection="column" marginTop={1}>
						<Text color="#71717a">Context</Text>
						<Box flexDirection="row">
							<Text color="#e4e4e7">
								{stats.totalTokens > 0 ? NUMBER_FORMAT.format(stats.totalTokens) : "0"}
							</Text>
							<Text color="#71717a"> tokens</Text>
						</Box>
						<Box flexDirection="row">
							<Text color={percentUsed > 80 ? "#f59e0b" : "#e4e4e7"}>{percentUsed}%</Text>
							<Text color="#71717a"> used</Text>
						</Box>
						<Box flexDirection="row">
							<Text color={stats.cost > 0 ? "#10b981" : "#e4e4e7"}>{formattedCost}</Text>
							<Text color="#71717a"> spent</Text>
						</Box>
					</Box>
				</Box>

				{/* Sidebar Bottom: Truncated directory */}
				<Box marginBottom={0}>
					<Text color="#52525b">{truncatedLoc}</Text>
				</Box>
			</Box>
		</Box>
	);
}
