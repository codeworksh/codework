/** A prompt the start page sent with a new session, as the session's view first shows it. */
export type Handoff = { readonly id: string; readonly text: string; readonly createdAt: number };

/**
 * Kept until the session's view opens, which then shows it as sent: the backend queues a first
 * prompt before the conversation takes it in, which would otherwise flash a steer row.
 */
export const handoffs = new Map<string, Handoff>();
