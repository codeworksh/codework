import type { CSSProperties } from "react";

/** Badge colours, light-theme ink then dark-theme ink; light-dark() follows the theme's color-scheme. */
const INKS = [
	["#dc2626", "#f87171"],
	["#ea580c", "#fb923c"],
	["#d97706", "#fbbf24"],
	["#65a30d", "#a3e635"],
	["#059669", "#34d399"],
	["#0d9488", "#2dd4bf"],
	["#0284c7", "#38bdf8"],
	["#2563eb", "#60a5fa"],
	["#7c3aed", "#a78bfa"],
	["#db2777", "#f472b6"],
] as const;

/** The same project always gets the same colour, without storing one. */
function inkOf(id: string) {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	const [light, dark] = INKS[Math.abs(hash) % INKS.length]!;
	return `light-dark(${light}, ${dark})`;
}

/** Two letters: the first and last word's initials (`codework-prompt-musk` → CM), else a word's first and last letter. */
function monogram(name: string) {
	const words = name.split(/[\s._-]+/).filter(Boolean);
	const first = words[0] ?? "?";
	const last = words.at(-1) ?? first;
	return (words.length > 1 ? `${first[0]}${last[0]}` : `${first[0]}${first.at(-1) ?? ""}`).toUpperCase();
}

/** A coloured two-letter badge for a name; `large` suits a rail of buttons. */
export function Monogram({ id, name, large = false }: { id: string; name: string; large?: boolean }) {
	return (
		<span
			aria-hidden
			style={{ color: inkOf(id) } as CSSProperties}
			className={`grid shrink-0 place-items-center bg-[color-mix(in_oklab,currentColor_14%,transparent)] font-mono font-bold ${large ? "size-6 rounded-md text-3xs" : "size-4 rounded-sm text-4xs"}`}
		>
			{monogram(name)}
		</span>
	);
}
