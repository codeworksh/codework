//! Turns one tool call's raw payload — the tool name, its `arguments`, and the
//! result `details` the harness publishes — into the short human view the
//! transcript shows.
//!
//! Everything here is pure and resolved once, when the event arrives, so the
//! renderer never re-parses JSON per frame. The only tool-specific knowledge is
//! a small name switch; a tool whose arguments we cannot read (a plugin's, say)
//! degrades to its label rather than failing, and every field read is
//! best-effort because `details` is arbitrary tool-defined JSON.

use serde_json::Value;

use crate::diff;
use crate::types::ToolResult;

/// Consecutive calls to one tool at or above this count collapse into one row.
pub const GROUP_MIN_RUN: usize = 3;

/// How many distinct targets a collapsed run lists before `…`.
const RUN_TITLES_MAX: usize = 3;

/// A path longer than this is shortened to its last two components.
const PATH_MAX_CHARS: usize = 40;

/// What the call touched: `bash` → its command, `read`/`edit` → the path,
/// `search` → the query. `None` when the tool's arguments say nothing readable,
/// which is the normal case for a plugin tool.
pub fn target(name: &str, arguments: &Value) -> Option<String> {
    let arg = |key: &str| arguments.get(key).and_then(Value::as_str);
    let derived = match name {
        // The command is the single most useful thing to show for bash, and it is
        // routinely multi-line: one line of layout is all the transcript has.
        "bash" => arg("command").map(collapse_whitespace),
        "read" | "edit" => arg("path").map(shorten_path),
        "search" => arg("query").map(|query| {
            if arg("mode") == Some("files") {
                format!("files: {}", collapse_whitespace(query))
            } else {
                collapse_whitespace(query)
            }
        }),
        _ => None,
    };
    derived.filter(|value| !value.is_empty())
}

/// Builds the display record for one settled call.
///
/// `arguments` and `details` come straight off the wire and a missing or
/// unexpected field only ever means a plainer line, never an error.
pub fn derive(
    name: &str,
    label: Option<&str>,
    arguments: &Value,
    details: Option<&Value>,
    is_error: bool,
) -> ToolResult {
    let patch = string_field(details, "patch");
    let first_changed_line = details
        .and_then(|details| details.get("firstChangedLine"))
        .and_then(Value::as_u64);
    let call_path = arguments.get("path").and_then(Value::as_str);
    let summary = match &patch {
        // An edit's summary *is* its diff: the counts are the whole point.
        Some(patch) => Some(edit_summary(patch, call_path, first_changed_line)),
        None => summary(name, details, is_error),
    };

    ToolResult {
        name: name.to_string(),
        target: target(name, arguments),
        label: label.unwrap_or(name).to_string(),
        summary,
        is_error,
        patch,
        first_changed_line,
    }
}

/// Carries the outcome from a settle onto the record of the call that was
/// running, keeping the identity the running line already resolved: the terminal
/// part repeats the arguments but not the tool's declared label.
pub fn settle(mut running: ToolResult, settled: ToolResult) -> ToolResult {
    running.is_error = settled.is_error;
    running.summary = settled.summary;
    running.patch = settled.patch;
    running.first_changed_line = settled.first_changed_line;
    running
}

/// A short result summary — line window, exit code, match counts — or `None`
/// when the tool's details say nothing worth a line.
pub fn summary(name: &str, details: Option<&Value>, is_error: bool) -> Option<String> {
    let details = details?;
    if is_error {
        return failure_summary(details);
    }
    match name {
        "read" => read_summary(details),
        "bash" => bash_summary(details),
        "search" => search_summary(details),
        _ => None,
    }
}

/// One row of a turn's settled tool list.
#[derive(Debug, Clone)]
pub enum ToolRow<'a> {
    /// A call rendered on its own: heading, plus a diff when it produced one.
    Single(&'a ToolResult),
    /// [`GROUP_MIN_RUN`] or more consecutive calls to the same tool.
    Run {
        name: String,
        members: Vec<&'a ToolResult>,
        /// How many of `members` failed.
        failed: usize,
    },
}

