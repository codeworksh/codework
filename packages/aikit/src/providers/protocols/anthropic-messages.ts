import Type from "typebox";
// import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  Usage,
  ContentBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  Tool,
  ToolChoice,
  ThinkingConfigParam,
} from "@anthropic-ai/sdk/resources";

export const ADAPTER = "anthropic-messages";

// =============================================================================
// Request Body Schema
// =============================================================================
export type AnthropicMessagesBody = MessageCreateParamsStreaming;

export type AnthropicUsage = Omit<
  Usage,
  "cache_creation" | "service_tier" | "server_tool_use" | "inference_geo"
>;

export type AnthropicUserBlock = {
  role: "user";
  content: string | Array<TextBlockParam | ToolResultBlockParam>;
};
export type AnthropicAssistantBlock = {
  role: "assistant";
  content: string | Array<Omit<ContentBlockParam, "ToolResultBlockParam">>;
};
export type AnthropicMessage = AnthropicUserBlock | AnthropicAssistantBlock;

export type AnthropicTool = Tool;
export type AnthropicToolChoice = ToolChoice;
export type AnthropicThinking = ThinkingConfigParam;
