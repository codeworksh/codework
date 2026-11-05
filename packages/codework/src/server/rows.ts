import { Store, type Sync } from "@codeworksh/harness/effect";
import { Effect, Option, Stream } from "effect";

/** Rows per page; each page is one read transaction, which writes wait behind. */
export const batch = 500;

/**
 * A revision-ordered stream: every row past `after`, page by page up to the head, then `synced` at
 * that head; then the same from the last head after each commit. The doorbell is registered before
 * the first read, so no commit falls between.
 */
export const follow = <A, R>(
	after: number,
	page: (from: Sync.Cursor, upto: number) => Effect.Effect<Sync.Page<A>, never, R>,
	synced: (head: Store.Head) => A,
): Stream.Stream<A, never, R | Store.Service> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const store = yield* Store.Service;
			const wake = yield* store.wake;
			let sent: number | undefined;
			const round = Stream.unwrap(
				Effect.gen(function* () {
					const head = yield* store.head;
					if (head.rev === sent) return Stream.empty;
					const from = sent ?? after;
					sent = head.rev;
					return Stream.paginate<Sync.Cursor, A, never, R>({ rev: from }, (cursor) =>
						page(cursor, head.rev).pipe(
							Effect.map(({ items, next }) => [items, Option.fromUndefinedOr(next)] as const),
						),
					).pipe(Stream.concat(Stream.make(synced(head))));
				}),
			);
			return Stream.make(undefined).pipe(
				Stream.concat(Stream.fromSubscription(wake)),
				Stream.flatMap(() => round),
			);
		}),
	);

export * as Rows from "./rows.ts";
