import { Model } from "./model/model";

type LLM = {
	<TProvider extends string, TModel extends Model.Info["id"]>(
		provider: TProvider,
		model: TModel,
		overrides?: Partial<Model.Info>,
	): Promise<Model.Info | undefined>;
	model: typeof Model.getModel;
	models: typeof Model.getModels;
	providers: typeof Model.getProviders;
	registry: typeof Model.registry;
	modelsAreEqual: typeof Model.modelsAreEqual;
};

const llmImpl = async <TProvider extends string, TModel extends Model.Info["id"]>(
	provider: TProvider,
	model: TModel,
	overrides?: Partial<Model.Info>,
): Promise<Model.Info | undefined> => Model.getModel(provider, model, overrides);

export const llm = Object.assign(llmImpl, {
	model: Model.getModel,
	models: Model.getModels,
	providers: Model.getProviders,
	registry: Model.registry,
	modelsAreEqual: Model.modelsAreEqual,
}) as LLM;
