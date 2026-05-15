import Anthropic from "@anthropic-ai/sdk";
import { Model } from "../../../model/model";
import { mergeHeaders } from "../runtime";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";

export function createClient<
	TProtocol extends Model.KnownProtocolEnum = typeof Model.KnownProtocolEnum.anthropicMessages,
>(model: Model.TModel<TProtocol>, apiKey: string, optionsHeaders?: Record<string, string>): { client: Anthropic } {
	const betaFeatures: string[] = [FINE_GRAINED_TOOL_STREAMING_BETA];
	const defaultHeaders = mergeHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-beta": betaFeatures.join(","),
		},
		model.headers,
		optionsHeaders,
	);

	return {
		client: new Anthropic({
			apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders,
		}),
	};
}
