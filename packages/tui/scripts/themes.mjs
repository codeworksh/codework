// Generates `src/theme/palettes.rs` from the landing site's palettes, which are the source of
// truth for the TUI's 16 tokens — plus the one ink the landing canvas derives from two of them.
// The output is committed, so building the TUI never needs this script; run it with `--check` to
// fail when the site has moved and the file is stale.
//
//   node scripts/themes.mjs           # rewrite src/theme/palettes.rs
//   node scripts/themes.mjs --check   # exit 1 if it would change
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const site = (path) => fileURLToPath(new URL(`../../../sites/www/src/${path}`, import.meta.url));
const output = fileURLToPath(new URL("../src/theme/palettes.rs", import.meta.url));

const CSS = site("styles/themes.css");
const REGISTRY = site("components/landing/theme.ts");
const FIELD = site("components/landing/field.tsx");

/** The site token -> the Rust field that carries it, in the order the design doc lists them. */
const TOKENS = [
	["bg", "bg"],
	["surface", "surface"],
	["surface-2", "surface_2"],
	["border-subtle", "border_subtle"],
	["border-strong", "border_strong"],
	["text", "text"],
	["text-secondary", "text_secondary"],
	["text-muted", "text_muted"],
	["brand", "brand"],
	["brand-ink", "brand_ink"],
	["field-bg", "field_bg"],
	["field-dim", "field_dim"],
	["field-mid", "field_mid"],
	["field-lit", "field_lit"],
	["field-hover", "field_hover"],
	["field-crest", "field_crest"],
];

const problems = [];
const note = (message) => problems.push(message);

/**
 * The one colour the canvas derives rather than stores: its lattice, a `mixHex` of two of its own
 * tokens. The recipe is read out of the canvas instead of restated here, so a change there is a
 * drift failure rather than a silent difference.
 */
function gridRecipe() {
	const source = readFileSync(FIELD, "utf8");
	const found = source.match(/grid:\s*mixHex\(token\("([a-z-]+)"\),\s*token\("([a-z-]+)"\),\s*([0-9.]+)\)/);
	if (found === null) {
		note("field.tsx: no `grid: mixHex(...)` recipe");
		return null;
	}
	// The canvas names its inks `token("dim")` for `--t-field-dim`.
	const token = (name) => `field-${name}`;
	for (const mixed of [found[1], found[2]]) {
		if (!TOKENS.some(([name]) => name === token(mixed)))
			note(`field.tsx: grid mixes --t-${token(mixed)}, which is not a token`);
	}
	return { from: token(found[1]), to: token(found[2]), t: Number(found[3]) };
}

/** Mixes two #rrggbb colours, `t` of the way from a to b, as the canvas does. */
const mix = (a, b, t) =>
	`#${[1, 3, 5]
		.map((i) => {
			const [from, to] = [parseInt(a.slice(i, i + 2), 16), parseInt(b.slice(i, i + 2), 16)];
			return Math.round(from + (to - from) * t);
		})
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")}`;

/** `[data-theme="id"] { --t-x: #hex; … color-scheme: dark|light }` blocks. */
function palettes() {
	const css = readFileSync(CSS, "utf8");
	const found = new Map();
	for (const block of css.matchAll(/\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*)\}/g)) {
		const [, id, body] = block;
		const tokens = {};
		for (const token of body.matchAll(/--t-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[token[1]] = token[2];
		const scheme = body.match(/color-scheme:\s*(dark|light)/)?.[1];

		if (Object.keys(tokens).length !== TOKENS.length) {
			note(`${id}: ${Object.keys(tokens).length} tokens, expected ${TOKENS.length}`);
		}
		for (const [token] of TOKENS) if (tokens[token] === undefined) note(`${id}: missing --t-${token}`);
		if (scheme === undefined) note(`${id}: no color-scheme`);
		if (found.has(id)) note(`${id}: appears twice`);
		found.set(id, { tokens, light: scheme === "light" });
	}
	return found;
}

/** The `THEMES` list and `DEFAULT_THEME`, which own the ids, labels, order and scheme. */
function registry() {
	const source = readFileSync(REGISTRY, "utf8");
	const themes = [];
	for (const entry of source.matchAll(/\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)"(,\s*light:\s*true)?\s*\}/g)) {
		themes.push({ id: entry[1], name: entry[2], light: entry[3] !== undefined });
	}
	const fallback = source.match(/DEFAULT_THEME\s*=\s*"([^"]+)"/)?.[1];
	if (themes.length === 0) note("registry: no themes parsed");
	if (fallback === undefined) note("registry: no DEFAULT_THEME");
	return { themes, fallback };
}

