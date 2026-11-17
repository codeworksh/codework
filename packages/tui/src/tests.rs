//! Protocol/UI regression coverage, written before the migration implementation.
//! Failure modes: a promoted prompt restored after a failed cancellation; lane/text edits
//! clobbering each other; late replies mutating a different thread; duplicate/overlapping
//! pages or a viewport jump; drafts offered as fork points; before-forks losing returned
//! text; stale checkpoints overwriting live Unicode deltas; folding losing intermediate notes.
//! These isolated checks exercise cancellation, concurrency and data integrity boundaries.

use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use futures_util::{SinkExt, StreamExt};
use ratatui::{backend::TestBackend, Terminal};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::app::{turns_from_history, App, Screen};
use crate::event::AppEvent;
use crate::rpc::RpcClient;
use crate::types::{HistoryEntry, ThreadInfo, ThreadItem};

fn thread(id: &str) -> ThreadInfo {
    serde_json::from_value(json!({
        "id": id, "session": {"id":"session", "spaceId":"space", "slug":"Conversation",
        "directory":"/workspace", "mainThreadId":"main"}, "parked":true
    }))
    .unwrap()
}

fn entry(id: &str, seq: u64, role: &str, parts: Value) -> HistoryEntry {
    serde_json::from_value(json!({"id":id, "seq":seq, "threadId":"main", "role":role,
        "state":"committed", "createdAt":1000, "updatedAt":62500, "parts":parts}))
    .unwrap()
}

fn key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) {
    app.update(AppEvent::Key(KeyEvent::new(code, modifiers)));
}

async fn receive(app: &mut App, rx: &mut mpsc::UnboundedReceiver<AppEvent>) {
    let event = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .unwrap()
        .unwrap();
    app.update(event);
}

struct Server {
    url: String,
    calls: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server() -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = calls.clone();
    let task = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let calls = recorded.clone();
            tokio::spawn(async move {
                let mut ws = accept_async(socket).await.unwrap();
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let request: Value = serde_json::from_str(text.trim()).unwrap();
                    if request["_tag"] != "Request" {
                        continue;
                    }
                    calls.lock().await.push(request.clone());
                    let payload = &request["payload"];
                    let value = match request["tag"].as_str().unwrap() {
                        "event.subscribe" => continue,
                        "model.list" => json!({"providers":[]}),
                        "thread.info" => {
                            serde_json::to_value(thread(payload["threadId"].as_str().unwrap()))
                                .unwrap()
                        }
                        "thread.cancel" => json!({"cancelled": payload["messageId"] != "promoted"}),
                        "thread.update" => json!({"updated":true}),
                        "thread.fork" => json!({"thread":thread("fork"), "text":
                            if payload["mode"] == "before" {Some("edit me")} else {None}}),
                        "thread.page" => {
                            json!({"entries":[entry("old", 1, "user", json!([{"type":"text","text":"older prompt"}]))]})
                        }
                        "thread.sync" => {
                            let item =
                                json!({"_tag":"Synced", "storeId":"store", "rev":4, "floor":1});
                            ws.send(Message::Text(
                                json!({"_tag":"Chunk", "requestId":request["id"], "values":[item]})
                                    .to_string(),
                            ))
                            .await
                            .unwrap();
                            continue;
                        }
                        other => panic!("unexpected RPC {other}"),
                    };
                    ws.send(Message::Text(
                        json!({"_tag":"Exit", "requestId":request["id"],
                        "exit":{"_tag":"Success", "value":value}})
                        .to_string(),
                    ))
                    .await
                    .unwrap();
                }
            });
        }
    });
    Server { url, calls, task }
}

