import Type, { type TObject, type TOptionalAdd, type TProperties, type TSchema } from "typebox";

type OptionalizeProperties<T extends TProperties> = {
	[K in keyof T]: TOptionalAdd<T[K]>;
};

class ObjectSchemaBuilder<TPropertiesMap extends TProperties> {
	private readonly properties: TProperties;

	constructor(schema: TObject<TPropertiesMap>) {
		this.properties = { ...schema.properties };
	}

	withOption<TKey extends string, TOptionSchema extends TSchema>(
		key: TKey,
		schema: TOptionSchema,
	): ObjectSchemaBuilder<
		Omit<TPropertiesMap, TKey> & {
			[K in TKey]: TOptionalAdd<TOptionSchema>;
		}
	> {
		this.properties[key] = Type.Optional(schema);
		return this as unknown as ObjectSchemaBuilder<
			Omit<TPropertiesMap, TKey> & {
				[K in TKey]: TOptionalAdd<TOptionSchema>;
			}
		>;
	}

	withOptions<TNextProperties extends TProperties>(
		properties: TNextProperties,
	): ObjectSchemaBuilder<Omit<TPropertiesMap, keyof TNextProperties> & OptionalizeProperties<TNextProperties>> {
		for (const [key, schema] of Object.entries(properties)) {
			this.properties[key] = Type.Optional(schema as TSchema);
		}
		return this as unknown as ObjectSchemaBuilder<
			Omit<TPropertiesMap, keyof TNextProperties> & OptionalizeProperties<TNextProperties>
		>;
	}

	popOption<TKey extends keyof TPropertiesMap>(key: TKey): ObjectSchemaBuilder<Omit<TPropertiesMap, TKey>> {
		delete this.properties[key as string];
		return this as unknown as ObjectSchemaBuilder<Omit<TPropertiesMap, TKey>>;
	}

	make(): TObject<TPropertiesMap> {
		return Type.Object(this.properties as TPropertiesMap);
	}
}

export function createObjectSchemaBuilder<TBaseProperties extends TProperties>(
	schema: TObject<TBaseProperties>,
): ObjectSchemaBuilder<TBaseProperties> {
	return new ObjectSchemaBuilder(schema);
}
