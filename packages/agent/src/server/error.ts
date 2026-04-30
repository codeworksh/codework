import type { NamedError } from "@codeworksh/utils";
import { Type } from "@sinclair/typebox";
import { NotFoundError } from "../storage/db.ts";

const HTTPErrorSchema = Type.Object({
	status: Type.Number(),
	statusText: Type.Optional(Type.String()),
	unhandled: Type.Optional(Type.Boolean()),
	message: Type.String(),
	data: Type.Optional(Type.Unknown()),
});

export const ERRORS = {
	400: {
		description: "Bad request",
		schema: HTTPErrorSchema,
	},
	404: {
		description: "Not found",
		schema: NotFoundError.Schema,
	},
} as const;

export function errors(...codes: number[]) {
	return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]));
}

export function namedErrorStatus(error: NamedError) {
	if (NotFoundError.isInstance(error)) return 404;
	return 500;
}

export function namedErrorResponse(error: NamedError) {
	return Response.json(error.toObject(), { status: namedErrorStatus(error) });
}
