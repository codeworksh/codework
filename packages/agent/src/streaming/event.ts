import Type, { type Static, type TSchema } from "typebox";

export namespace BusEvent {
	export type Definition<EventType extends string = string, Properties extends TSchema = TSchema> = {
		type: EventType;
		properties: Properties;
	};
	export type Payload<Definition extends BusEvent.Definition = BusEvent.Definition> = {
		type: Definition["type"];
		properties: Static<Definition["properties"]>;
	};

	const registry = new Map<string, Definition>();

	export function define<const EventType extends string, const Properties extends TSchema>(
		type: EventType,
		properties: Properties,
	): Definition<EventType, Properties> {
		const result = {
			type,
			properties,
		};
		registry.set(type, result);
		return result;
	}

	export function payloads() {
		return Type.Union(
			Array.from(registry.entries(), ([type, def]) => {
				return Type.Object(
					{
						type: Type.Literal(type),
						properties: def.properties,
					},
					{ $id: "Event" + "." + def.type },
				);
			}),
			{ $id: "Event" },
		);
	}
}
