import anthropicProvider from "./providers/anthropic/index";
// import openAICompletionsProvider from "./providers/openai/completions";
import { Stream } from "./stream";

Stream.registerProtocolProvider(anthropicProvider, "providers/anthropic/index.ts");
// Stream.registerProtocolProvider(openAICompletionsProvider, "providers/openai/completions.ts");
