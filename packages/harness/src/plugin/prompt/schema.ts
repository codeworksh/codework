export interface PromptRegistry {
	readonly set: (systemPrompt: string) => void;
	readonly get: () => string | undefined;
}
