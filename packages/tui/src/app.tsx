import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import TextInput from "ink-text-input";
import { getConfigManager, type ModelConfig } from "./config.ts";
import { Logo } from "./logo.tsx";
import { ModelFlow } from "./model.tsx";
import { registry } from "./registry.ts";
import { SessionView } from "./session.tsx";

const CARD_WIDTH = 78;
const LEFT_WIDTH = 28;
const BORDER_COLOR = "#27272a";
const BASE_CONTENT_HEIGHT = 21;

const VERTICAL_DIVIDER = Array.from({ length: 13 }, () => "│").join("\n");

interface CommandItem {
	readonly name: string;
	readonly description: string;
}

const COMMANDS: readonly CommandItem[] = [
	{ name: "/help", description: "Show available commands and shortcuts" },
	{ name: "/clear", description: "Clear conversation history and screen" },
	{ name: "/model", description: "Switch or view active LLM model" },
	{ name: "/session", description: "List or resume recent sessions" },
	{ name: "/compact", description: "Compact current conversation context" },
	{ name: "/exit", description: "Exit CodeWork TUI" },
];

export function App() {
	const { exit } = useApp();
	const { columns: winCols, rows: winRows } = useWindowSize();
	const columns = Math.max(winCols || 80, CARD_WIDTH);
	const rows = Math.max(winRows || 24, 24);

	const [query, setQuery] = useState("");
	const [inputKey, setInputKey] = useState(0);
	const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);

	// Load active model config immediately on initial render
	const [activeConfig, setActiveConfig] = useState<ModelConfig | null>(() => {
		return getConfigManager().loadSync();
	});
	const [isModelFlowOpen, setIsModelFlowOpen] = useState(false);
	const [activePrompt, setActivePrompt] = useState<string | null>(null);
	const [isInSession, setIsInSession] = useState(false);

	const isDropdownOpen = query.startsWith("/") && !query.includes(" ");
	const filteredCommands = isDropdownOpen
		? COMMANDS.filter((cmd) => cmd.name.toLowerCase().startsWith(query.toLowerCase()))
		: [];

	useEffect(() => {
		if (process.stdout.isTTY) {
			process.stdout.write("\x1b]11;#000000\x07\x1b[40m\x1b[2J\x1b[H");
		}
		return () => {
			if (process.stdout.isTTY) {
				process.stdout.write("\x1b]111\x07\x1b[0m");
			}
		};
	}, []);

	// Refresh config asynchronously on mount in case file was modified externally
	useEffect(() => {
		void getConfigManager()
			.load()
			.then((saved) => {
				if (saved) {
					setActiveConfig(saved);
				}
			});
	}, []);

	// Auto-clear transient submission message after 4 seconds to return to connected model display
	useEffect(() => {
		if (!submittedMessage) return;
		const timer = setTimeout(() => {
			setSubmittedMessage(null);
		}, 4000);
		return () => clearTimeout(timer);
	}, [submittedMessage]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	const selectCommand = (cmd: CommandItem) => {
		if (cmd.name === "/model") {
			setIsModelFlowOpen(true);
			setQuery("");
			return;
		}
		setQuery(`${cmd.name} `);
		setInputKey((k) => k + 1);
	};

	useInput((input, key) => {
		if (isModelFlowOpen || isInSession) {
			return;
		}

		if (key.escape) {
			if (isDropdownOpen) {
				setQuery("");
				return;
			}
			exit();
			return;
		}
		if (key.ctrl && input === "c") {
			exit();
			return;
		}

		const isEnter = Boolean(key.return || input === "\r" || input === "\n");

		if (isDropdownOpen && filteredCommands.length > 0) {
			if (key.upArrow) {
				setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredCommands.length - 1));
				return;
			}
			if (key.downArrow) {
				setSelectedIndex((prev) => (prev < filteredCommands.length - 1 ? prev + 1 : 0));
				return;
			}
			if (isEnter || key.tab) {
				const selected = filteredCommands[selectedIndex];
				if (selected) {
					selectCommand(selected);
					return;
				}
			}
		}

		if (isEnter && !isDropdownOpen) {
			handleSubmit(query);
			return;
		}
	});

	const handleSubmit = (val: string) => {
		if (isDropdownOpen && filteredCommands.length > 0) {
			const selected = filteredCommands[selectedIndex];
			if (selected) {
				selectCommand(selected);
				return;
			}
		}
		const trimmed = val.trim();
		if (trimmed === "/model") {
			setIsModelFlowOpen(true);
			setQuery("");
			return;
		}
		if (trimmed === "/exit") {
			exit();
			return;
		}
		if (trimmed) {
			if (!activeConfig) {
				setSubmittedMessage("Please connect a model first (/model)");
				setIsModelFlowOpen(true);
				setQuery("");
				return;
			}
			setActivePrompt(trimmed);
			setIsInSession(true);
			setQuery("");
		}
	};

	const handleInputChange = (val: string) => {
		if (val.includes("\n") || val.includes("\r")) {
			if (isDropdownOpen && filteredCommands.length > 0) {
				const selected = filteredCommands[selectedIndex];
				if (selected) {
					selectCommand(selected);
					return;
				}
			}
			handleSubmit(query);
			return;
		}
		setQuery(val);
	};

	// Determine label for connected model
	const providerDef = activeConfig ? registry.get(activeConfig.provider) : undefined;
	const modelDef = providerDef?.getModels().find((m) => m.id === activeConfig?.model);

	const dropdownLines = isDropdownOpen ? Math.max(filteredCommands.length, 1) + 2 : 0;
	const flowLines = isModelFlowOpen ? 12 : 0;
	const totalContentHeight = BASE_CONTENT_HEIGHT + dropdownLines + flowLines;
	const verticalPadding = rows > totalContentHeight ? Math.floor((rows - totalContentHeight) / 2) : 0;

	if (isInSession && activePrompt && activeConfig) {
		return (
			<SessionView
				initialPrompt={activePrompt}
				config={activeConfig}
				onExit={() => {
					setIsInSession(false);
					setActivePrompt(null);
				}}
			/>
		);
	}

	return (
		<Box
			width={columns}
			minHeight={rows}
			paddingTop={verticalPadding}
			paddingBottom={verticalPadding}
			flexDirection="column"
			alignItems="center"
		>
			<Box flexDirection="column" width={CARD_WIDTH}>
				{/* Main Status / Welcome Card with single thin border */}
				<Box flexDirection="column" width={CARD_WIDTH} borderStyle="single" borderColor={BORDER_COLOR} paddingX={1}>
					{/* Header bar inside card */}
					<Box flexDirection="row" justifyContent="space-between">
						<Text>
							<Text color="white" bold>
								codework{" "}
							</Text>
							<Text color="#71717a">v0.0.1</Text>
						</Text>
						<Text color="#71717a">open-source harness</Text>
					</Box>

					{/* Thin header divider */}
					<Box marginY={0}>
						<Text color={BORDER_COLOR}>{"─".repeat(CARD_WIDTH - 4)}</Text>
					</Box>

					{/* Card content: Left and Right columns */}
					<Box flexDirection="row">
						{/* Left Column: Headline + Logo + Model info */}
						<Box flexDirection="column" width={LEFT_WIDTH} alignItems="center" justifyContent="center">
							<Text bold color="white">
								The Open-Source
							</Text>
							<Text color="cyan">Coding Agent Harness</Text>
							<Box marginY={1}>
								<Logo />
							</Box>
							<Text color="#c084fc">
								{activeConfig ? `${activeConfig.provider}:${activeConfig.model}` : "codework:default"}
							</Text>
							<Text color="#71717a">plugins • sandboxed</Text>
						</Box>

						{/* Vertical thin single divider */}
						<Box flexDirection="column" width={1} alignItems="center">
							<Text color={BORDER_COLOR}>{VERTICAL_DIVIDER}</Text>
						</Box>

						{/* Right Column: Agent Loop, Plugins, Platform */}
						<Box flexDirection="column" flexGrow={1} paddingLeft={2}>
							<Text bold color="cyan">
								Agent Loop & Tools
							</Text>
							<Text>
								<Text color="#a1a1aa">Understand </Text>
								<Text color="#71717a">search & read codebase</Text>
							</Text>
							<Text>
								<Text color="#a1a1aa">Modify </Text>
								<Text color="#71717a">edit files & apply diffs</Text>
							</Text>
							<Text>
								<Text color="#a1a1aa">Execute </Text>
								<Text color="#71717a">sandboxed commands & shell</Text>
							</Text>
							<Text>
								<Text color="#a1a1aa">Debug </Text>
								<Text color="#71717a">autonomous test & iterate</Text>
							</Text>

							{/* Divider */}
							<Box marginY={0}>
								<Text color={BORDER_COLOR}>{"─".repeat(40)}</Text>
							</Box>

							{/* Plugins & MCP */}
							<Text bold color="cyan">
								Plugins & MCP
							</Text>
							<Text>
								<Text color="#a1a1aa">Plugin SDK </Text>
								<Text color="#71717a">custom tools, drivers & hooks</Text>
							</Text>
							<Text>
								<Text color="#a1a1aa">MCP Ready </Text>
								<Text color="#71717a">plug in external tool servers</Text>
							</Text>

							{/* Divider */}
							<Box marginY={0}>
								<Text color={BORDER_COLOR}>{"─".repeat(40)}</Text>
							</Box>

							{/* Developer Platform */}
							<Text bold color="cyan">
								Developer Platform
							</Text>
							<Text>
								<Text color="#a1a1aa">Sandboxed </Text>
								<Text color="#71717a">isolated execution</Text>
							</Text>
							<Text>
								<Text color="#a1a1aa">Open Source </Text>
								<Text color="#71717a">build & run your agent</Text>
							</Text>
						</Box>
					</Box>
				</Box>

				{/* Supporting copy */}
				<Box marginTop={1} width={CARD_WIDTH}>
					<Text color="#71717a" italic>
						<Text color="#38bdf8">Codework: </Text>
						Build, run, and customize AI coding agents with plugins to understand code, edit files, execute
						commands, and debug autonomously.
					</Text>
				</Box>

				{/* Unified Input and Commands Box (At most one thin border, no extra horizontal line) */}
				<Box
					flexDirection="column"
					width={CARD_WIDTH}
					borderStyle="single"
					borderColor="#3f3f46"
					paddingX={1}
					marginTop={1}
				>
					{isModelFlowOpen ? (
						<ModelFlow
							currentConfig={activeConfig}
							onComplete={(cfg) => {
								setActiveConfig({ provider: cfg.provider, model: cfg.model });
								setIsModelFlowOpen(false);
								setSubmittedMessage(`Connected: ${cfg.providerName} (${cfg.modelName})`);
							}}
							onCancel={() => {
								setIsModelFlowOpen(false);
							}}
						/>
					) : (
						<>
							{isDropdownOpen && (
								<Box flexDirection="column" marginBottom={1}>
									<Box marginBottom={0}>
										<Text color="#38bdf8" bold>
											Commands
										</Text>
									</Box>
									{filteredCommands.length > 0 ? (
										filteredCommands.map((cmd, idx) => {
											const isSelected = idx === selectedIndex;
											return (
												<Box key={cmd.name} flexDirection="row">
													<Text bold={isSelected} color={isSelected ? "#38bdf8" : "#a1a1aa"}>
														{isSelected ? "▶ " : "  "}
														{cmd.name.padEnd(12)}
													</Text>
													<Text color={isSelected ? "#f4f4f5" : "#71717a"}>{cmd.description}</Text>
												</Box>
											);
										})
									) : (
										<Text color="#71717a">No matching commands</Text>
									)}
								</Box>
							)}

							<Box flexDirection="row">
								<Text color="#06b6d4" bold>
									❯{" "}
								</Text>
								<TextInput
									key={inputKey}
									value={query}
									onChange={handleInputChange}
									onSubmit={handleSubmit}
									placeholder="Type a message or / for commands..."
								/>
							</Box>
						</>
					)}
				</Box>

				{/* Status Bar / Footer */}
				<Box width={CARD_WIDTH} justifyContent="space-between" paddingX={1} marginTop={0}>
					<Text color="#71717a">
						{isModelFlowOpen
							? "Model Configuration Mode • Esc to cancel"
							: isDropdownOpen
								? "↑/↓ to navigate • Enter to select • Esc to dismiss"
								: "Press Enter to submit • Esc to exit"}
					</Text>
					{submittedMessage ? (
						<Text color="#10b981">
							{submittedMessage.length > 38 ? `${submittedMessage.slice(0, 37)}…` : submittedMessage}
						</Text>
					) : activeConfig ? (
						<Box flexDirection="row">
							<Text color="#10b981">✓ </Text>
							<Text color="#71717a">Connected: </Text>
							<Text color="#c084fc">{providerDef?.name ?? activeConfig.provider}</Text>
							<Text color="#71717a"> (</Text>
							<Text color="#c084fc">{modelDef?.name ?? activeConfig.model}</Text>
							<Text color="#71717a">)</Text>
						</Box>
					) : (
						<Text color="#71717a">No model connected (/model)</Text>
					)}
				</Box>
			</Box>
		</Box>
	);
}
