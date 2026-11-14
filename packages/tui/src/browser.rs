//! A grouped view of the harness's thread list; no Desktop app-server dependency.
use crate::{
    menu::{Entry, Menu},
    types::{RunState, ThreadInfo, ThreadOrigin},
};

pub fn menu(threads: &[ThreadInfo], query: &str, selected: Option<&str>) -> Menu {
    let mut threads: Vec<_> = threads.iter().collect();
    threads.sort_by_key(|t| {
        (
            project(t).to_lowercase(),
            t.session.id.clone(),
            origin_rank(&t.origin),
            std::cmp::Reverse(t.updated_at),
            t.id.clone(),
        )
    });
    let entries = threads
        .into_iter()
        .map(|t| {
            let state = match t.run_state {
                RunState::Starting => "starting",
                RunState::Running => "running",
                RunState::Idle if t.parked => "parked",
                RunState::Idle => "idle",
            };
            let (mark, origin) = match &t.origin {
                ThreadOrigin::Main => ("●", "main".to_string()),
                ThreadOrigin::Fork { thread_id, .. } => ("⑂", format!("fork of {thread_id}")),
                ThreadOrigin::Subagent { thread_id, .. } => {
                    ("↳", format!("subagent of {thread_id}"))
                }
            };
            Entry::owned(
                t.id.clone(),
                format!("{mark} {}", t.display_title()),
                format!(
                    "{} / {} · {state} · {origin} · {}",
                    project(t),
                    t.session.slug,
                    t.working_directory()
                ),
            )
        })
        .collect();
    let mut menu = Menu::at(entries, selected.unwrap_or(""));
    let query = query.to_lowercase();
    menu.filter(|e| {
        e.name.to_lowercase().contains(&query)
            || e.detail.to_lowercase().contains(&query)
            || e.id.to_lowercase().contains(&query)
    });
    menu
}
fn project(t: &ThreadInfo) -> &str {
    t.session
        .project
        .as_ref()
        .map(|p| p.name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| t.working_directory())
}
fn origin_rank(origin: &ThreadOrigin) -> u8 {
    match origin {
        ThreadOrigin::Main => 0,
        ThreadOrigin::Fork { .. } => 1,
        ThreadOrigin::Subagent { .. } => 2,
    }
}