#[tokio::test]
async fn queue_keyboard_actions_obey_server_results_and_preserve_composer() {
    let server = server().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut app = App::with_client(tx, RpcClient::new(&server.url));
    app.session = Some(thread("main"));
    app.screen = Screen::Session;
    app.prompt.insert_text("unsent draft");
    for id in ["queued", "promoted", "remove"] {
        app.apply_item(ThreadItem::Inbox {
            prompt: serde_json::from_value(json!({
            "id":id,"text":"edit me","delivery":"followUp"}))
            .unwrap(),
            state: crate::types::InboxState::Pending,
            rev: 1,
        });
    }
    key(&mut app, KeyCode::Up, KeyModifiers::ALT);
    key(&mut app, KeyCode::Char('l'), KeyModifiers::NONE);
    receive(&mut app, &mut rx).await;
    assert_eq!(server.calls.lock().await[0]["payload"]["delivery"], "steer");
    key(&mut app, KeyCode::Char('e'), KeyModifiers::NONE);
    key(&mut app, KeyCode::Char('u'), KeyModifiers::CONTROL);
    app.update(AppEvent::Paste("rewritten".into()));
    key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
    receive(&mut app, &mut rx).await;
    assert_eq!(server.calls.lock().await[1]["payload"]["text"], "rewritten");
    assert!(server.calls.lock().await[1]["payload"]
        .get("delivery")
        .is_none());
    assert_eq!(app.prompt.text(), "unsent draft");
    // A failed cancellation cannot put an already-promoted message into the composer.
    key(&mut app, KeyCode::Down, KeyModifiers::NONE);
    key(&mut app, KeyCode::Char('w'), KeyModifiers::NONE);
    receive(&mut app, &mut rx).await;
    assert_eq!(app.prompt.text(), "unsent draft");
    key(&mut app, KeyCode::Up, KeyModifiers::NONE);
    key(&mut app, KeyCode::Char('w'), KeyModifiers::NONE);
    receive(&mut app, &mut rx).await;
    assert_eq!(app.prompt.text(), "rewritten\n\nunsent draft");
    assert_eq!(app.queued_prompts.len(), 2);
    key(&mut app, KeyCode::Up, KeyModifiers::ALT);
    key(&mut app, KeyCode::Down, KeyModifiers::NONE);
    key(&mut app, KeyCode::Delete, KeyModifiers::NONE);
    receive(&mut app, &mut rx).await;
    assert_eq!(app.prompt.text(), "rewritten\n\nunsent draft");
    assert_eq!(app.queued_prompts.len(), 1);
    assert_eq!(app.queued_prompts[0].message_id, "promoted");
    assert_eq!(server.calls.lock().await.len(), 5);
    app.busy = true;
    app.session.as_mut().unwrap().parked = false;
    key(&mut app, KeyCode::Char('l'), KeyModifiers::NONE);
    receive(&mut app, &mut rx).await;
    assert_eq!(
        app.queued_prompts[0].delivery,
        crate::types::PromptDelivery::Steer
    );
    key(&mut app, KeyCode::Char('l'), KeyModifiers::NONE);
    receive(&mut app, &mut rx).await;
    assert_eq!(
        app.queued_prompts[0].delivery,
        crate::types::PromptDelivery::FollowUp
    );
}

#[tokio::test]
async fn fork_picker_transitions_at_and_before_and_subscribes() {
    for mode in ["at", "before"] {
        let server = server().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = App::with_client(tx, RpcClient::new(&server.url));
        app.session = Some(thread("main"));
        app.entries = vec![entry(
            "u",
            2,
            "user",
            json!([{"type":"text","text":"edit me"}]),
        )];
        app.screen = Screen::Session;
        app.open_fork();
        key(
            &mut app,
            if mode == "before" {
                KeyCode::Char('b')
            } else {
                KeyCode::Enter
            },
            KeyModifiers::NONE,
        );
        receive(&mut app, &mut rx).await;
        assert_eq!(app.session.as_ref().unwrap().id, "fork");
        assert_eq!(
            app.prompt.text(),
            if mode == "before" { "edit me" } else { "" }
        );
        while app.floor.is_none() {
            receive(&mut app, &mut rx).await;
        }
        let calls = server.calls.lock().await;
        assert_eq!(calls[0]["tag"], "thread.fork");
        assert_eq!(calls[0]["payload"]["mode"], mode);
        let sync = calls.iter().find(|c| c["tag"] == "thread.sync").unwrap();
        assert_eq!(sync["payload"]["threadId"], "fork");
    }
}

#[tokio::test]
async fn scroll_pages_older_history_without_moving_held_content() {
    let server = server().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut app = App::with_client(tx, RpcClient::new(&server.url));
    app.session = Some(thread("main"));
    app.screen = Screen::Session;
    app.apply_item(ThreadItem::Entry {
        entry: entry("new", 8, "user", json!([{"type":"text","text":"newer"}])),
        rev: 8,
    });
    app.apply_item(ThreadItem::Synced {
        store_id: "store".into(),
        rev: 8,
        floor: Some(8),
    });
    app.max_scroll.set(20);
    app.scroll = 19;
    app.update(AppEvent::Scroll(3));
    app.update(AppEvent::Scroll(3)); // only one request in flight
    receive(&mut app, &mut rx).await;
    assert_eq!(
        app.entries.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![1, 8]
    );
    assert_eq!(app.scroll, 20); // offset from bottom stays fixed on prepend
    assert_eq!(app.floor, Some(1));
    let calls = server.calls.lock().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0]["payload"],
        json!({"sessionId":"session","threadId":"main","before":8,"limit":60})
    );
}

