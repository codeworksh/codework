---
title: CodeWork
---

# AiKit

An opinionated TypeScript SDK that provides a unified API for working with multiple LLM providers, automatic model discovery,
provider configurations, token and cost tracking, and mid-session hand-off to other models.

Built on top of the Vercel AI SDK, this library only includes models that support tool calling (function calling), which is required for agentic workflows.

It gives you the basic primitives for streaming LLM responses without the extra bloat, letting you handle the orchestration yourself.

## Why AiKit?

- **Unified Interface:** Work with OpenAI, Anthropic, Google, OpenRouter, and more using the exact same API.
- **Built for Agents:** Native support for tool calling, schema validation (using TypeBox), and managing context windows.
- **Zero Bloat:** Minimal overhead. You control the orchestration and streaming layers.
