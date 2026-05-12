import Type, {
  type Static,
  type TObject,
  type TOptionalAdd,
  type TProperties,
  type TSchema,
} from "typebox";
import { GenerationOptions, CacheHint, CacheRetention } from "../options";
import * as Protocol from "../protocol";
import * as Known from "../known";

export const PROTOCOL = Known.KnownProtocolEnum.anthropicMessages;

type OptionalizeProperties<T extends TProperties> = {
  [K in keyof T]: TOptionalAdd<T[K]>;
};

class ObjectSchemaBuilder<TPropertiesMap extends TProperties> {
  private readonly properties: TProperties;

  constructor(schema: TObject<TPropertiesMap>) {
    this.properties = { ...schema.properties };
  }

  withOption<TKey extends string, TOptionSchema extends TSchema>(
    key: TKey,
    schema: TOptionSchema,
  ): ObjectSchemaBuilder<
    Omit<TPropertiesMap, TKey> & {
      [K in TKey]: TOptionalAdd<TOptionSchema>;
    }
  > {
    this.properties[key] = Type.Optional(schema);
    return this as unknown as ObjectSchemaBuilder<
      Omit<TPropertiesMap, TKey> & {
        [K in TKey]: TOptionalAdd<TOptionSchema>;
      }
    >;
  }

  withOptions<TNextProperties extends TProperties>(
    properties: TNextProperties,
  ): ObjectSchemaBuilder<
    Omit<TPropertiesMap, keyof TNextProperties> &
      OptionalizeProperties<TNextProperties>
  > {
    for (const [key, schema] of Object.entries(properties)) {
      this.properties[key] = Type.Optional(schema as TSchema);
    }
    return this as unknown as ObjectSchemaBuilder<
      Omit<TPropertiesMap, keyof TNextProperties> &
        OptionalizeProperties<TNextProperties>
    >;
  }

  popOption<TKey extends keyof TPropertiesMap>(
    key: TKey,
  ): ObjectSchemaBuilder<Omit<TPropertiesMap, TKey>> {
    delete this.properties[key as string];
    return this as unknown as ObjectSchemaBuilder<Omit<TPropertiesMap, TKey>>;
  }

  make(): TObject<TPropertiesMap> {
    return Type.Object(this.properties as TPropertiesMap);
  }
}

function createObjectSchemaBuilder<TBaseProperties extends TProperties>(
  schema: TObject<TBaseProperties>,
): ObjectSchemaBuilder<TBaseProperties> {
  return new ObjectSchemaBuilder(schema);
}

// =============================================================================
// Request Body Schema
// =============================================================================
const CacheControlEphemeralSchema = Type.Object({
  type: Type.Literal("ephemeral"),
  ttl: Type.Optional(Type.Union([Type.Literal("5m"), Type.Literal("1h")])),
});

const TextCitationParamSchema = Type.Object(
  {
    type: Type.String(),
  },
  { additionalProperties: true },
);

const TextBlockParamSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
  citations: Type.Optional(
    Type.Union([Type.Array(TextCitationParamSchema), Type.Null()]),
  ),
});

const ToolReferenceBlockParamSchema = Type.Object({
  type: Type.Literal("tool_reference"),
  // tool_name
  toolName: Type.String(),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
});

const ImageBlockParamSchema = Type.Object({
  type: Type.Literal("image"),
  source: Type.Object(
    {
      type: Type.String(),
    },
    { additionalProperties: true },
  ),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
});

