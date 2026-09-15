import { Effect, Encoding } from "effect";
import { crypto } from "../host.ts";

const encoder = new TextEncoder();

export function fast(input: string | Uint8Array): string {
	const data = typeof input === "string" ? encoder.encode(input) : input;
	return Encoding.encodeHex(Effect.runSync(crypto.digest("SHA-1", data)));
}

export function sha256(input: string | Uint8Array): string {
	const data = typeof input === "string" ? encoder.encode(input) : input;
	return Encoding.encodeHex(Effect.runSync(crypto.digest("SHA-256", data)));
}
export * as Hash from "./hash.ts";
