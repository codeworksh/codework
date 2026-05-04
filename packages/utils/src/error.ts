import type { Static, TSchema } from "typebox";

type SchemaLike = TSchema;
type StaticData<Data extends SchemaLike> = Static<Data>;

export abstract class NamedError extends Error {
	abstract schema(): SchemaLike;
	abstract toObject(): { name: string; data: unknown };

	static create<Name extends string, Data extends SchemaLike>(name: Name, data: Data) {
		const schema = {
			$id: name,
			type: "object",
			required: ["name", "data"],
			properties: {
				name: {
					const: name,
				},
				data,
			},
		} as const;

		const result = class extends NamedError {
			public static readonly Schema = schema;

			public override readonly name = name as Name;

			constructor(
				public readonly data: StaticData<Data>,
				options?: ErrorOptions,
			) {
				super(name, options);
				this.name = name;
			}

			static isInstance(input: unknown): input is InstanceType<typeof result> {
				return typeof input === "object" && input !== null && "name" in input && input.name === name;
			}

			schema() {
				return schema;
			}

			toObject() {
				return {
					name,
					data: this.data,
				};
			}
		};

		Object.defineProperty(result, "name", { value: name });
		return result;
	}

	public static readonly Unknown = NamedError.create("UnknownError", {
		type: "object",
		required: ["message"],
		properties: {
			message: {
				type: "string",
			},
		},
	});
}
