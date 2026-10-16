//! Turns one tool call's raw payload — the tool name, its `arguments`, and the
//! result `details` the harness publishes — into the short human view the
//! transcript shows.
//!
//! Everything here is pure and resolved once, when the event arrives, so the
//! renderer never re-parses JSON per frame.

use serde_json::Value;

use crate::diff;

/// Consecutive settled calls to one tool at or above this count collapse into one row.
pub const GROUP_MIN_RUN: usize = 3;

/// How many distinct targets a collapsed run lists before `…`.
const RUN_TITLES_MAX: usize = 3;

/// A path longer than this is shortened to its last two components.
const PATH_MAX_CHARS: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub target: Option<String>,
    pub label: String,
    pub summary: Option<String>,
    pub output: Option<String>,
    pub patch: Option<String>,
    pub status: ToolStatus,
}

impl ToolCall {
    pub fn start(
        call_id: String,
        name: String,
        label: Option<String>,
        arguments: &Value,
    ) -> Self {
        let target = target(&name, arguments);
        let label = label.unwrap_or_else(|| name.clone());
        Self {
            call_id,
            name,
            target,
            label,
            summary: None,
            output: None,
            patch: None,
            status: ToolStatus::Running,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn settled(
        call_id: String,
        name: Option<String>,
        arguments: &Value,
        output: Option<String>,
        details: Option<&Value>,
        is_error: bool,
    ) -> Self {
        let tool_name = name.unwrap_or_else(|| "tool".to_string());
        let mut call = Self::start(call_id, tool_name, None, arguments);
        call.apply_settlement(None, arguments, output, details, is_error);
        call
    }

    pub fn apply_settlement(
        &mut self,
        name: Option<String>,
        arguments: &Value,
        output: Option<String>,
        details: Option<&Value>,
        is_error: bool,
    ) {
        if let Some(name) = name {
            self.name = name;
        }
        if self.target.is_none() {
            self.target = target(&self.name, arguments);
        }
        let patch = string_field(details, "patch");
        let first_changed_line = details
            .and_then(|d| d.get("firstChangedLine"))
            .and_then(Value::as_u64);
        let call_path = arguments.get("path").and_then(Value::as_str);

        self.summary = match &patch {
            Some(patch) => Some(edit_summary(patch, call_path, first_changed_line)),
            None => summary(&self.name, details, is_error),
        };
        self.patch = patch;
        self.output = output;
        self.status = if is_error {
            ToolStatus::Failed
        } else {
            ToolStatus::Completed
        };
    }
}

/// One row of a turn's tool list.
#[derive(Debug, Clone)]
pub enum ToolRow<'a> {
    /// A call rendered on its own: heading, summary, plus a diff when it produced one.
    Single(&'a ToolCall),
    /// [`GROUP_MIN_RUN`] or more consecutive settled calls to the same non-diff tool.
    Run {
        name: String,
        members: Vec<&'a ToolCall>,
        failed: usize,
    },
}

/// Collapses runs of consecutive settled calls to the same tool, so a stretch of
/// `read`, `read`, `read` costs one line instead of twenty.
///
/// Running calls and calls with a diff are never collapsed.
pub fn group(tools: &[ToolCall]) -> Vec<ToolRow<'_>> {
    let mut rows = Vec::new();
    let mut index = 0;
    while index < tools.len() {
        let first = &tools[index];
        if first.status == ToolStatus::Running || first.patch.is_some() {
            rows.push(ToolRow::Single(first));
            index += 1;
            continue;
        }
        let name = first.name.as_str();
        let mut end = index + 1;
        while end < tools.len()
            && tools[end].name.as_str() == name
            && tools[end].status != ToolStatus::Running
            && tools[end].patch.is_none()
        {
            end += 1;
        }
        let run = &tools[index..end];
        if run.len() >= GROUP_MIN_RUN {
            rows.push(ToolRow::Run {
                name: name.to_string(),
                members: run.iter().collect(),
                failed: run
                    .iter()
                    .filter(|tool| tool.status == ToolStatus::Failed)
                    .count(),
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
pub fn run_targets(members: &[&ToolCall]) -> String {
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

/// What the call touched: `bash` → its command, `read`/`edit`/`write` → the path,
/// `search`/`grep`/`glob` → the query or pattern.
pub fn target(name: &str, arguments: &Value) -> Option<String> {
    let arg = |key: &str| arguments.get(key).and_then(Value::as_str);
    let derived = match name {
        "bash" => arg("command").map(collapse_whitespace),
        "read" | "edit" | "write" => arg("path").map(shorten_path),
        "search" => arg("query").map(|query| {
            if arg("mode") == Some("files") {
                format!("files: {}", collapse_whitespace(query))
            } else {
                collapse_whitespace(query)
            }
        }),
        _ => ["path", "pattern", "query", "url", "command"]
            .into_iter()
            .find_map(arg)
            .map(collapse_whitespace),
    };
    derived.filter(|value| !value.is_empty())
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

fn string_field(details: Option<&Value>, key: &str) -> Option<String> {
    details?.get(key)?.as_str().map(str::to_string)
}

fn number(details: &Value, key: &str) -> Option<u64> {
    details.get(key).and_then(Value::as_u64)
}

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

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

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
