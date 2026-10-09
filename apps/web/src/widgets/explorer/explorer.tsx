import { RegistryContext, useAtomSet } from "@effect/atom-react";
import type { Entry } from "@codeworksh/server/contract";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Schema } from "effect";
import { Atom } from "effect/reactivity";
import { type CSSProperties, useContext, useEffect, useRef, useState } from "react";

import { runQuery, Server, type WidgetProps } from "../../sdk";

export interface ExplorerProps {
	/** Absolute directory shown as the tree's root. */
	readonly root: string;
}

// Storage namespace: the widget's kind.
const PACKAGE = "explorer";

// One query atom per path, so folders listed together resolve independently.
const listing = Atom.family((path: string) => Server.query("fs.list", { path }));
const saved = Atom.family((key: string) => Server.query("kv.get", { package: PACKAGE, key }));

const writeExpanded = Server.mutation("kv.set");

// Tree paths are relative to the root; directories end with "/".
const treePaths = (directory: string, entries: readonly Entry[]) =>
	entries.map(({ name, kind }) => `${directory}${name}${kind === "directory" ? "/" : ""}`);

const isPathList = Schema.is(Schema.Array(Schema.String));

/**
 * Lazy file tree: a directory's children are listed when it is first expanded,
 * and the expanded set is saved per instance so the tree reopens as it was left.
 */
export function Explorer({ instanceId, props: { root } }: WidgetProps<ExplorerProps>) {
	const registry = useContext(RegistryContext);
	const save = useAtomSet(writeExpanded, { mode: "promise" });
	const [error, setError] = useState<string | null>(null);
	const { model } = useFileTree({
		paths: [],
		initialExpansion: "closed",
		density: "compact",
		search: false,
	});

	// Directories already listed, so expanding again does not refetch.
	const loaded = useRef(new Set<string>());
	const known = useRef(new Set<string>());
	const key = `widget/${instanceId}/expanded`;

	useEffect(() => {
		let active = true;
		const load = async (directory: string) => {
			loaded.current.add(directory);
			const entries = await runQuery(registry, listing(`${root}/${directory}`));
			return treePaths(directory, entries);
		};

		void (async () => {
			try {
				const stored = await runQuery(registry, saved(key));
				const expanded = stored._tag === "Some" && isPathList(stored.value) ? stored.value : [];
				const listings = await Promise.all([""].concat(expanded).map(load));
				if (!active) return;
				const paths = listings.flat();
				paths.forEach((path) => known.current.add(path));
				model.resetPaths(paths, { initialExpandedPaths: expanded });
			} catch (cause) {
				if (active) setError(String(cause));
			}
		})();

		let lastSaved = "";
		const onChange = () => {
			const expanded = [...known.current].filter((path) => {
				const item = model.getItem(path);
				return item !== null && "isExpanded" in item && item.isExpanded();
			});
			for (const directory of expanded) {
				if (loaded.current.has(directory)) continue;
				void load(directory).then((paths) => {
					if (!active) return;
					const added = paths.filter((path) => !known.current.has(path));
					added.forEach((path) => known.current.add(path));
					model.batch(added.map((path) => ({ type: "add" as const, path })));
				});
			}
			const serialized = expanded.join("\n");
			if (serialized !== lastSaved) {
				lastSaved = serialized;
				void save({ payload: { package: PACKAGE, key, value: expanded } });
			}
		};
		const unsubscribe = model.subscribe(onChange);
		return () => {
			active = false;
			unsubscribe();
		};
	}, [model, root, key, registry, save]);

	if (error !== null) {
		return <p className="p-3 text-ink-muted">Could not load files: {error}</p>;
	}
	return (
		<FileTree
			model={model}
			className="h-full"
			style={
				{
					"--trees-bg-override": "transparent",
					"--trees-fg-override": "var(--cw-ink)",
					"--trees-fg-muted-override": "var(--cw-ink-muted)",
					"--trees-border-color-override": "var(--cw-edge)",
				} as CSSProperties
			}
		/>
	);
}
