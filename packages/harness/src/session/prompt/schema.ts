import { Schema } from "effect";
import { withStatics } from "../../schema.ts";

// TODO: add support for diff input types
// as supported by packages/aikit
export const Prompt = Schema.Struct({
  text: Schema.String,
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    withStatics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (input: Pick<Prompt, "text">) =>
        schema.make({
          text: input.text,
        }),
    })),
  );
export type Prompt = typeof Prompt.Type;

export const Delivery = Schema.Literals(["steer", "followUp"]);
export type Delivery = typeof Delivery.Type;

export * as PromptSchema from "./schema.ts";
