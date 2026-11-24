# Runtime

The runtime is the durable part of the harness: how a prompt becomes a run, how a run becomes turns, and how all of it survives a process that dies halfway. Everything here lives in `packages/harness`. The rule underneath it all is that every durable change is an event, and the state the runtime acts on is projected from those events in the same transaction.

## Sessions and Threads

A session is one event log. Every thread of a session writes to it, so a session has a single sequence space and the order of events across its threads is total ([list.ts](../../packages/harness/src/event/list.ts)).

A thread is one line of history. `session.created` creates the session together with its `main` thread, and the database allows exactly one `main` per session. A fork does not copy history. It records its origin thread and a committed entry, and the thread's line is read recursively up the origin chain, cut at each fork point ([thread.ts](../../packages/harness/src/thread/thread.ts)). Only documents are copied at a fork, each by its own fork policy. A fork point must be committed: a draft is still changing and an aborted entry is not part of the context.

The `subagent` origin is modelled in the schema and its constraints, but nothing creates subagent threads yet.

Per-session overrides held by [runtime.ts](../../packages/harness/src/session/runtime.ts) are process memory and never reach the log. The model and thinking level are not among them; they are durable session config.

## Storage and Control

[control.ts](../../packages/harness/src/control.ts) holds the commands that start, join and stop work. `Session.Service` and `Thread.Service` are repositories: they record what happened and never learn that a process manager exists. Control decides whether, when and for how long a session runs. Control depends on execution and storage, and neither depends back. Keep it that way: nothing below Control may reach up into fiber ownership.

`prompt` lives on Control, not on the session, because admitting a prompt is only half a command. The durable record is inert until something is told to drain it, and that telling is process state.

Below Control sit two services. Execution ([execute.ts](../../packages/harness/src/runner/execute.ts)) owns the per-thread [coordinator](../../packages/harness/src/runner/coordinator.ts) and the run lifecycle events. The runner ([loop.ts](../../packages/harness/src/runner/loop.ts)) does the turns. `RunnerExecution.noopLayer` exists for callers that only need durable threads.

Projectors are registered by a layer with no service ([projector.ts](../../packages/harness/src/session/projector.ts)). Provide `SessionLive.layer`, never `Session.layer` alone. Without the projectors, `admit` publishes happily, writes no inbox row, and nothing type-errors.

## Prompts and the Inbox

Admission publishes `session.prompt.admitted`, and its projector writes the inbox row ([inbox.ts](../../packages/harness/src/inbox/inbox.ts)). `Control.prompt` returns once the prompt is stored, not once it is in the conversation. A prompt enters the transcript at promotion: publishing `session.prompt.promoted` appends the user entry in the same commit, so "promoted but absent from history" cannot exist. Between admission and promotion the inbox row is the only durable record of the message.

Prompt ids make retries safe. Re-admitting an id returns the stored row. A reused id with different content, or an id that already left the inbox, is a `PromptConflictError`. A cancelled id may be admitted again and revives as a fresh admission; this is a deliberate choice. Admission is uninterruptible end to end, so a client that disconnects never leaves a prompt half-admitted.

Delivery picks a lane. `steer` is the default: it joins running work at the next boundary. `followUp` waits for the agent to finish a reply. A run promotes at two kinds of boundary:

| Boundary    | When                                                   | What it promotes                                         |
| ----------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `final`     | A run's first promotion, or a reply without tool calls | Every steer and the oldest follow-up, in admission order |
| `postTools` | Tool results are waiting for a reply                   | Steers only                                              |

One follow-up per boundary makes that lane turn-at-a-time. Steers promote all at once, on purpose. Promotion only takes prompts admitted at or before a cutoff read when the turn starts, so a prompt landing mid-promotion stays out of a request that is already being assembled.

Promotion, cancel and update are compare-and-set on the inbox row: whichever commits first wins, and the loser's event rolls back. `promote` counts only the promotions this caller won. Counting another drainer's promotion would have two workers answer one prompt. Moving a pending prompt to the steer lane wakes the thread, which is how a parked prompt is made to run now.

## Runs, Executions and Turns

| Term    | Starts with                           | Ends with                                                           |
| ------- | ------------------------------------- | ------------------------------------------------------------------- |
| Run     | `session.execution.started`           | Exactly one terminal from `EventList.RunEnded`                      |
| Turn    | `session.turn.started` (ephemeral)    | `session.turn.ended`, the only commit, or `session.turn.aborted`    |
| Attempt | `session.llm.started` (a draft entry) | `session.llm.ended` then the turn's commit, or `session.llm.failed` |

The coordinator serializes one execution per thread per process; different threads run concurrently. A wake is a doorbell: it starts a drain while idle, or marks the running one to drain again. Drains are level-triggered. When one returns, execution re-checks whether a prompt is still runnable and wakes again, so work queued behind a hook's `end` or a lost lifecycle publish is never stranded.

`execution.started` is published before anything is promoted. A process that dies anywhere in a run therefore leaves an open run for the next start to find. The terminals are separate event types (`execution.succeeded`, `execution.failed`, `execution.interrupted`, `run.failed`) so each carries only what its outcome has. Anything that waits for a run to end must use `EventList.isRunEnded`. A terminal left out of that union is a hang no client can see.

