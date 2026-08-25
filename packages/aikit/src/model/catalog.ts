import { Filesystem, lazy, NamedError } from "@codeworksh/utils";
import { join, resolve } from "node:path";
import Type, { type Static } from "typebox";

// known AI SDK LLM providers
// used as the public protocol discriminator for the AI SDK transport layer
export const KnownProviderEnum = {
	anthropic: "anthropic",
	google: "google",
	googleVertex: "google-vertex",
	googleVertexAnthropic: "google-vertex-anthropic",
	openai: "openai",
	openaiCompatible: "openai-compatible",
	openaiCodex: "openai-codex",
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
	Type.Literal(KnownProviderEnum.openaiCodex),
	Type.Literal(KnownProviderEnum.openrouter),
	Type.Literal(KnownProviderEnum.xai),
]);
export type KnownProviderEnum = Static<typeof KnownProviderEnumSchema>;

export type GeneratedCatalog = Partial<Record<string, Record<string, unknown>>>;
type LazyGeneratedCatalog = ReturnType<typeof lazy<Promise<GeneratedCatalog>>>;

export const ModelCatalogLoadError = NamedError.create(
	"ModelCatalogLoadError",
	Type.Object({
		path: Type.String(),
		reason: Type.Union([
			Type.Literal("missing"),
			Type.Literal("unreadable"),
			Type.Literal("empty"),
			Type.Literal("invalid"),
		]),
		message: Type.String(),
	}),
);
export type ModelCatalogLoadError = InstanceType<typeof ModelCatalogLoadError>;

export function projectRoot(): string {
	return process.cwd();
}

export const filename = "models.gen.json";
export function path(): string {
	return resolve(process.env.CODEWORK_MODELS_FILE ?? join(projectRoot(), filename));
}

export const data: LazyGeneratedCatalog = lazy(async () => {
	const catalogPath = path();
	let content: string;
	try {
		content = await Filesystem.readText(catalogPath);
	} catch (cause) {
		const value =
			typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
				? cause.code
				: undefined;
		const reason = value === "ENOENT" ? "missing" : "unreadable";
		throw new ModelCatalogLoadError(
			{
				path: catalogPath,
				reason,
				message:
					reason === "missing"
						? `model catalog not found at ${catalogPath}`
						: `model catalog could not be read at ${catalogPath}`,
			},
			{ cause },
		);
	}
	if (!content.trim()) {
		throw new ModelCatalogLoadError({
			path: catalogPath,
			reason: "empty",
			message: `model catalog is empty at ${catalogPath}`,
		});
	}
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected an object");
		return parsed as GeneratedCatalog;
	} catch (cause) {
		throw new ModelCatalogLoadError(
			{
				path: catalogPath,
				reason: "invalid",
				message: `model catalog contains invalid json at ${catalogPath}`,
			},
			{ cause },
		);
	}
});

export async function get(): Promise<GeneratedCatalog> {
	return data();
}
