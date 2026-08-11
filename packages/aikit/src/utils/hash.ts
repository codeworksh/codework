/** Fast deterministic hash for shortening provider wire identifiers. */
export function shortHash(value: string): string {
	let high = 0xdeadbeef;
	let low = 0x41c6ce57;
	for (let index = 0; index < value.length; index++) {
		const character = value.charCodeAt(index);
		high = Math.imul(high ^ character, 2654435761);
		low = Math.imul(low ^ character, 1597334677);
	}
	high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
	low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
	return (low >>> 0).toString(36) + (high >>> 0).toString(36);
}
