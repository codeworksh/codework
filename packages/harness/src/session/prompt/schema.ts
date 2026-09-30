import { Schema } from "effect";
import { withStatics } from "../../schema.ts";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const IMAGE_MAX_BASE64 = 4.5 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const imageProblem = (image: { readonly data: string; readonly mimeType: string }): string | undefined => {
	if (!(IMAGE_TYPES as ReadonlyArray<string>).includes(image.mimeType)) {
		return `Unsupported image type ${image.mimeType}; use ${IMAGE_TYPES.join(", ")}`;
	}
	if (image.data.length > IMAGE_MAX_BASE64) {
		return `Image exceeds the ${IMAGE_MAX_BASE64 / 1024 / 1024} MB limit of base64`;
	}
	if (image.data.length === 0 || image.data.length % 4 !== 0 || !BASE64.test(image.data)) {
		return "Image data is not base64";
	}
	return undefined;
};

export const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
export type TextPart = typeof TextPart.Type;

/** aikit's image content: base64 `data` and its `mimeType`. */
export const ImagePart = Schema.Struct({
	type: Schema.Literal("image"),
	data: Schema.String,
	mimeType: Schema.String,
}).check(Schema.makeFilter(imageProblem));
export type ImagePart = typeof ImagePart.Type;

export const Part = Schema.Union([TextPart, ImagePart]);
export type Part = typeof Part.Type;

/** A user prompt: aikit user-message parts, in the order they were written. */
export const Prompt = Schema.Struct({
	parts: Schema.Array(Part).check(Schema.isMinLength(1)),
})
	.annotate({ identifier: "Prompt" })
	.pipe(
		withStatics((schema) => ({
			equivalence: Schema.toEquivalence(schema),
			fromText: (text: string) => schema.make({ parts: [{ type: "text", text }] }),
			text: (prompt: Prompt) =>
				prompt.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n"),
		})),
	);
export type Prompt = typeof Prompt.Type;

export class InvalidPromptError extends Schema.TaggedError<InvalidPromptError>()("InvalidPromptError", {
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}

export const Delivery = Schema.Literals(["steer", "followUp"]);
export type Delivery = typeof Delivery.Type;

export * as PromptSchema from "./schema.ts";