const SearchResultBlockParamSchema = Type.Object({
  type: Type.Literal("web_search_result"),
  // encrypted_content
  encryptedContent: Type.String(),
  title: Type.String(),
  url: Type.String(),
  // page_age
  pageAge: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const DocumentBlockParamSchema = Type.Object({
  type: Type.Literal("document"),
  source: Type.Object(
    {
      type: Type.String(),
    },
    { additionalProperties: true },
  ),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
  citations: Type.Optional(
    Type.Union([
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  ),
  context: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const AnthropicToolResultBlockParamSchema = Type.Object({
  type: Type.Literal("tool_result"),
  // tool_use_id
  toolUseId: Type.String(),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
  content: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Array(
        Type.Union([
          TextBlockParamSchema,
          ImageBlockParamSchema,
          SearchResultBlockParamSchema,
          DocumentBlockParamSchema,
          ToolReferenceBlockParamSchema,
        ]),
      ),
    ]),
  ),
  // is_error
  isError: Type.Optional(Type.Boolean()),
});

const ThinkingBlockParamSchema = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  signature: Type.String(),
});

const RedactedThinkingBlockParamSchema = Type.Object({
  type: Type.Literal("redacted_thinking"),
  data: Type.String(),
});

const DirectCallerSchema = Type.Object({
  type: Type.Literal("direct"),
});

const ServerToolCallerSchema = Type.Object(
  {
    type: Type.String(),
  },
  { additionalProperties: true },
);

const ToolUseBlockParamSchema = Type.Object({
  type: Type.Literal("tool_use"),
  id: Type.String(),
  name: Type.String(),
  input: Type.Unknown(),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
  caller: Type.Optional(
    Type.Union([DirectCallerSchema, ServerToolCallerSchema]),
  ),
});

const ServerToolUseBlockParamSchema = Type.Object({
  type: Type.Literal("server_tool_use"),
  id: Type.String(),
  name: Type.String(),
  input: Type.Unknown(),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
  caller: Type.Optional(
    Type.Union([DirectCallerSchema, ServerToolCallerSchema]),
  ),
});

const GenericNamedContentBlockSchema = Type.Object(
  {
    type: Type.String(),
  },
  { additionalProperties: true },
);

export const AnthropicUserBlockSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.Union([
    Type.String(),
    Type.Array(
      Type.Union([TextBlockParamSchema, AnthropicToolResultBlockParamSchema]),
    ),
  ]),
});

export const AnthropicAssistantBlockSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Union([
    Type.String(),
    Type.Array(
      Type.Union([
        TextBlockParamSchema,
        ThinkingBlockParamSchema,
        RedactedThinkingBlockParamSchema,
        ToolUseBlockParamSchema,
        ServerToolUseBlockParamSchema,
        GenericNamedContentBlockSchema,
      ]),
    ),
  ]),
});

export const AnthropicMessageSchema = Type.Union([
  AnthropicUserBlockSchema,
  AnthropicAssistantBlockSchema,
]);

const ToolInputSchemaSchema = Type.Object(
  {
    type: Type.Literal("object"),
    properties: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
    required: Type.Optional(
      Type.Union([Type.Array(Type.String()), Type.Null()]),
    ),
  },
  { additionalProperties: true },
);

export const AnthropicToolSchema = Type.Object({
  // input_schema
  inputSchema: ToolInputSchemaSchema,
  name: Type.String(),
  // allowed_callers
  allowedCallers: Type.Optional(Type.Array(Type.String())),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
  // defer_loading
  deferLoading: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  // eager_input_streaming
  eagerInputStreaming: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  // input_examples
  inputExamples: Type.Optional(
    Type.Array(Type.Record(Type.String(), Type.Unknown())),
  ),
  strict: Type.Optional(Type.Boolean()),
  type: Type.Optional(Type.Union([Type.Literal("custom"), Type.Null()])),
});

export const AnthropicToolChoiceSchema = Type.Union([
  Type.Object({
    type: Type.Literal("auto"),
    // disable_parallel_tool_use
    disableParallelToolUse: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("any"),
    // disable_parallel_tool_use
    disableParallelToolUse: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("tool"),
    name: Type.String(),
    // disable_parallel_tool_use
    disableParallelToolUse: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("none"),
  }),
]);

export const AnthropicThinkingSchema = Type.Union([
  Type.Object({
    type: Type.Literal("enabled"),
    // budget_tokens
    budgetTokens: Type.Number(),
    display: Type.Optional(
      Type.Union([
        Type.Literal("summarized"),
        Type.Literal("omitted"),
        Type.Null(),
      ]),
    ),
  }),
  Type.Object({
    type: Type.Literal("disabled"),
  }),
  Type.Object({
    type: Type.Literal("adaptive"),
    display: Type.Optional(
      Type.Union([
        Type.Literal("summarized"),
        Type.Literal("omitted"),
        Type.Null(),
      ]),
    ),
  }),
]);

