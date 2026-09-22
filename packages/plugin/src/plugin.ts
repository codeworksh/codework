/**
 * The plugin authoring surface.
 *
 * Everything a third-party plugin needs to describe itself and to write into the harness during
 * `setup`, and nothing about how the harness finds, installs or runs it. Loading, the store and
 * the `.npmrc` anchoring stay in `@codeworksh/harness`, which imports this same module — so a
 * plugin and its host agree on one set of types rather than two that happen to match.
 */
export type { Config, Events, PromptResolver, SharedPluginContext } from "./plugin/context.ts";
export { define, domains, type Mount, type Plugin, type PluginKind, rank } from "./plugin/plugin.ts";
export * as Prompt from "./plugin/prompt.ts";
export type { PluginOptions, PluginPatch, PluginRef, PluginSpec } from "./plugin/ref.ts";
export type { PluginRegistry } from "./plugin/registry.ts";
export * as Tool from "./plugin/tool.ts";