/// Collapses runs of consecutive calls to the same tool, so a long stretch of
/// `read`, `read`, `read` costs one line instead of twenty.
///
/// A run is never collapsed when any of its calls produced a diff: hiding a
/// change behind a count would defeat the point of rendering diffs at all.
pub fn group(tools: &[ToolResult]) -> Vec<ToolRow<'_>> {
    let mut rows = Vec::new();
    let mut index = 0;
    while index < tools.len() {
        let name = tools[index].name.as_str();
        let mut end = index + 1;
        while end < tools.len() && tools[end].name.as_str() == name {
            end += 1;
        }
        let run = &tools[index..end];
        if run.len() >= GROUP_MIN_RUN && run.iter().all(|tool| tool.patch.is_none()) {
            rows.push(ToolRow::Run {
                name: name.to_string(),
                members: run.iter().collect(),
                failed: run.iter().filter(|tool| tool.is_error).count(),
            });
        } else {
            rows.extend(run.iter().map(ToolRow::Single));
        }
        index = end;
    }
    rows
}

/// The distinct targets a collapsed run touched, in first-seen order, capped at
/// [`RUN_TITLES_MAX`] with a trailing `…` when more were involved.
pub fn run_targets(members: &[&ToolResult]) -> String {
    let mut distinct: Vec<&str> = Vec::new();
    for member in members {
        let target = member.target.as_deref().unwrap_or(&member.label);
        if !distinct.contains(&target) {
            distinct.push(target);
        }
    }
    let shown = distinct.len().min(RUN_TITLES_MAX);
    let mut text = distinct[..shown].join(", ");
    if distinct.len() > shown {
        text.push_str(", …");
    }
    text
}

fn string_field(details: Option<&Value>, key: &str) -> Option<String> {
    details?.get(key)?.as_str().map(str::to_string)
}

fn number(details: &Value, key: &str) -> Option<u64> {
    details.get(key).and_then(Value::as_u64)
}

/// A declared failure: a message when the tool wrote one, otherwise whatever
/// structured fact it did leave behind.
fn failure_summary(details: &Value) -> Option<String> {
    if let Some(message) = string_field(Some(details), "message") {
        return Some(collapse_whitespace(&message));
    }
    if let Some(seconds) = number(details, "timeoutSeconds") {
        return Some(format!("timed out after {seconds}s"));
    }
    if let Some(code) = number(details, "exitCode") {
        return Some(format!("exit {code}"));
    }
    // `reason` for the read/search/edit tools, `error` for an argument or
    // unknown-tool rejection: both arrive as snake_case identifiers.
    string_field(Some(details), "reason")
        .or_else(|| string_field(Some(details), "error"))
        .map(|value| value.replace('_', " "))
}

fn read_summary(details: &Value) -> Option<String> {
    let start = number(details, "startLine")?;
    let end = number(details, "endLine")?;
    let total = number(details, "totalLines")?;
    let mut text = if start == end {
        format!("line {start} of {total}")
    } else {
        format!("{start}-{end} of {total}")
    };
    if details.get("truncated").and_then(Value::as_bool) == Some(true) {
        text.push_str(" · truncated");
    }
    Some(text)
}