const found = palettes();
const { themes, fallback } = registry();
const grid = gridRecipe();

// The two files have to agree both ways, or a theme would render as nothing.
for (const theme of themes) if (!found.has(theme.id)) note(`registry has ${theme.id}, no palette`);
for (const id of found.keys()) if (!themes.some((t) => t.id === id)) note(`palette ${id} is not in the registry`);
if (fallback !== undefined && !themes.some((t) => t.id === fallback))
	note(`DEFAULT_THEME ${fallback} is not in the registry`);

for (const theme of themes) {
	const palette = found.get(theme.id);
	if (palette !== undefined && palette.light !== theme.light) {
		note(`${theme.id}: registry says light=${theme.light}, color-scheme says light=${palette.light}`);
	}
}

if (problems.length > 0) {
	console.error(`themes.mjs: the site's palettes and registry disagree:\n  ${problems.join("\n  ")}`);
	process.exit(1);
}

const rgb = (hex) => {
	const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
	return `Color::Rgb(0x${r.toLowerCase()}, 0x${g.toLowerCase()}, 0x${b.toLowerCase()})`;
};

const body = themes
	.map((theme) => {
		const { tokens } = found.get(theme.id);
		const fields = TOKENS.map(([token, field]) => `        ${field}: ${rgb(tokens[token])},`);
		// Declared next to `field-bg`, which is where the canvas lists it.
		fields.splice(
			TOKENS.findIndex(([, field]) => field === "field_bg") + 1,
			0,
			`        field_grid: ${rgb(mix(tokens[grid.from], tokens[grid.to], grid.t))},`,
		);
		return `    Palette {
        id: "${theme.id}",
        name: ${JSON.stringify(theme.name)},
        scheme: Scheme::${theme.light ? "Light" : "Dark"},
${fields.join("\n")}
    },`;
	})
	.join("\n");

const header = [
	"// @generated by scripts/themes.mjs from the landing site's palettes. Do not edit.",
	"//",
	"// Source: sites/www/src/styles/themes.css (the 16 tokens),",
	"// sites/www/src/components/landing/theme.ts (ids, labels, scheme, default) and",
	"// sites/www/src/components/landing/field.tsx (the lattice ink it derives from two tokens).",
	"// Re-run `node scripts/themes.mjs` after any of them moves; `--check` fails on drift.",
].join("\n");

const defaultLine = `/// The site's \`DEFAULT_THEME\`, so the two do not drift.\npub const DEFAULT: &str = "${fallback}";`;

const generated = `${header}

use ratatui::style::Color;

use super::{Palette, Scheme};

pub static PALETTES: &[Palette] = &[
${body}
];

${defaultLine}
`;

if (process.argv.includes("--check")) {
	if (readFileSync(output, "utf8") !== generated) {
		console.error("themes.mjs: src/theme/palettes.rs is stale — run `node scripts/themes.mjs`");
		process.exit(1);
	}
	console.log(`themes.mjs: ${themes.length} palettes are up to date`);
	process.exit(0);
}

writeFileSync(output, generated);
console.log(`themes.mjs: wrote ${themes.length} palettes to src/theme/palettes.rs`);