const MetadataSchema = Type.Object({
  // user_id
  userId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const JsonOutputFormatSchema = Type.Object({
  type: Type.Literal("json_schema"),
  schema: Type.Record(Type.String(), Type.Unknown()),
});

const OutputConfigSchema = Type.Object({
  effort: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("max"),
      Type.Null(),
    ]),
  ),
  format: Type.Optional(Type.Union([JsonOutputFormatSchema, Type.Null()])),
});

export const AnthropicMessagesBodySchema = Type.Object({
  // max_tokens
  maxTokens: Type.Number(),
  messages: Type.Array(AnthropicMessageSchema),
  model: Type.String(),
  stream: Type.Literal(true),
  // cache_control
  cacheControl: Type.Optional(
    Type.Union([CacheControlEphemeralSchema, Type.Null()]),
  ),
  container: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // inference_geo
  inferenceGeo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata: Type.Optional(MetadataSchema),
  // output_config
  outputConfig: Type.Optional(OutputConfigSchema),
  // service_tier
  serviceTier: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("standard_only")]),
  ),
  // stop_sequences
  stopSequences: Type.Optional(Type.Array(Type.String())),
  system: Type.Optional(
    Type.Union([Type.String(), Type.Array(TextBlockParamSchema)]),
  ),
  temperature: Type.Optional(Type.Number()),
  thinking: Type.Optional(AnthropicThinkingSchema),
  // tool_choice
  toolChoice: Type.Optional(AnthropicToolChoiceSchema),
  tools: Type.Optional(Type.Array(AnthropicToolSchema)),
  // top_k
  topK: Type.Optional(Type.Number()),
  // top_p
  topP: Type.Optional(Type.Number()),
});
export type AnthropicMessagesBody = Static<typeof AnthropicMessagesBodySchema>;

export const AnthropicUsageSchema = Type.Object({
  // cache_creation_input_tokens
  cacheCreationInputTokens: Type.Union([Type.Number(), Type.Null()]),
  // cache_read_input_tokens
  cacheReadInputTokens: Type.Union([Type.Number(), Type.Null()]),
  // input_tokens
  inputTokens: Type.Number(),
  // output_tokens
  outputTokens: Type.Number(),
});

export type AnthropicUsage = Static<typeof AnthropicUsageSchema>;
export type AnthropicUserBlock = Static<typeof AnthropicUserBlockSchema>;
export type AnthropicAssistantBlock = Static<
  typeof AnthropicAssistantBlockSchema
>;
export type AnthropicMessage = Static<typeof AnthropicMessageSchema>;
export type AnthropicTool = Static<typeof AnthropicToolSchema>;
export type AnthropicToolChoice = Static<typeof AnthropicToolChoiceSchema>;
export type AnthropicThinking = Static<typeof AnthropicThinkingSchema>;

// =============================================================================
// Input Options Schema
// =============================================================================
const AnthropicOptionsSchema = createObjectSchemaBuilder(GenerationOptions)
  .withOption("model", Type.String())
  .withOptions({
    cacheControl: Type.Optional(CacheRetention),
    cache: Type.Optional(CacheHint),
    thinkingEnabled: Type.Optional(Type.Boolean()),
    toolChoice: Type.Optional(AnthropicToolChoiceSchema),
  })
  .popOption("presencePenalty")
  .popOption("frequencyPenalty")
  .popOption("seed")
  .make();

export type AnthropicOptions = Static<typeof AnthropicOptionsSchema>;

const AnthropicOptionsWithThinkingSchema = createObjectSchemaBuilder(
  AnthropicOptionsSchema,
)
  .withOption("thinkingEnabled", Type.Boolean())
  .withOption("thinkingBudgetTokens", Type.Number())
  .make();

export type AnthropicOptionsWithThinking = Static<typeof AnthropicOptionsWithThinkingSchema>

// FIXME implement this
// @ts-ignore
const protocol: Protocol.Protocol<
  typeof Known.KnownProtocolEnum.anthropicMessages,
  typeof AnthropicOptionsSchema,
  typeof AnthropicOptionsWithThinkingSchema
> = {
  protocol: PROTOCOL,
  schema: AnthropicOptionsSchema,
  schemaWithThinking: AnthropicOptionsWithThinkingSchema,
  // @ts-ignore
  stream: () => {},
  // @ts-ignore
  streamSimple: () => {},
  // @ts-ignore
};

export default protocol;
