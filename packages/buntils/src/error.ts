import { type Static, type TObject, type TProperties, type TSchema, Type } from "@sinclair/typebox";

export abstract class NamedError extends Error {
	abstract schema(): TSchema;
	abstract toObject(): { name: string; data: unknown };

	static create<Name extends string, Data extends TObject<TProperties>>(name: Name, data: Data) {
		const schema = Type.Object(
			{
				name: Type.Literal(name),
				data,
			},
			{ $id: name },
		);

		const result = class extends NamedError {
			public static readonly Schema = schema;

			public override readonly name = name as Name;

			constructor(
				public readonly data: Static<Data>,
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

	public static readonly Unknown = NamedError.create(
		"UnknownError",
		Type.Object({
			message: Type.String(),
		}),
	);
}
