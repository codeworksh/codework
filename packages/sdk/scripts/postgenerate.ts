import fs from "node:fs/promises";

const generated = new URL("../src/generated/", import.meta.url);
const banner = "/* oxlint-disable */\n";

async function generatedFiles(directory: URL): Promise<URL[]> {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const files: URL[] = [];

	for (const entry of entries) {
		const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
		if (entry.isDirectory()) files.push(...(await generatedFiles(url)));
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(url);
	}

	return files;
}

for (const file of await generatedFiles(generated)) {
	const source = await fs.readFile(file, "utf8");
	if (source.startsWith(banner)) continue;
	await fs.writeFile(file, banner + source);
}
