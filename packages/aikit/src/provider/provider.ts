import { Model } from "../model/model";

export namespace Provider {
	export const KnownProviderEnum = Model.KnownProviderEnum;
	export const KnownProviderEnumSchema = Model.KnownProviderEnumSchema;
	export type KnownProviderEnum = Model.KnownProviderEnum;

	export const Info = Model.ProviderInfo;
	export type Info = Model.ProviderInfo;
}
