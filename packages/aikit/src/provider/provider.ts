import Type, { type Static } from "typebox";
import { Known } from "../providers/register/known";

// TODO move provider to model? very thin data model
export namespace Provider {
	// re-export
	export const KnownProviderEnum = Known.ProviderEnum;
	export const KnownProviderEnumSchema = Known.ProviderEnumSchema;
	export type KnownProviderEnum = Known.KnownProviderEnum;

	export const Info = Type.Object({
		id: KnownProviderEnumSchema,
		name: Type.String(),
		env: Type.Array(Type.String()),
		key: Type.Optional(Type.String()),
		options: Type.Optional(Type.Record(Type.String(), Type.Any())),
	});
	export type Info = Static<typeof Info>;

	export const ReasoningEffortMapSchema = Type.Object({
		minimal: Type.Optional(Type.String()),
		low: Type.Optional(Type.String()),
		medium: Type.Optional(Type.String()),
		high: Type.Optional(Type.String()),
		xhigh: Type.Optional(Type.String()),
	});
	export type ReasoningEffortMap = Static<typeof ReasoningEffortMapSchema>;
	export type StrictReasoningEffortMap = {
		[K in keyof ReasoningEffortMap]-?: NonNullable<ReasoningEffortMap[K]>;
	};

	export const OpenRouterRoutingSchema = Type.Object({
		only: Type.Optional(Type.Array(Type.String())),
		order: Type.Optional(Type.Array(Type.String())),
	});
	export type OpenRouterRouting = Static<typeof OpenRouterRoutingSchema>;

	export const VercelGatewayRoutingSchema = Type.Object({
		only: Type.Optional(Type.Array(Type.String())),
		order: Type.Optional(Type.Array(Type.String())),
	});
	export type VercelGatewayRouting = Static<typeof VercelGatewayRoutingSchema>;
}
