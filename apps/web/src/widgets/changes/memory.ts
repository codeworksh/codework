/**
 * What a placed copy last showed of a space, kept while the app runs: a frame leaves the screen with
 * its workspace, and returns as it was left.
 */
export interface Memory {
	readonly space: string;
	/** Files are folded unless unfolded here, so a file that appears arrives folded. */
	readonly opened: ReadonlySet<string>;
	readonly selected: string | undefined;
	/** The file at the top of the list, and how far the list was scrolled into it. */
	readonly anchor: { readonly file: string; readonly offset: number } | undefined;
	/** The files in view, whose diffs are drawn with the first frame on return. */
	readonly visible: ReadonlySet<string>;
}

const memories = new Map<string, Memory>();

export const recall = (instanceId: string, space: string): Memory => {
	const known = memories.get(instanceId);
	return known?.space === space
		? known
		: { space, opened: new Set(), selected: undefined, anchor: undefined, visible: new Set() };
};

export const remember = (instanceId: string, space: string, change: Partial<Memory>) =>
	void memories.set(instanceId, { ...recall(instanceId, space), ...change });
