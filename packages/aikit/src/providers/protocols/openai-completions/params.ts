import { Model } from "../../../model/model";
import type { Static, TSchema } from "typebox";
import { Message } from "../../../message/message";
import OpenAI from "openai";
import { Options } from "./options";

export type BuildParams<
	TProtocol extends Model.KnownProtocolEnum = typeof Model.KnownProtocolEnum.openaiCompletions,
	S extends TSchema = TSchema,
> = (
	model: Model.TModel<TProtocol>,
	context: Message.Context,
	options: Static<S>,
) => OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export const buildParams: BuildParams<typeof Model.KnownProtocolEnum.openaiCompletions, typeof Options> = (
	model,
	_context,
	_options,
) => {
	// @ts-ignore
	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
	};
	return params;
};
