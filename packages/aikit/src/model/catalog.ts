import { Filesystem, lazy } from "@codeworksh/utils";
import { join, resolve } from "node:path";
import Type, { type Static } from "typebox";

export namespace ModelCatalog {
	// known AI SDK LLM providers
	// used as the public protocol discriminator for the AI SDK transport layer
	export const KnownProviderEnum = {
		anthropic: "anthropic",
		google: "google",
		googleVertex: "google-vertex",
		googleVertexAnthropic: "google-vertex-anthropic",
		openai: "openai",
		openaiCompatible: "openai-compatible",
		openrouter: "openrouter",
		xai: "xai",
	} as const;
	export const KnownProviderEnumSchema = Type.Union([
		Type.Literal(KnownProviderEnum.anthropic),
		Type.Literal(KnownProviderEnum.google),
		Type.Literal(KnownProviderEnum.googleVertex),
		Type.Literal(KnownProviderEnum.googleVertexAnthropic),
		Type.Literal(KnownProviderEnum.openai),
		Type.Literal(KnownProviderEnum.openaiCompatible),
		Type.Literal(KnownProviderEnum.openrouter),
		Type.Literal(KnownProviderEnum.xai),
	]);
	export type KnownProviderEnum = Static<typeof KnownProviderEnumSchema>;

	export type GeneratedCatalog = Partial<Record<string, Record<string, unknown>>>;
	type LazyGeneratedCatalog = ReturnType<typeof lazy<Promise<GeneratedCatalog>>>;

	export function projectRoot(): string {
		return process.cwd();
	}

	export const filename = "models.gen.json";
	export function path(): string {
		return resolve(process.env.CODEWORK_MODELS_FILE ?? join(projectRoot(), filename));
	}

	export const data: LazyGeneratedCatalog = lazy(async () => {
		const content = await Filesystem.readText(path()).catch(() => undefined);
		if (!content?.trim()) return {};
		return JSON.parse(content) as GeneratedCatalog;
	});

	export async function get(): Promise<GeneratedCatalog> {
		return data().catch(() => ({}));
	}
}
