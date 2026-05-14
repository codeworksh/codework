import { Model } from "./model/model";
import type { Provider } from "./provider/provider";

type LLM = {
	<TProvider extends Provider.KnownProviderEnum, TModel extends Model.Info["id"]>(
		provider: TProvider,
		model: TModel,
		overrides?: Partial<Model.Info>,
	): Promise<Model.Info | undefined>;
	model: typeof Model.getModel;
	models: typeof Model.getModels;
	providers: typeof Model.getProviders;
	registry: typeof Model.registry;
	supportsXhigh: typeof Model.supportsXhigh;
	modelsAreEqual: typeof Model.modelsAreEqual;
};

const llmImpl = async <TProvider extends Provider.KnownProviderEnum, TModel extends Model.Info["id"]>(
	provider: TProvider,
	model: TModel,
	overrides?: Partial<Model.Info>,
): Promise<Model.Info | undefined> => Model.getModel(provider, model, overrides);

export const llm = Object.assign(llmImpl, {
	model: Model.getModel,
	models: Model.getModels,
	providers: Model.getProviders,
	registry: Model.registry,
	supportsXhigh: Model.supportsXhigh,
	modelsAreEqual: Model.modelsAreEqual,
}) as LLM;
