import { Effect, Random } from "effect";

const PREFIXES = [
	"binary",
	"protocol",
	"astromech",
	"thermal",
	"ionic",
	"encrypted",
	"holonet",
	"hyperspace",
	"magnetic",
	"logic",
	"plasma",
	"vector",
	"optical",
	"quantum",
	"mechanical",
	"servo",
	"fusion",
	"flux",
	"sychro",
	"static",
] as const;

const HARDWARE = [
	"core",
	"unit",
	"node",
	"array",
	"link",
	"processor",
	"module",
	"uplink",
	"interface",
	"splicer",
	"matrix",
	"buffer",
	"relay",
	"circuit",
	"sensor",
	"driver",
	"bridge",
	"manifold",
	"oscillator",
	"terminal",
] as const;

const SECTORS = [
	"kuat",
	"corellia",
	"coruscant",
	"bespin",
	"kamino",
	"mustafar",
	"fondor",
	"hosnian",
	"lothal",
	"scarif",
	"sub-level",
	"deep-space",
	"outer-rim",
	"mid-rim",
	"sector-7",
] as const;

const CONNECTORS = ["at", "of", "in"] as const;

// The words alone collide within a few hundred sessions; the tail of the id (the random end of
// a uuidv7) keeps the slug unique without a retry.
export const create = Effect.fnUntraced(function* (id: string) {
	const prefix = yield* Random.choice(PREFIXES);
	const hardware = yield* Random.choice(HARDWARE);
	const connector = yield* Random.choice(CONNECTORS);
	const sector = yield* Random.choice(SECTORS);
	return `${prefix}-${hardware}-${connector}-${sector}-${id.slice(-8)}`;
});

export * as Slug from "./slug.ts";
