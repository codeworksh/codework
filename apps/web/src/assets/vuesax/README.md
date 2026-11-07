# Vuesax icons

These SVG files are copied byte for byte from the two supplied folders:

- `original/`: `/Users/prempatel/Desktop/vuesax` (156 SVGs).
- `community/`: `/Users/prempatel/Desktop/2000+ Free Linear Icons Set (Community) (1)/vuesax` (810 SVGs).

Each directory preserves its source folder structure and filenames. Files with the same name remain in both collections because their artwork can differ.

`components/vuesax.tsx` renders individual files using CSS masks so they follow the UI's text color without modifying the originals. Vite imports file URLs with `no-inline`; only displayed icons are fetched by the browser. `assets/vuesax.ts` lists the available paths for TypeScript.
