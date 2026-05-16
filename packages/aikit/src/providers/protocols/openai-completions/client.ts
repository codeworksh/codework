import OpenAI from "openai";
import { Model } from "../../../model/model";
import { mergeHeaders } from "../runtime";

export function createClient<
	TProtocol extends Model.KnownProtocolEnum = typeof Model.KnownProtocolEnum.openaiCompletions,
>(model: Model.TModel<TProtocol>, apiKey: string, optionsHeaders?: Record<string, string>): { client: OpenAI } {
	const defaultHeaders = mergeHeaders(model.headers, optionsHeaders);
	return {
		client: new OpenAI({
			apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders,
		}),
	};
}
