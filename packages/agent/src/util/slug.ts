export namespace Slug {
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

	export function create(): string {
		const pick = <T extends readonly string[]>(arr: T): T[number] => arr[Math.floor(Math.random() * arr.length)]!;

		const prefix = pick(PREFIXES);
		const component = pick(HARDWARE);
		const sector = pick(SECTORS);

		const connectors = ["at", "of", "in"] as const;
		const connector = connectors[Math.floor(Math.random() * connectors.length)];

		return `${prefix}-${component}-${connector}-${sector}`;
	}
}