#[test]
fn work_log_separates_final_answer_and_folds_on_phase_change() {
    let mut entries = vec![
        entry("u", 1, "user", json!([{"type":"text","text":"Question"}])),
        entry(
            "a1",
            2,
            "assistant",
            json!([{"type":"thinking","thinking":"Reasoning"},
        {"type":"text","text":"Intermediate note"}, {"type":"toolCall","callID":"c","name":"read",
        "status":"completed","time":{"start":1000,"end":63000}}]),
        ),
        entry(
            "a2",
            3,
            "assistant",
            json!([{"type":"text","text":"Final answer"}]),
        ),
    ];
    let turns = turns_from_history(&entries);
    assert_eq!(turns[0].text, "Final answer");
    assert_eq!(turns[0].notes, "Intermediate note");
    assert_eq!(turns[0].duration(), "1m 2s");
    assert!(!turns[0].work_expanded());
    entries.pop();
    entries[1].state = "draft".into();
    entries[1]
        .parts
        .retain(|p| !matches!(p, crate::types::Part::Text { .. }));
    let mut turn = turns_from_history(&entries).remove(0);
    assert!(turn.work_expanded());
    turn.work_open = Some(false);
    assert!(!turn.work_expanded());
    for (ms, label) in [(0, "1s"), (59500, "1m"), (3600000, "1h 0m")] {
        assert_eq!(crate::app::format_elapsed(ms), label);
    }
}

#[test]
fn streamed_deltas_and_stale_checkpoints_preserve_unicode_and_settled_entries() {
    let mut app = App::default();
    let mut reply = entry("a", 2, "assistant", json!([{"type":"text","text":"Hi"}]));
    reply.state = "draft".into();
    app.apply_item(ThreadItem::Entry {
        entry: reply.clone(),
        rev: 1,
    });
    let delta = serde_json::from_value(
        json!({"entryId":"a","partIndex":0,"kind":"text","offset":2,"delta":" 🦀"}),
    )
    .unwrap();
    app.apply_item(ThreadItem::Delta { delta });
    app.apply_item(ThreadItem::Entry {
        entry: reply.clone(),
        rev: 1,
    });
    assert_eq!(app.turns[0].text, "Hi 🦀");
    reply.state = "committed".into();
    app.apply_item(ThreadItem::Entry {
        entry: reply.clone(),
        rev: 2,
    });
    reply.state = "draft".into();
    app.apply_item(ThreadItem::Entry {
        entry: reply,
        rev: 1,
    });
    assert_eq!(app.entries[0].state, "committed");
}

