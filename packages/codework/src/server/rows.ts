import { Store, type Sync } from "@codeworksh/harness/effect";
import { Effect, Option, Stream } from "effect";

/** Rows per page; each page is one read transaction, which writes wait behind. */
export const batch = 500;

type Pages<A, R> = (from: Sync.Cursor, upto: number) => Effect.Effect<Sync.Page<A>, never, R>;

/** Every row past `from` up to `head`, page by page, then `synced` at that head. */
const range = <A, R>(from: number, head: Store.Head, page: Pages<A, R>, synced: (head: Store.Head) => A) =>
	Stream.paginate<Sync.Cursor, A, never, R>({ rev: from }, (cursor) =>
		page(cursor, head.rev).pipe(Effect.map(({ items, next }) => [items, Option.fromUndefinedOr(next)] as const)),
	).pipe(Stream.concat(Stream.make(synced(head))));

/**
 * A revision-ordered stream: `start` at the head when it opens, then every row past the last head
 * sent, page by page, and `synced` at the new head after each commit. The doorbell is registered
 * before the first read, so no commit falls between.
 */
export const watch = <A, R, R2>(
	start: (head: Store.Head) => Stream.Stream<A, never, R2>,
	page: Pages<A, R>,
	synced: (head: Store.Head) => A,
): Stream.Stream<A, never, R | R2 | Store.Service> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const store = yield* Store.Service;
			const wake = yield* store.wake;
			let sent: number | undefined;
			const round = Stream.unwrap(
				Effect.gen(function* () {
					const head = yield* store.head;
					if (head.rev === sent) return Stream.empty;
					const from = sent;
					sent = head.rev;
					const next: Stream.Stream<A, never, R | R2> =
						from === undefined ? start(head) : range(from, head, page, synced);
					return next;
				}),
			);
			return Stream.make(undefined).pipe(
				Stream.concat(Stream.fromSubscription(wake)),
				Stream.flatMap(() => round),
			);
		}),
	);

/** `watch` from revision `after`: every row past it first, then the same live. */
export const follow = <A, R>(
	after: number,
	page: Pages<A, R>,
	synced: (head: Store.Head) => A,
): Stream.Stream<A, never, R | Store.Service> => watch((head) => range(after, head, page, synced), page, synced);
