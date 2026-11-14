//! Failure modes considered before implementation: multiline paste losing indentation;
//! Unicode caret positions splitting characters; vertical moves losing the desired column;
//! drafts leaking between threads/servers, lost on restart, or overwritten by a stale save;
//! withdrawal replacing an unsent draft; live browser refresh losing its filter/selection;
//! closed or superseded browser subscriptions reopening the picker.
use crate::{
    app::{App, Popup},
    draft::DraftStore,
    event::{AppEvent, RpcEvent},
    prompt::Prompt,
    rpc::RpcClient,
    types::ThreadInfo,
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

fn thread(id: &str) -> ThreadInfo {
    serde_json::from_value(json!({"id":id,"session":{"id":"session","spaceId":"space","slug":"Chat","directory":"/workspace","mainThreadId":"main","project":{"id":"project","name":"CodeWork"}}})).unwrap()
}
fn key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) {
    app.update(AppEvent::Key(KeyEvent::new(code, modifiers)));
}
fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "codework-tui-conversation-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn multiline_paste_and_unicode_navigation_preserve_source_text() {
    let mut prompt = Prompt::default();
    prompt.insert_text("fn main() {\r\n\tprintln!(\"🦀\");\r\n}\x1b");
    assert_eq!(prompt.text(), "fn main() {\n\tprintln!(\"🦀\");\n}");
    prompt.edit(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(prompt.before_caret(), "fn main() {\n\tprintln!(\"🦀\");\n");
    prompt.edit(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(prompt.before_caret(), "fn main() {\n");
    prompt.edit(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    assert!(prompt.before_caret().ends_with("\");"));
    prompt.edit(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::CONTROL));
    assert!(prompt.text().contains("\");\n\n}"));
    let layout = prompt.layout(12);
    assert!(layout.lines.len() > 3);
    assert!(layout.caret.0 < 12);
    assert!(layout.caret.1 < layout.lines.len());
    let mut vertical = Prompt::default();
    vertical.insert_text("abcdef\nx\nabcdef");
    vertical.edit(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    vertical.edit(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(vertical.before_caret(), "abcdef");
}

#[test]
fn drafts_survive_restart_and_are_isolated_by_endpoint_and_thread() {
    let root = root();
    let store = DraftStore::at(&root, "ws://one/rpc");
    let mut draft = Prompt::default();
    draft.insert_text("first\n\t🦀");
    draft.edit(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    store.save("session/main", &draft).unwrap();
    let restored = DraftStore::at(&root, "ws://one/rpc")
        .load("session/main")
        .unwrap()
        .unwrap();
    assert_eq!(restored.text(), draft.text());
    assert_eq!(restored.before_caret(), draft.before_caret());
    assert!(store.load("session/fork").unwrap().is_none());
    assert!(DraftStore::at(&root, "ws://two/rpc")
        .load("session/main")
        .unwrap()
        .is_none());
    store.save("session/main", &Prompt::default()).unwrap();
    assert!(store.load("session/main").unwrap().is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn switch_and_restart_restore_each_threads_draft_scroll_and_work_state() {
    let root = root();
    let (tx, _) = mpsc::unbounded_channel();
    let mut app = App::with_storage(
        tx,
        RpcClient::new("ws://one/rpc"),
        DraftStore::at(&root, "ws://one/rpc"),
    );
    app.switch_thread(thread("main"));
    app.update(AppEvent::Paste("main\n    draft".into()));
    app.scroll = 17;
    let user = serde_json::from_value(
        json!({"id":"u","seq":1,"role":"user","parts":[{"type":"text","text":"Question"}]}),
    )
    .unwrap();
    let answer=serde_json::from_value(json!({"id":"a","seq":2,"role":"assistant","parts":[{"type":"thinking","thinking":"work"},{"type":"text","text":"Answer"}]})).unwrap();
    app.apply_item(crate::types::ThreadItem::Entry {
        entry: user,
        rev: 1,
    });
    app.apply_item(crate::types::ThreadItem::Entry {
        entry: answer,
        rev: 2,
    });
    app.turns[0].work_open = Some(true);
    let entries = app.entries.clone();
    app.switch_thread(thread("fork"));
    assert!(app.prompt.text().is_empty());
    app.update(AppEvent::Paste("fork draft".into()));
    app.switch_thread(thread("main"));
    assert_eq!(app.prompt.text(), "main\n    draft");
    assert_eq!(app.scroll, 17);
    for (at, entry) in entries.into_iter().enumerate() {
        app.apply_item(crate::types::ThreadItem::Entry {
            entry,
            rev: at as u64 + 1,
        });
    }
    assert!(app.turns[0].work_expanded());
    drop(app);
    let (tx, _) = mpsc::unbounded_channel();
    let mut restarted = App::with_storage(
        tx,
        RpcClient::new("ws://one/rpc"),
        DraftStore::at(&root, "ws://one/rpc"),
    );
    restarted.switch_thread(thread("main"));
    assert_eq!(restarted.prompt.text(), "main\n    draft");
    // Drop before cleaning the private test directory so shutdown cannot recreate it.
    drop(restarted);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn withdrawal_prepends_text_without_destroying_current_draft() {
    use crate::{app::OperationResult, rpc::protocol::ThreadRefPayload};
    let mut app = App::default();
    app.session = Some(thread("main"));
    app.prompt.insert_text("unsent\n    draft");
    app.update(AppEvent::rpc(RpcEvent::Operation {
        address: ThreadRefPayload {
            session_id: "session".into(),
            thread_id: "main".into(),
        },
        generation: 0,
        result: Ok(OperationResult::Cancel {
            id: "queued".into(),
            restore: Some("withdrawn\nmessage".into()),
            cancelled: true,
        }),
    }));
    assert_eq!(app.prompt.text(), "withdrawn\nmessage\n\nunsent\n    draft");
}

#[test]
fn browser_refresh_keeps_filter_and_selection_and_displays_group_and_state() {
    let mut app = App::default();
    app.prompt.insert_text("keep my draft");
    key(&mut app, KeyCode::Char('p'), KeyModifiers::CONTROL);
    app.update(AppEvent::rpc(RpcEvent::ThreadsLoaded {
        generation: 1,
        result: Ok(vec![thread("main"), thread("fork")]),
    }));
    app.update(AppEvent::Paste("codework".into()));
    key(&mut app, KeyCode::Down, KeyModifiers::NONE);
    let selected = app
        .popup
        .as_ref()
        .unwrap()
        .menu()
        .selected()
        .unwrap()
        .id
        .to_string();
    let mut updated = thread(&selected);
    updated.parked = true;
    updated.title = Some("Renamed".into());
    app.update(AppEvent::rpc(RpcEvent::ThreadsLoaded {
        generation: 1,
        result: Ok(vec![updated, thread("new")]),
    }));
    let Some(Popup::Sessions { search, menu, .. }) = &app.popup else {
        panic!("browser closed")
    };
    assert_eq!(search.text(), "codework");
    assert_eq!(menu.selected().unwrap().id.as_ref(), selected);
    assert!(menu.selected().unwrap().detail.contains("parked"));
    assert!(menu.selected().unwrap().detail.contains("CodeWork"));
    key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
    assert_eq!(app.prompt.text(), "keep my draft");
    app.update(AppEvent::rpc(RpcEvent::ThreadsLoaded {
        generation: 1,
        result: Ok(vec![thread("late")]),
    }));
    assert!(app.popup.is_none());
}
