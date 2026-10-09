const prefix = "codework://session/";

export const sessionAddress = (id: string) => `${prefix}${id}`;

export const sessionId = (address: string | undefined) =>
	address?.startsWith(prefix) ? address.slice(prefix.length) : undefined;
