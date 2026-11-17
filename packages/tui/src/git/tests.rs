//! Written before implementation. Failure modes: wrong-space or stale replies showing another
//! checkout's patch; status updates moving selection; omitted/binary patches appearing clean;
//! Git headers corrupting line numbers; long patches silently truncated; review keys sending
//! prompts or destroying drafts. The terminal E2E uses a real Git repository and the real binary.
use super::*;
use crate::{
    app::App,
    event::{AppEvent, RpcEvent},
    rpc::RpcClient,
    types::ThreadInfo,
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;

fn thread(space: &str) -> ThreadInfo {
    serde_json::from_value(json!({"id":"main","session":{"id":"session","spaceId":space,"slug":"Git test","directory":"/workspace","mainThreadId":"main"}})).unwrap()
}
fn status(space: &str, at: u64, files: &[&str]) -> Status {
    serde_json::from_value(json!({"spaceId":space,"observedAt":at,"available":true,"branch":"main","head":"0123456789abcdef","files":files.iter().map(|file|json!({"file":file,"status":"modified","additions":1,"deletions":1})).collect::<Vec<_>>()})).unwrap()
}
fn key(app: &mut App, code: KeyCode) {
    app.update(AppEvent::Key(KeyEvent::new(code, KeyModifiers::NONE)));
}

#[test]
fn status_preserves_selection_and_rejects_older_or_wrong_space_data() {
    let mut git = Git::for_space("space".into());
    git.apply_status(status("space", 1, &["b.rs", "a.rs"]));
    assert_eq!(git.selected.as_deref(), Some("a.rs"));
    git.select(1);
    assert_eq!(git.selected.as_deref(), Some("b.rs"));
    git.apply_status(status("space", 2, &["c.rs", "b.rs"]));
    assert_eq!(git.selected.as_deref(), Some("b.rs"));
    git.apply_status(status("other", 3, &["wrong"]));
    git.apply_status(status("space", 1, &["old"]));
    assert_eq!(git.status.as_ref().unwrap().files.len(), 2);
    git.apply_status(status("space", 3, &["c.rs"]));
    assert_eq!(git.selected.as_deref(), Some("c.rs"));
}

#[test]
fn review_preserves_composer_and_checks_space_generation_and_patch_request() {
    let mut app = App::default();
    app.switch_thread(thread("space"));
    app.prompt.insert_text("unsent\n    draft");
    app.update(AppEvent::rpc(RpcEvent::Git {
        space_id: "space".into(),
        generation: 1,
        event: GitEvent::Status(status("space", 1, &["a.rs"])),
    }));
    app.update(AppEvent::Key(KeyEvent::new(
        KeyCode::Char('g'),
        KeyModifiers::CONTROL,
    )));
    assert!(app.git.open);
    let request = app.git.request;
    let patch = Diff {
        files: vec![FileDiff {
            file: "a.rs".into(),
            patch: "@@ -1 +1 @@\n-old\n+new\n".into(),
            status: Change::Modified,
            additions: 1,
            deletions: 1,
        }],
        cached: false,
        truncated: false,
    };
    for (space, generation, request_id) in [
        ("other", 1, request),
        ("space", 99, request),
        ("space", 1, request.saturating_sub(1)),
    ] {
        app.update(AppEvent::rpc(RpcEvent::GitDiff {
            space_id: space.into(),
            generation,
            request_id,
            file: "a.rs".into(),
            result: Ok(patch.clone()),
        }));
        assert!(app.git.diff.is_none());
    }
    app.update(AppEvent::rpc(RpcEvent::GitDiff {
        space_id: "space".into(),
        generation: 1,
        request_id: request,
        file: "a.rs".into(),
        result: Ok(patch),
    }));
    assert!(app.git.diff.is_some());
    key(&mut app, KeyCode::Enter);
    key(&mut app, KeyCode::Esc);
    key(&mut app, KeyCode::Esc);
    assert!(!app.git.open);
    assert_eq!(app.prompt.text(), "unsent\n    draft");
    assert!(!app.should_quit);
    let mut moved = thread("original");
    moved.placement = Some(crate::types::ThreadPlacement {
        space_id: "override".into(),
        directory: "/remote".into(),
    });
    app.switch_thread(moved);
    assert_eq!(app.git.space_id.as_deref(), Some("override"));
}

#[test]
fn full_git_patches_share_rendering_without_metadata_or_preview_truncation() {
    let mut patch="diff --git a/file b/file\nindex 123..456 100644\n--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n@@ -20 +20 @@\n-before\n+after\n".to_string();
    patch.push_str(&" context\n".repeat(80));
    let rendered = crate::diff::render_view(
        &patch,
        80,
        0,
        crate::theme::default_palette(),
        crate::diff::View::Unified,
    );
    let text = rendered
        .lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!text.contains("diff --git"));
    assert!(!text.contains("index 123"));
    assert!(text.contains("after"));
    assert!(rendered.lines.len() > 60);
    assert_eq!(rendered.hunks.len(), 2);
    assert_eq!(rendered.hunks[0], 0);
}

#[test]
fn git_screen_records_repeatable_cached_and_truncated_states() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = App::with_client(
        tokio::sync::mpsc::unbounded_channel().0,
        RpcClient::default(),
    );
    app.session = Some(thread("space"));
    app.git = Git::for_space("space".into());
    app.git
        .apply_status(status("space", 1, &["src/a.rs", "notes with spaces.txt"]));
    app.git.open = true;
    app.git.diff = Some(Diff {
        files: vec![FileDiff {
            file: "notes with spaces.txt".into(),
            patch: "@@ -0,0 +1 @@\n+New notes\n".into(),
            status: Change::Added,
            additions: 1,
            deletions: 0,
        }],
        cached: true,
        truncated: true,
    });
    app.git.loading = false;
    let mut terminal = Terminal::new(TestBackend::new(100, 18)).unwrap();
    terminal.draw(|frame| crate::ui::view(&app, frame)).unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = (0..18)
        .map(|y| {
            (0..100)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    assert!(rendered.contains("cached"));
    assert!(rendered.contains("truncated"));
    assert!(rendered.contains("New notes"));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("__artifacts__/git.txt");
    if std::env::var_os("UPDATE_ARTIFACTS").is_some() {
        std::fs::write(&path, &rendered).unwrap();
    }
    assert_eq!(
        rendered,
        std::fs::read_to_string(path).expect("run UPDATE_ARTIFACTS=1 cargo test")
    );
}
