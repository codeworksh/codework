import { Buffer } from "node:buffer";

export const hasLiveOidc = (value: string | undefined): boolean => {
	if (value === undefined) return false;
	try {
		const payload: unknown = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8"));
		return (
			typeof payload === "object" &&
			payload !== null &&
			"exp" in payload &&
			typeof payload.exp === "number" &&
			payload.exp * 1000 > Date.now() + 60_000
		);
	} catch {
		return false;
	}
};
