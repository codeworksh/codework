import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { getConfigManager } from "./config.ts";
import { getCredentialStore } from "./credentials.ts";
import { registry, resolveApiKey, type ProviderDefinition } from "./registry.ts";
import type { ModelEntry } from "./catalog.ts";
import { Spinner } from "./spinner.tsx";

export interface ModelFlowProps {
	readonly currentConfig: { readonly provider: string; readonly model: string } | null;
	readonly onComplete: (config: {
		readonly provider: string;
		readonly model: string;
		readonly providerName: string;
		readonly modelName: string;
	}) => void;
	readonly onCancel: () => void;
}

const PAGE_SIZE = 6;
type FlowStep = "select-provider" | "select-model" | "enter-key" | "validating" | "result";

export function ModelFlow({ currentConfig, onComplete, onCancel }: ModelFlowProps) {
	const allProviders = registry.getAll();
	const [step, setStep] = useState<FlowStep>("select-provider");

	// Search states
	const [providerSearch, setProviderSearch] = useState("");
	const [modelSearch, setModelSearch] = useState("");

	const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
	const [selectedModelIndex, setSelectedModelIndex] = useState(0);
	const [modelScrollOffset, setModelScrollOffset] = useState(0);

	// Filtered providers
	const filteredProviders = allProviders.filter((p) => {
		const q = providerSearch.trim().toLowerCase();
		if (!q) return true;
		return (
			p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
		);
	});

	const selectedProvider: ProviderDefinition | undefined =
		filteredProviders[selectedProviderIndex] ?? filteredProviders[0];

	// Filtered models
	const allModels: readonly ModelEntry[] = selectedProvider ? selectedProvider.getModels() : [];
	const filteredModels = allModels.filter((m) => {
		const q = modelSearch.trim().toLowerCase();
		if (!q) return true;
		return (
			m.id.toLowerCase().includes(q) ||
			(m.name && m.name.toLowerCase().includes(q)) ||
			(m.description && m.description.toLowerCase().includes(q))
		);
	});

	const selectedModel: ModelEntry | undefined = filteredModels[selectedModelIndex] ?? filteredModels[0];

	const [targetModel, setTargetModel] = useState<ModelEntry | null>(null);
	const [existingKeyInfo, setExistingKeyInfo] = useState<{ key: string; source: "env" | "store" } | null>(null);
	const [inputApiKey, setInputApiKey] = useState("");
	const [validationError, setValidationError] = useState<string | null>(null);

	// Load existing key info when provider is selected
	useEffect(() => {
		if (!selectedProvider) return;
		let isMounted = true;
		void resolveApiKey(selectedProvider).then((info) => {
			if (isMounted) {
				setExistingKeyInfo(info ?? null);
			}
		});
		return () => {
			isMounted = false;
		};
	}, [selectedProvider]);

	// Reset provider selection when provider search changes
	useEffect(() => {
		setSelectedProviderIndex(0);
	}, [providerSearch]);

	// Reset model selection and scroll offset when model search or provider changes
	useEffect(() => {
		setSelectedModelIndex(0);
		setModelScrollOffset(0);
	}, [modelSearch, selectedProvider?.id]);

	// Scroll the visible window to keep selectedModelIndex in view
	useEffect(() => {
		setModelScrollOffset((prev) => {
			if (selectedModelIndex < prev) {
				return selectedModelIndex;
			}
			if (selectedModelIndex >= prev + PAGE_SIZE) {
				return selectedModelIndex - PAGE_SIZE + 1;
			}
			return prev;
		});
	}, [selectedModelIndex]);

	const startValidation = async (keyToValidate: string, isNewKey: boolean, modelChoice?: ModelEntry) => {
		const model = modelChoice ?? targetModel ?? selectedModel;
		if (!selectedProvider || !model) return;
		setTargetModel(model);
		setStep("validating");
		setValidationError(null);

		const result = await selectedProvider.validate(keyToValidate, model.id);
		if (result.ok) {
			await getConfigManager().save({
				provider: selectedProvider.id,
				model: model.id,
			});

			if (isNewKey && keyToValidate.trim().length > 0) {
				await getCredentialStore().setApiKey(selectedProvider.id, keyToValidate.trim());
				setExistingKeyInfo({ key: keyToValidate.trim(), source: "store" });
			}

			setStep("result");
		} else {
			setValidationError(result.error || "Failed to validate credentials");
			setStep("result");
		}
	};

	const handleModelSelect = async (modelToSelect: ModelEntry) => {
		if (!selectedProvider) return;
		setTargetModel(modelToSelect);

		// Check if we already have an existing API key for this provider
		const keyInfo = await resolveApiKey(selectedProvider);
		if (keyInfo?.key && keyInfo.key.trim().length > 0) {
			// Key already exists! Validate and connect directly without asking again
			setExistingKeyInfo(keyInfo);
			void startValidation(keyInfo.key, false, modelToSelect);
		} else {
			// No key saved yet for this provider, prompt the user
			setInputApiKey("");
			setStep("enter-key");
		}
	};

	const handleKeySubmit = (val: string) => {
		const trimmed = val.trim();
		if (trimmed.length > 0) {
			void startValidation(trimmed, true);
		} else if (existingKeyInfo?.key) {
			void startValidation(existingKeyInfo.key, false);
		}
	};

	useInput((input, key) => {
		if (step === "select-provider") {
			if (key.escape) {
				if (providerSearch.length > 0) {
					setProviderSearch("");
					return;
				}
				onCancel();
				return;
			}
			if (key.upArrow) {
				if (filteredProviders.length > 0) {
					setSelectedProviderIndex((prev) => (prev > 0 ? prev - 1 : filteredProviders.length - 1));
				}
				return;
			}
			if (key.downArrow) {
				if (filteredProviders.length > 0) {
					setSelectedProviderIndex((prev) => (prev < filteredProviders.length - 1 ? prev + 1 : 0));
				}
				return;
			}
			if (key.return || input === "\r" || input === "\n") {
				if (selectedProvider) {
					setStep("select-model");
					setModelSearch("");
				}
				return;
			}
		}

		if (step === "select-model") {
			if (key.escape) {
				if (modelSearch.length > 0) {
					setModelSearch("");
					return;
				}
				setStep("select-provider");
				return;
			}
			// Allow pressing 'k' to change the key manually if search is empty
			if ((input === "k" || input === "K") && modelSearch.length === 0) {
				setInputApiKey("");
				setStep("enter-key");
				return;
			}
			if (key.upArrow) {
				if (filteredModels.length > 0) {
					setSelectedModelIndex((prev) => (prev > 0 ? prev - 1 : filteredModels.length - 1));
				}
				return;
			}
			if (key.downArrow) {
				if (filteredModels.length > 0) {
					setSelectedModelIndex((prev) => (prev < filteredModels.length - 1 ? prev + 1 : 0));
				}
				return;
			}
			if (key.return || input === "\r" || input === "\n") {
				if (selectedModel) {
					void handleModelSelect(selectedModel);
				}
				return;
			}
		}

		if (step === "enter-key") {
			if (key.escape) {
				setStep("select-model");
				return;
			}
		}

		if (step === "result") {
			if (validationError) {
				if (key.escape) {
					onCancel();
					return;
				}
				if (key.return || input === "\r" || input === "\n") {
					setInputApiKey("");
					setStep("enter-key");
					return;
				}
			} else {
				// Success
				if (key.return || input === "\r" || input === "\n" || key.escape) {
					const finalModel = targetModel || selectedModel;
					if (selectedProvider && finalModel) {
						onComplete({
							provider: selectedProvider.id,
							model: finalModel.id,
							providerName: selectedProvider.name,
							modelName: finalModel.name,
						});
					}
					return;
				}
			}
		}
	});

	const currentProviderDef = currentConfig ? registry.get(currentConfig.provider) : undefined;
	const currentModelEntry = currentProviderDef?.getModels().find((m) => m.id === currentConfig?.model);

	return (
		<Box flexDirection="column">
			{/* Top Header with Active Config */}
			<Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
				<Text color="#06b6d4" bold>
					Model Configuration
				</Text>
				<Text color="#71717a">
					Active:{" "}
					{currentConfig ? (
						<Text color="#c084fc">
							{currentProviderDef?.name || currentConfig.provider} •{" "}
							{currentModelEntry?.name || currentConfig.model}
						</Text>
					) : (
						<Text color="#a1a1aa">None configured</Text>
					)}
				</Text>
			</Box>

			{/* Step 1: Select Provider with Search */}
			{step === "select-provider" && (
				<Box flexDirection="column">
					<Box flexDirection="row" justifyContent="space-between" marginBottom={0}>
						<Text color="white" bold>
							Select AI Provider:
						</Text>
						{filteredProviders.length > 0 && (
							<Text color="#06b6d4">
								[{selectedProviderIndex + 1}/{filteredProviders.length}]
								{providerSearch.length > 0 ? ` (of ${allProviders.length})` : ""}
							</Text>
						)}
					</Box>
					<Box flexDirection="row" marginY={0}>
						<Text color="#06b6d4" bold>
							❯{" "}
						</Text>
						<TextInput
							value={providerSearch}
							onChange={setProviderSearch}
							onSubmit={() => {
								if (selectedProvider) {
									setStep("select-model");
									setModelSearch("");
								}
							}}
							placeholder="Search provider (or use ↑/↓)..."
						/>
					</Box>
					{filteredProviders.length > 0 ? (
						filteredProviders.map((p, idx) => {
							const isSelected = idx === selectedProviderIndex;
							return (
								<Box key={p.id} flexDirection="row">
									<Text bold={isSelected} color={isSelected ? "#06b6d4" : "#a1a1aa"}>
										{isSelected ? "▶ " : "  "}
										{p.name.padEnd(14)}
									</Text>
									<Text color={isSelected ? "white" : "#71717a"}>{p.description}</Text>
								</Box>
							);
						})
					) : (
						<Text color="#71717a">No providers matching &quot;{providerSearch}&quot;</Text>
					)}
					<Box marginTop={1}>
						<Text color="#71717a">
							Type to search • ↑/↓ navigate • Enter select provider • Esc {providerSearch ? "clear" : "cancel"}
						</Text>
					</Box>
				</Box>
			)}

			{/* Step 2: Select Model with Search & Windowed Scrolling */}
			{step === "select-model" && selectedProvider && (
				<Box flexDirection="column">
					<Box flexDirection="row" justifyContent="space-between" marginBottom={0}>
						<Text color="white" bold>
							Select Model for {selectedProvider.name}:
						</Text>
						{filteredModels.length > 0 && (
							<Text color="#06b6d4">
								[{selectedModelIndex + 1}/{filteredModels.length}]
								{modelSearch.length > 0 ? ` (of ${allModels.length})` : ""}
							</Text>
						)}
					</Box>
					<Box flexDirection="row" marginY={0}>
						<Text color="#06b6d4" bold>
							❯{" "}
						</Text>
						<TextInput
							value={modelSearch}
							onChange={setModelSearch}
							onSubmit={() => {
								if (selectedModel) {
									void handleModelSelect(selectedModel);
								}
							}}
							placeholder={`Search ${selectedProvider.name} models (or use ↑/↓)...`}
						/>
					</Box>
					{filteredModels.length > 0 ? (
						filteredModels.slice(modelScrollOffset, modelScrollOffset + PAGE_SIZE).map((m, idx) => {
							const actualIndex = modelScrollOffset + idx;
							const isSelected = actualIndex === selectedModelIndex;
							const maxIdLen = 28;
							const displayId =
								m.id.length > maxIdLen ? `${m.id.slice(0, maxIdLen - 1)}…` : m.id.padEnd(maxIdLen);
							const maxNameLen = 36;
							const displayName =
								m.name && m.name !== m.id
									? m.name.length > maxNameLen
										? `${m.name.slice(0, maxNameLen - 1)}…`
										: m.name
									: "";
							const hasMoreAbove = modelScrollOffset > 0;
							const hasMoreBelow = modelScrollOffset + PAGE_SIZE < filteredModels.length;

							return (
								<Box key={m.id} flexDirection="row" justifyContent="space-between">
									<Box flexDirection="row">
										<Text bold={isSelected} color={isSelected ? "#c084fc" : "#a1a1aa"}>
											{isSelected ? "▶ " : "  "}
											{displayId}
										</Text>
										<Text color={isSelected ? "#ffffff" : "#71717a"}> {displayName}</Text>
									</Box>
									<Box>
										{idx === 0 && hasMoreAbove ? (
											<Text color="#71717a">▲</Text>
										) : idx === Math.min(PAGE_SIZE, filteredModels.length) - 1 && hasMoreBelow ? (
											<Text color="#71717a">▼</Text>
										) : (
											<Text> </Text>
										)}
									</Box>
								</Box>
							);
						})
					) : (
						<Text color="#71717a">No models matching &quot;{modelSearch}&quot;</Text>
					)}
					<Box marginTop={1}>
						<Text color="#71717a">
							Type to search • ↑/↓ navigate
							{filteredModels.length > PAGE_SIZE
								? ` (${selectedModelIndex + 1} of ${filteredModels.length})`
								: ""}{" "}
							• Enter select model • {existingKeyInfo ? "Press 'k' to change key • " : ""}Esc{" "}
							{modelSearch ? "clear" : "back"}
						</Text>
					</Box>
				</Box>
			)}

			{/* Step 3: Enter API Key (Only shown when key is missing or explicitly updating) */}
			{step === "enter-key" && selectedProvider && (
				<Box flexDirection="column">
					<Box marginBottom={0}>
						<Text color="white" bold>
							Enter API Key for {selectedProvider.name}:
						</Text>
					</Box>
					{existingKeyInfo ? (
						<Box marginBottom={0}>
							<Text color="#10b981">
								✓ Existing key found ({existingKeyInfo.source === "env" ? "environment" : "saved credentials"}).
								Press Enter to keep it, or paste a new one.
							</Text>
						</Box>
					) : (
						<Box marginBottom={0}>
							<Text color="#71717a">Key will be verified with a lightweight request and stored securely.</Text>
						</Box>
					)}
					<Box flexDirection="row" marginTop={1}>
						<Text color="#06b6d4" bold>
							❯{" "}
						</Text>
						<TextInput
							value={inputApiKey}
							onChange={setInputApiKey}
							onSubmit={handleKeySubmit}
							mask="*"
							placeholder={
								existingKeyInfo
									? "Press Enter to keep existing key, or type a new one..."
									: `Enter ${selectedProvider.name} API key...`
							}
						/>
					</Box>
					<Box marginTop={1}>
						<Text color="#71717a">Key is masked while typing • Enter submit • Esc back</Text>
					</Box>
				</Box>
			)}

			{/* Step 4: Validating */}
			{step === "validating" && selectedProvider && (
				<Box flexDirection="column" paddingY={1}>
					<Box flexDirection="row">
						<Spinner color="#f59e0b" />
						<Text color="#fbbf24"> Validating with {selectedProvider.name}...</Text>
					</Box>
					<Text color="#71717a">Connecting to verify model: {(targetModel || selectedModel)?.name}</Text>
				</Box>
			)}

			{/* Step 5: Result (Success or Error) */}
			{step === "result" && selectedProvider && (
				<Box flexDirection="column">
					{validationError ? (
						<Box flexDirection="column">
							<Text color="#ef4444" bold>
								✗ Connection Failed
							</Text>
							<Text color="#a1a1aa">
								Provider: <Text color="#ffffff">{selectedProvider.name}</Text>
							</Text>
							<Text color="#a1a1aa">
								Model: <Text color="#c084fc">{(targetModel || selectedModel)?.name}</Text>
							</Text>
							<Text color="#f87171">Error: {validationError}</Text>
							<Box marginTop={1}>
								<Text color="#71717a">Press Enter to try again • Esc to cancel</Text>
							</Box>
						</Box>
					) : (
						<Box flexDirection="column">
							<Text color="#10b981" bold>
								✓ Connected
							</Text>
							<Text color="#a1a1aa">
								Provider: <Text color="#ffffff">{selectedProvider.name}</Text>
							</Text>
							<Text color="#a1a1aa">
								Model: <Text color="#c084fc">{(targetModel || selectedModel)?.name}</Text>
							</Text>
							<Box marginTop={1}>
								<Text color="#71717a">Press Enter to continue</Text>
							</Box>
						</Box>
					)}
				</Box>
			)}
		</Box>
	);
}
