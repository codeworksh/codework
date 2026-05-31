import { Model } from "./model/model";

type LLM = {
	<TProvider extends string, TProtocol extends Model.KnownProviderEnum = Model.ProviderToProtocol<TProvider>>(
		provider: TProvider,
		model: string,
		overrides?: Partial<Model.Info> & { protocol?: TProtocol },
	): Promise<Model.TModel<TProtocol> | undefined>;
	model: typeof Model.getModel;
	models: typeof Model.getModels;
	providers: typeof Model.getProviders;
	registry: typeof Model.registry;
	modelsAreEqual: typeof Model.modelsAreEqual;
};

const llmImpl = async <
	TProvider extends string,
	TProtocol extends Model.KnownProviderEnum = Model.ProviderToProtocol<TProvider>,
>(
	provider: TProvider,
	model: string,
	overrides?: Partial<Model.Info> & { protocol?: TProtocol },
): Promise<Model.TModel<TProtocol> | undefined> => Model.getModel(provider, model, overrides as any);

export const llm = Object.assign(llmImpl, {
	model: Model.getModel,
	models: Model.getModels,
	providers: Model.getProviders,
	registry: Model.registry,
	modelsAreEqual: Model.modelsAreEqual,
}) as LLM;
