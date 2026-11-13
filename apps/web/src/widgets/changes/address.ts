const prefix = "codework://changes/";

/** A space's changes: `codework://changes/<machine id>/<space id>`. */
export const changesAddress = (machineId: string, spaceId: string) => `${prefix}${machineId}/${spaceId}`;

export const changesRef = (address: string | undefined) => {
	if (!address?.startsWith(prefix)) return undefined;
	const [machineId, spaceId, ...rest] = address.slice(prefix.length).split("/");
	if (machineId === undefined || machineId === "" || spaceId === undefined || spaceId === "" || rest.length > 0)
		return undefined;
	return { machineId, spaceId };
};
