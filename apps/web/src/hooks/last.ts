import { useState } from "react";

/** `value`, or while it is undefined, the last value it had. */
export function useLast<T>(value: T | undefined): T | undefined {
	const [last, setLast] = useState(value);
	if (value !== undefined && value !== last) setLast(value);
	return value ?? last;
}