#[test]
fn renders_repeatable_conversation_artifact_and_osc52() {
    let mut app = App::default();
    app.session = Some(thread("main"));
    app.screen = Screen::Session;
    app.apply_item(ThreadItem::Entry {
        entry: entry(
            "u",
            1,
            "user",
            json!([{"type":"text","text":"Explain the change"}]),
        ),
        rev: 1,
    });
    app.apply_item(ThreadItem::Entry {
        entry: entry(
            "a",
            2,
            "assistant",
            json!([{"type":"thinking","thinking":"Hidden reasoning"},
        {"type":"text","text":"The conversation is ready."}]),
        ),
        rev: 2,
    });
    app.apply_item(ThreadItem::Inbox {
        prompt: serde_json::from_value(
            json!({"id":"q","text":"Next question","delivery":"followUp"}),
        )
        .unwrap(),
        state: crate::types::InboxState::Pending,
        rev: 3,
    });
    let mut terminal = Terminal::new(TestBackend::new(88, 18)).unwrap();
    terminal.draw(|frame| crate::ui::view(&app, frame)).unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = (0..18)
        .map(|y| {
            (0..88)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut rendered = rendered;
    for (ms, normalized) in [(1000, "00:00"), (62500, "00:01")] {
        let local = chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .with_timezone(&chrono::Local)
            .format("%H:%M")
            .to_string();
        rendered = rendered.replace(&local, normalized);
    }
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("__artifacts__/conversation.txt");
    if std::env::var_os("UPDATE_ARTIFACTS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
    }
    assert_eq!(
        rendered,
        std::fs::read_to_string(path)
            .expect("run UPDATE_ARTIFACTS=1 cargo test to create artifact")
    );
    assert_eq!(crate::app::osc52("hello"), "\x1b]52;c;aGVsbG8=\x07");
    assert_eq!(crate::app::osc52("🦀"), "\x1b]52;c;8J+mgA==\x07");
}

#[test]
fn late_operations_cannot_mutate_a_different_thread_or_subscription() {
    use crate::app::OperationResult;
    use crate::event::RpcEvent;
    use crate::rpc::protocol::ThreadRefPayload;
    let mut app = App::default();
    app.session = Some(thread("main"));
    let old = ThreadRefPayload {
        session_id: "session".into(),
        thread_id: "other".into(),
    };
    let result = Ok(OperationResult::Cancel {
        id: "q".into(),
        restore: Some("stale".into()),
        cancelled: true,
    });
    app.update(AppEvent::rpc(RpcEvent::Operation {
        address: old,
        generation: 0,
        result,
    }));
    assert!(app.prompt.text().is_empty());
    app.update(AppEvent::rpc(RpcEvent::Operation {
        address: ThreadRefPayload {
            session_id: "session".into(),
            thread_id: "main".into(),
        },
        generation: 99,
        result: Ok(OperationResult::Fork(crate::rpc::protocol::ForkResponse {
            thread: thread("wrong"),
            text: Some("stale".into()),
        })),
    }));
    assert_eq!(app.session.as_ref().unwrap().id, "main");
}

#[test]
fn work_log_manual_override_resets_when_final_answer_starts_streaming() {
    let mut app = App::default();
    let mut reply = entry(
        "a",
        2,
        "assistant",
        json!([{"type":"thinking","thinking":"Working"}]),
    );
    reply.state = "draft".into();
    app.apply_item(ThreadItem::Entry {
        entry: reply.clone(),
        rev: 1,
    });
    assert!(app.turns[0].work_expanded());
    key(&mut app, KeyCode::Char('o'), KeyModifiers::CONTROL);
    assert!(!app.turns[0].work_expanded());
    key(&mut app, KeyCode::Char('o'), KeyModifiers::CONTROL);
    assert!(app.turns[0].work_expanded());
    reply.parts.push(crate::types::Part::Text {
        text: "Answer".into(),
    });
    app.apply_item(ThreadItem::Entry {
        entry: reply,
        rev: 2,
    });
    assert!(!app.turns[0].work_expanded());
}

#[test]
fn deltas_before_entries_and_utf16_offsets_are_reconciled() {
    let mut app = App::default();
    for (offset, delta) in [(0, "🦀"), (2, " hello")] {
        app.apply_item(ThreadItem::Delta {
            delta: serde_json::from_value(
                json!({"entryId":"a","partIndex":0,"kind":"text","offset":offset,"delta":delta}),
            )
            .unwrap(),
        });
    }
    let mut reply = entry("a", 1, "assistant", json!([]));
    reply.state = "draft".into();
    app.apply_item(ThreadItem::Entry {
        entry: reply,
        rev: 1,
    });
    assert_eq!(app.turns[0].text, "🦀 hello");
}

#[test]
fn live_tool_progress_survives_a_checkpoint_and_resets_with_the_store() {
    use crate::event::RpcEvent;
    use crate::rpc::{protocol::ThreadRefPayload, StreamEvent};
    let mut app = App::default();
    app.session = Some(thread("main"));
    let mut reply = entry(
        "a",
        2,
        "assistant",
        json!([{"type":"toolCall","callID":"c","name":"bash","arguments":{"command":"ls"},"status":"running"}]),
    );
    reply.state = "draft".into();
    app.apply_item(ThreadItem::Entry {
        entry: reply.clone(),
        rev: 1,
    });
    let envelope=serde_json::from_value(json!({"type":"session.tool.progress","data":{"threadId":"main","callID":"c","partial":{"content":[{"type":"text","text":"live output"}]}}})).unwrap();
    let address = ThreadRefPayload {
        session_id: "session".into(),
        thread_id: "main".into(),
    };
    app.update(AppEvent::rpc(RpcEvent::ThreadStream {
        address: address.clone(),
        generation: 0,
        event: StreamEvent::Event(envelope),
    }));
    app.apply_item(ThreadItem::Entry {
        entry: reply.clone(),
        rev: 2,
    });
    assert_eq!(app.turns[0].tools[0].output.as_deref(), Some("live output"));
    app.update(AppEvent::rpc(RpcEvent::ThreadStream {
        address,
        generation: 0,
        event: StreamEvent::Reset,
    }));
    assert!(app.entries.is_empty());
    app.apply_item(ThreadItem::Entry {
        entry: reply,
        rev: 1,
    });
    assert_eq!(app.entries.len(), 1);
    assert!(app.turns[0].tools[0].output.is_none());
}

#[test]
fn failed_queue_action_does_not_unlock_another_in_flight_action() {
    use crate::{app::OperationResult, event::RpcEvent, rpc::protocol::ThreadRefPayload};
    let mut app = App::default();
    app.session = Some(thread("main"));
    app.queue_pending.extend(["a".into(), "b".into()]);
    app.update(AppEvent::rpc(RpcEvent::Operation {
        address: ThreadRefPayload {
            session_id: "session".into(),
            thread_id: "main".into(),
        },
        generation: 0,
        result: Ok(OperationResult::QueueFailed {
            id: "a".into(),
            error: "failed".into(),
        }),
    }));
    assert!(!app.queue_pending.contains("a"));
    assert!(app.queue_pending.contains("b"));
}