Nothing is committed before `TurnEnded`, so a failed attempt can always be repeated against the same assembled context. Each failed attempt keeps its aborted draft in the log, and the next attempt opens a new one. Aborted entries stay out of the model's context. Retries follow [retry.ts](../../packages/harness/src/runner/retry.ts): only failures the provider calls transient are retried, never quota errors, and context overflow is left to compaction. A reply cut off at the output limit gets its tool calls back as errors to re-issue, and too many in a row end the run as `run.failed` with reason `truncated`.

## Events and Projections

An event definition with a `durable` option is stored; one without is ephemeral and only reaches live subscribers. Text deltas, tool progress and `turn.started` are ephemeral. Streaming replies are checkpointed durably by `session.llm.progress`, so a dead host leaves what was streamed.

Publishing a durable event bumps the session's sequence, runs every projector for its type and inserts the event row, all in one `Store.write` transaction ([event.ts](../../packages/harness/src/event/event.ts)). A projector that dies rolls the event back. The inbox uses this on purpose: a second admission or promotion raises `LifecycleConflict` as a defect inside the commit, and the caller recovers by reading the row that won.

Traps here:

- A command reads what it needs before it publishes. The commit transaction must open with a write (the sequence bump), or SQLite has to upgrade a read lock. Projectors may read, because they run after the bump.
- The SQLite client holds one connection behind a semaphore. That is what stops a log follower from seeing a bumped sequence whose row is not there yet. A connection pool would take that guarantee away.
- Publish-time context (correlation, tracing) rides the in-memory payload and is not stored. A projector that needs it must persist it itself.
- A row whose type this build does not know is skipped on read, not failed, so an older build can read a log a newer one wrote.

## Durability

The thread row carries two log positions that decide what runs ([thread.ts](../../packages/harness/src/thread/thread.ts)). `thread.head` is the seq of the last unanswered run end: an `execution.failed`, a `run.failed` or a user stop. Each inbox row has a `tail`, set when it is admitted or moved to the steer lane. A pending prompt is runnable when its tail is past the head. A parked queue is derived from these, never stored: idle, nothing owed, prompts pending. So a stop or a failure parks the queue instead of dropping it. The next prompt wakes the thread, and the parked prompts promote with it at their boundaries. Keeping queued prompts across a stop is a deliberate choice.

A stop is recorded before anything is interrupted. `Control.interrupt` publishes `execution.stopping` first, so a host that dies while the stop winds down ends the run as the user's, not as a crash to resume. A host interruption that loses the race to that record rolls back with `RunStoppingError` and is republished as the user's stop. A user stop that finds no execution in this process still ends whatever durable state says is owed a run.

`InterruptReason` says who stopped an execution, because the cause alone cannot tell them apart:

| Reason     | Recorded by                                                              | Afterwards                                                              |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `user`     | A stop request                                                           | The queue is parked                                                     |
| `shutdown` | The server's shutdown, or the coordinator when a scope closes it unnamed | Resumed; the request in flight is resent at once as the same attempt    |
| `crash`    | The startup sweep, for a run still open                                  | Resumed; the attempt in flight counts as failed and waits out its retry |

Only `codework serve` recovers ([server.ts](../../packages/codework/src/server/server.ts)). Before it listens, `Control.sweep` ends every open run as a crash, or as the user's if it was stopping. Then `resumeUnfinished` wakes every thread whose last run was cut off or that holds a runnable prompt. It only rings the bell: each drain reads what it is owed from the thread itself, and one thread failing leaves the others resuming.

A resumed drain first settles the draft the dead process left. A request that was in flight is aborted with what it streamed. Tool calls that never settled are aborted and never run again, and the turn commits with `recovered: true` so the model sees what ran.

Crash loops end visibly. `claimRestart` counts a crash restart, but not a shutdown and not a crash while the run slept in retry backoff. A committed turn resets the count, except a `recovered` commit, which made no progress. At `RESTART_LIMIT` the run ends as `run.failed` with reason `crashloop` and its queue parks for the next prompt.

Two gaps are accepted. Each prompt at a boundary promotes in its own commit, so a crash partway through answers only the prompts promoted before it. The retry deadline is not persisted, so a crash during backoff sleeps the full delay again.

## Database Versions

Migrations are code in [migrations.ts](../../packages/harness/src/db/migrations.ts) and run by high-water mark: an id dated before one already applied is silently skipped. Databases from before the thread model are discarded, not upgraded. Columns later folded into the initial migration are checked at open, and a database missing one fails with `OutdatedError`, telling the user to delete it. Add a column that way and it must join the folded list, or old databases fail on their first query instead.

## Compaction

A `compaction` entry holds a summary, the first entry it keeps (`null` means the summary replaces all earlier history) and the token count before it ([schema.ts](../../packages/harness/src/session/schema.ts)). Context assembly starts at the newest `compaction` or `reset` entry and wraps the summary as a user message ([assemble.ts](../../packages/harness/src/context/assemble.ts)). The server's line feed leaves these harness entries out.

Nothing writes compaction entries yet. The intended seam is the runner hooks in [hooks.ts](../../packages/harness/src/runner/hooks.ts), whose default layer does nothing today.
