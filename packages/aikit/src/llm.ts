import { Model } from "./model/model";
import type { Provider } from "./provider/provider";

type LLM = {
	<TProvider extends Provider.KnownProvider, TModel extends Model.Value["id"]>(
		provider: TProvider,
		model: TModel,
	): Promise<Model.Value | undefined>;
	model: typeof Model.getModel;
	models: typeof Model.getModels;
	providers: typeof Model.getProviders;
	registry: typeof Model.registry;
	supportsXhigh: typeof Model.supportsXhigh;
	modelsAreEqual: typeof Model.modelsAreEqual;
};

const llmImpl = async <TProvider extends Provider.KnownProvider, TModel extends Model.Value["id"]>(
	provider: TProvider,
	model: TModel,
): Promise<Model.Value | undefined> => Model.getModel(provider, model);

export const llm = Object.assign(llmImpl, {
	model: Model.getModel,
	models: Model.getModels,
	providers: Model.getProviders,
	registry: Model.registry,
	supportsXhigh: Model.supportsXhigh,
	modelsAreEqual: Model.modelsAreEqual,
}) as LLM;