fn bash_summary(details: &Value) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(code) = number(details, "exitCode") {
        parts.push(format!("exit {code}"));
    }
    // How much output there was is the other thing worth knowing: it is how a
    // reader spots that a command said far more than the line shows.
    if let Some(lines) = string_field(Some(details), "output")
        .map(|output| output.lines().count())
        .filter(|lines| *lines > 1)
    {
        parts.push(format!("{lines} lines"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

fn search_summary(details: &Value) -> Option<String> {
    let files = number(details, "files")?;
    let matches = number(details, "matches")?;
    let files_label = if files == 1 {
        "1 file".to_string()
    } else {
        format!("{files} files")
    };
    let matches_label = if matches == 1 {
        "1 match".to_string()
    } else {
        format!("{matches} matches")
    };
    let mut text = format!("{files_label} · {matches_label}");
    if details.get("truncated").and_then(Value::as_bool) == Some(true) {
        text.push_str(" · truncated");
    } else if details.get("hasMore").and_then(Value::as_bool) == Some(true) {
        text.push_str(" · more");
    }
    Some(text)
}

/// `call_path` is the path the call declared, which the heading already shows;
/// repeating it here would say the same thing twice.
fn edit_summary(patch: &str, call_path: Option<&str>, first_changed_line: Option<u64>) -> String {
    let counts = diff::counts(patch);
    let mut parts = vec![format!("+{} −{}", counts.added, counts.removed)];
    if let Some(path) = diff::patch_path(patch) {
        if call_path != Some(path.as_str()) {
            parts.push(shorten_path(&path));
        }
    }
    if let Some(line) = first_changed_line {
        parts.push(format!("line {line}"));
    }
    parts.join(" · ")
}

/// Flattens all whitespace — including the newlines in a multi-line command —
/// so the value can sit on one row.
fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Keeps the tail of a long path (`…/plugin/builtin/edit.ts`), which is the part
/// that identifies it, instead of letting the renderer cut the file name off.
fn shorten_path(path: &str) -> String {
    if path.chars().count() <= PATH_MAX_CHARS {
        return path.to_string();
    }
    let mut tail: Vec<&str> = path.rsplitn(3, '/').collect();
    tail.truncate(2);
    tail.reverse();
    let candidate = format!("…/{}", tail.join("/"));
    if candidate.chars().count() <= PATH_MAX_CHARS {
        return candidate;
    }
    format!("…/{}", tail.last().copied().unwrap_or(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str, target: &str) -> ToolResult {
        ToolResult {
            name: name.to_string(),
            target: Some(target.to_string()),
            label: name.to_string(),
            summary: None,
            is_error: false,
            patch: None,
            first_changed_line: None,
        }
    }

    #[test]
    fn bash_target_is_its_command_on_one_line() {
        let args = json!({ "command": "npm test \\\n  --watch\t--run" });
        assert_eq!(target("bash", &args).as_deref(), Some("npm test \\ --watch --run"));
    }

    #[test]
    fn read_and_edit_targets_are_the_path() {
        let args = json!({ "path": "src/app.ts" });
        assert_eq!(target("read", &args).as_deref(), Some("src/app.ts"));
        assert_eq!(target("edit", &args).as_deref(), Some("src/app.ts"));
    }

    #[test]
    fn search_target_marks_files_mode() {
        assert_eq!(target("search", &json!({ "query": "useState" })).as_deref(), Some("useState"));
        assert_eq!(
            target("search", &json!({ "query": "*.test.ts", "mode": "files" })).as_deref(),
            Some("files: *.test.ts")
        );
    }

    #[test]
    fn long_paths_keep_their_tail() {
        let long = "packages/harness/src/plugin/builtin/tool/edit.ts";
        let shortened = target("read", &json!({ "path": long })).expect("a target");
        assert!(shortened.chars().count() <= PATH_MAX_CHARS, "{shortened}");
        assert!(shortened.ends_with("/tool/edit.ts"), "{shortened}");
        assert!(shortened.starts_with('…'), "{shortened}");
    }

    #[test]
    fn unreadable_arguments_have_no_target() {
        // A plugin tool, a tool with no arguments, a null value, a blank command.
        assert_eq!(target("acme_echo", &json!({ "anything": 1 })), None);
        assert_eq!(target("bash", &Value::Null), None);
        assert_eq!(target("bash", &json!({ "command": "" })), None);
        assert_eq!(target("bash", &json!({ "command": "   \n " })), None);
    }

    #[test]
    fn heading_composes_the_name_and_target() {
        let mut result = call("read", "src/app.ts");
        assert_eq!(result.heading(), "read src/app.ts");
        // With no readable target the label stands alone, as it did before.
        result.target = None;
        result.label = "echo".to_string();
        assert_eq!(result.heading(), "echo");
    }

    #[test]
    fn derive_reads_the_line_window() {
        let result = derive(
            "read",
            None,
            &json!({ "path": "src/app.ts", "offset": 120, "limit": 140 }),
            Some(&json!({
                "content": "1|…",
                "truncated": false,
                "path": "src/app.ts",
                "startLine": 120,
                "endLine": 260,
                "totalLines": 431,
            })),
            false,
        );
        assert_eq!(result.heading(), "read src/app.ts");
        assert_eq!(result.summary.as_deref(), Some("120-260 of 431"));
        assert!(result.patch.is_none());
    }

    #[test]
    fn read_summary_says_truncated() {
        let details = json!({
            "truncated": true,
            "startLine": 1,
            "endLine": 200,
            "totalLines": 900,
        });
        assert_eq!(
            summary("read", Some(&details), false).as_deref(),
            Some("1-200 of 900 · truncated")
        );
    }

    #[test]
    fn bash_success_reports_exit_code_and_output_size() {
        let details = json!({ "output": "a\nb\nc\n", "truncated": false, "exitCode": 0 });
        assert_eq!(summary("bash", Some(&details), false).as_deref(), Some("exit 0 · 3 lines"));
    }

    #[test]
    fn bash_single_line_output_reports_only_the_exit_code() {
        let details = json!({ "output": "ok\n", "truncated": false, "exitCode": 0 });
        assert_eq!(summary("bash", Some(&details), false).as_deref(), Some("exit 0"));
    }

    #[test]
    fn search_summary_counts_files_and_matches() {
        let details = json!({
            "matches": 17,
            "files": 3,
            "truncated": false,
            "hasMore": false,
            "backend": "ripgrep",
        });
        assert_eq!(
            summary("search", Some(&details), false).as_deref(),
            Some("3 files · 17 matches")
        );
    }

    #[test]
    fn search_summary_pluralises_and_flags_more() {
        let details = json!({ "matches": 1, "files": 1, "truncated": false, "hasMore": true });
        assert_eq!(
            summary("search", Some(&details), false).as_deref(),
            Some("1 file · 1 match · more")
        );
    }

    #[test]
    fn failure_summary_prefers_the_message() {
        let details = json!({
            "path": "src/app.ts",
            "reason": "no_match",
            "message": "oldText not found\nin src/app.ts",
        });
        assert_eq!(
            summary("edit", Some(&details), true).as_deref(),
            Some("oldText not found in src/app.ts")
        );
    }

    #[test]
    fn failure_summary_falls_back_to_structured_fields() {
        let bash = json!({ "output": "boom", "truncated": false, "exitCode": 127 });
        assert_eq!(summary("bash", Some(&bash), true).as_deref(), Some("exit 127"));

        let timeout = json!({ "output": "", "truncated": false, "timeoutSeconds": 30 });
        assert_eq!(summary("bash", Some(&timeout), true).as_deref(), Some("timed out after 30s"));

        let rejected = json!({ "error": "invalid_arguments", "name": "read" });
        assert_eq!(summary("read", Some(&rejected), true).as_deref(), Some("invalid arguments"));
    }

    #[test]
    fn edit_summary_comes_from_the_patch_without_repeating_the_path() {
        let patch = "--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,3 @@\n let a = 1;\n-let b = 2;\n+let b = 3;\n";
        let result = derive(
            "edit",
            None,
            &json!({ "path": "src/a.ts" }),
            Some(&json!({ "patch": patch, "path": "src/a.ts", "editsApplied": 1, "created": false, "firstChangedLine": 2 })),
            false,
        );
        assert_eq!(result.heading(), "edit src/a.ts");
        assert_eq!(result.summary.as_deref(), Some("+1 −1 · line 2"));
        assert_eq!(result.patch.as_deref(), Some(patch));
        assert_eq!(result.first_changed_line, Some(2));
    }

    #[test]
    fn edit_summary_keeps_the_path_when_the_call_did_not_declare_one() {
        let patch = "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
        assert_eq!(
            edit_summary(patch, None, None),
            "+1 −1 · src/a.ts",
            "with no heading path the summary must name the file"
        );
    }

    #[test]
    fn missing_details_plainly_degrade() {
        let result = derive("read", None, &json!({ "path": "src/app.ts" }), None, false);
        assert!(result.summary.is_none());
        assert!(result.patch.is_none());
        assert!(result.first_changed_line.is_none());

        let unknown = derive("acme_echo", None, &Value::Null, Some(&json!({ "stdout": "hi" })), false);
        assert_eq!(unknown.heading(), "acme_echo");
        assert!(unknown.summary.is_none());
    }

    #[test]
    fn settle_keeps_the_running_identity_and_takes_the_outcome() {
        // The terminal part omits `arguments`, so a settled record built from it
        // alone would lose the target; the running record supplies it.
        let running = derive("read", Some("read"), &json!({ "path": "src/app.ts" }), None, false);

        let ok = settle(
            running.clone(),
            derive(
                "read",
                None,
                &Value::Null,
                Some(&json!({ "startLine": 1, "endLine": 10, "totalLines": 10, "truncated": false })),
                false,
            ),
        );
        assert_eq!(ok.heading(), "read src/app.ts");
        assert_eq!(ok.summary.as_deref(), Some("1-10 of 10"));
        assert!(!ok.is_error);

        let failed = settle(
            running,
            derive(
                "read",
                None,
                &Value::Null,
                Some(&json!({ "path": "src/app.ts", "reason": "not_found", "message": "File not found: src/app.ts" })),
                true,
            ),
        );
        assert_eq!(failed.heading(), "read src/app.ts");
        assert!(failed.is_error);
        assert_eq!(failed.summary.as_deref(), Some("File not found: src/app.ts"));
    }

    #[test]
    fn collapses_a_run_of_three_or_more() {
        let tools = vec![
            call("read", "a.rs"),
            call("read", "b.rs"),
            call("read", "c.rs"),
            call("read", "d.rs"),
        ];
        let rows = group(&tools);
        assert_eq!(rows.len(), 1);
        match &rows[0] {
            ToolRow::Run { name, members, failed } => {
                assert_eq!(name, "read");
                assert_eq!(members.len(), 4);
                assert_eq!(*failed, 0);
                assert_eq!(run_targets(members), "a.rs, b.rs, c.rs, …");
            }
            other => panic!("expected a run, got {other:?}"),
        }
    }

    #[test]
    fn keeps_short_runs_and_different_tools_separate() {
        let tools = vec![call("read", "a.rs"), call("read", "b.rs"), call("bash", "c")];
        let rows = group(&tools);
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|row| matches!(row, ToolRow::Single(_))));
    }

    #[test]
    fn never_collapses_a_run_containing_a_diff() {
        let mut edited = call("edit", "src/a.ts");
        edited.patch = Some("--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-a\n+b\n".to_string());
        let tools = vec![call("edit", "b.ts"), edited, call("edit", "c.ts")];
        let rows = group(&tools);
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|row| matches!(row, ToolRow::Single(_))));
    }

    #[test]
    fn a_run_reports_its_failures() {
        let mut failed = call("bash", "npm test");
        failed.is_error = true;
        let tools = vec![call("bash", "npm test"), failed, call("bash", "npm test")];
        let rows = group(&tools);
        assert_eq!(rows.len(), 1);
        match &rows[0] {
            ToolRow::Run { failed, .. } => assert_eq!(*failed, 1),
            other => panic!("expected a run, got {other:?}"),
        }
    }

    #[test]
    fn run_targets_are_distinct_and_capped() {
        let tools = vec![
            call("read", "a.rs"),
            call("read", "a.rs"),
            call("read", "b.rs"),
            call("read", "c.rs"),
            call("read", "d.rs"),
        ];
        let rows = group(&tools);
        match &rows[0] {
            ToolRow::Run { members, .. } => assert_eq!(run_targets(members), "a.rs, b.rs, c.rs, …"),
            other => panic!("expected a run, got {other:?}"),
        }
    }

    #[test]
    fn grouping_an_empty_list_is_empty() {
        assert!(group(&[]).is_empty());
    }
}
