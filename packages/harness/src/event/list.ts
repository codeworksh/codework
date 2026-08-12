import { DateTimeUtcFromMillis } from "../schema.ts";
import { EventSchema } from "./schema.ts";
import { SessionSchema } from "../session/schema.ts";
import { SessionMessageSchema } from "../session/message/schema.ts";
import { PromptSchema } from "../session/prompt/schema.ts";

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionId: SessionSchema.ID,
};

const PromptFields = {
  ...Base,
  messageId: SessionMessageSchema.ID,
  prompt: PromptSchema.Prompt,
  delivery: PromptSchema.Delivery,
};

const options = {
  durable: {
    aggregate: "sessionId",
    version: 1,
  },
} as const;

export const PromptAdmitted = EventSchema.define({
  type: "session.prompt.admitted",
  ...options,
  schema: PromptFields,
});
export type PromptAdmitted = typeof PromptAdmitted.Type;

export const Prompted = EventSchema.define({
  type: "session.prompt.promoted",
  ...options,
  schema: PromptFields,
});
export type Prompted = typeof Prompted.Type;

export const DurableDefinitions = EventSchema.inventory(
  PromptAdmitted,
  Prompted,
);



export * as EventList from "./list.ts";