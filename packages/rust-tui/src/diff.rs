//! Renders a unified diff (the `patch` field tools such as `edit` return in
//! their result `details`) into styled terminal lines.
//!
//! The renderer is deliberately tag-less: it only understands the standard
//! unified-diff grammar, so any tool that emits a patch can reuse it. It is pure
//! and returns `Line`s rather than touching a `Frame`, which keeps it testable.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::ui::theme::Theme;

/// How many diff lines are shown before the "… +N more lines" footer.
pub const DEFAULT_MAX_DIFF_LINES: usize = 12;

/// Added/removed counts for the whole patch, before any truncation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DiffSummary {
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    FileHeader,
    Hunk,
    Added,
    Removed,
    Context,
    NoNewline,
}

struct ParsedLine {
    kind: Kind,
    text: String,
    /// 1-based line number in the new file; `None` for removals and metadata.
    line_no: Option<usize>,
}

/// Parses the new-side start line out of a hunk header (`@@ -a,b +c,d @@`).
fn parse_new_start(header: &str) -> Option<usize> {
    let rest = &header[header.find('+')? + 1..];
    let end = rest.find(|c| c == ' ' || c == ',').unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn classify(line: &str) -> Kind {
    // Order matters: `---`/`+++` must be checked before the `-`/`+` markers.
    if line.starts_with("--- ") || line.starts_with("+++ ") {
        Kind::FileHeader
    } else if line.starts_with("@@") {
        Kind::Hunk
    } else if line.starts_with('+') {
        Kind::Added
    } else if line.starts_with('-') {
        Kind::Removed
    } else if line.starts_with('\\') {
        Kind::NoNewline
    } else {
        Kind::Context
    }
}

fn parse(patch: &str) -> Vec<ParsedLine> {
    let mut parsed = Vec::new();
    let mut new_line: Option<usize> = None;

    for raw in patch.lines() {
        let kind = classify(raw);
        let (line_no, text) = match kind {
            Kind::FileHeader | Kind::Hunk | Kind::NoNewline => (None, raw.to_string()),
            Kind::Added => {
                let current = new_line;
                new_line = new_line.map(|n| n + 1);
                (current, raw.get(1..).unwrap_or("").to_string())
            }
            Kind::Removed => (None, raw.get(1..).unwrap_or("").to_string()),
            Kind::Context => {
                let current = new_line;
                new_line = new_line.map(|n| n + 1);
                (current, raw.get(1..).unwrap_or("").to_string())
            }
        };
        if kind == Kind::Hunk {
            new_line = parse_new_start(raw);
        }
        parsed.push(ParsedLine { kind, text, line_no });
    }

    parsed
}

fn truncate(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(text) <= max_width {
        return text.to_string();
    }
    let mut out = String::new();
    let mut width = 0usize;
    for ch in text.chars() {
        let ch_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if width + ch_width + 1 > max_width {
            break;
        }
        out.push(ch);
        width += ch_width;
    }
    out.push('…');
    out
}

/// The new-file path from a patch's `+++` header, when present.
pub fn patch_path(patch: &str) -> Option<String> {
    patch
        .lines()
        .find_map(|line| line.strip_prefix("+++ "))
        .map(|path| path.trim().to_string())
}

/// Renders `patch` into at most `max_lines` styled lines (`0` means unlimited),
/// indented for a conversation pane. Returns the full added/removed summary.
pub fn render_diff(patch: &str, max_width: usize, max_lines: usize) -> (Vec<Line<'static>>, DiffSummary) {
    let parsed = parse(patch);

    let mut summary = DiffSummary::default();
    for line in &parsed {
        match line.kind {
            Kind::Added => summary.added += 1,
            Kind::Removed => summary.removed += 1,
            _ => {}
        }
    }

    let gutter_width = parsed
        .iter()
        .filter_map(|line| line.line_no)
        .max()
        .map(|n| n.to_string().len())
        .unwrap_or(0);
    // gutter + space + marker + space
    let prefix_width = gutter_width + 3;
    let content_width = max_width.saturating_sub(prefix_width);

    let limit = if max_lines == 0 {
        parsed.len()
    } else {
        max_lines.min(parsed.len())
    };

    let mut lines: Vec<Line<'static>> = Vec::new();

    for line in parsed.iter().take(limit) {
        match line.kind {
            Kind::Hunk | Kind::FileHeader => {
                let style = if line.kind == Kind::Hunk {
                    Style::default().fg(Theme::DIFF_HUNK).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Theme::DIFF_META).add_modifier(Modifier::BOLD)
                };
                lines.push(Line::from(vec![Span::styled(truncate(&line.text, max_width), style)]));
            }
            Kind::NoNewline => {
                lines.push(Line::from(vec![
                    Span::raw(" ".repeat(gutter_width + 1)),
                    Span::styled(
                        truncate(&line.text, max_width.saturating_sub(gutter_width + 1)),
                        Style::default().fg(Theme::DIFF_META).add_modifier(Modifier::ITALIC),
                    ),
                ]));
            }
            Kind::Added | Kind::Removed | Kind::Context => {
                let (marker, fg, bg, marker_color) = match line.kind {
                    Kind::Added => ("+", Theme::SUCCESS, Some(Theme::DIFF_ADD_BG), Theme::SUCCESS),
                    Kind::Removed => ("-", Theme::ERROR, Some(Theme::DIFF_DEL_BG), Theme::ERROR),
                    _ => (" ", Theme::TEXT_PRIMARY, None, Theme::TEXT_MUTED),
                };

                let mut spans: Vec<Span<'static>> = Vec::new();
                if gutter_width > 0 {
                    let number = line
                        .line_no
                        .map(|n| format!("{:>width$} ", n, width = gutter_width))
                        .unwrap_or_else(|| " ".repeat(gutter_width + 1));
                    spans.push(Span::styled(number, Style::default().fg(Theme::TEXT_MUTED)));
                }
                spans.push(Span::styled(marker, Style::default().fg(marker_color)));
                spans.push(Span::raw(" "));

                let shown = truncate(&line.text, content_width);
                let used = prefix_width + UnicodeWidthStr::width(shown.as_str());
                let content_style = match bg {
                    Some(background) => Style::default().fg(fg).bg(background),
                    None => Style::default().fg(fg),
                };
                spans.push(Span::styled(shown, content_style));
                if let Some(background) = bg {
                    if used < max_width {
                        spans.push(Span::styled(" ".repeat(max_width - used), Style::default().bg(background)));
                    }
                }
                lines.push(Line::from(spans));
            }
        }
    }

    let remaining = parsed.len().saturating_sub(limit);
    if remaining > 0 {
        lines.push(Line::from(vec![
            Span::raw(" ".repeat(gutter_width + 1)),
            Span::styled(format!("⋯ +{remaining} more lines"), Style::default().fg(Theme::DIFF_META)),
        ]));
    }

    (lines, summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,3 @@\n let a = 1;\n-let b = 2;\n+let b = 3;\n return a + b;\n";

    fn text_of(line: &Line) -> String {
        line.spans.iter().map(|span| span.content.as_ref()).collect()
    }

    fn joined(lines: &[Line]) -> String {
        lines.iter().map(text_of).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn counts_added_and_removed() {
        let (_, summary) = render_diff(PATCH, 80, DEFAULT_MAX_DIFF_LINES);
        assert_eq!(summary.added, 1);
        assert_eq!(summary.removed, 1);
    }

    #[test]
    fn extracts_path_from_patch() {
        assert_eq!(patch_path(PATCH).as_deref(), Some("src/a.ts"));
        assert_eq!(patch_path(""), None);
    }

    #[test]
    fn assigns_new_side_line_numbers() {
        let (lines, _) = render_diff(PATCH, 80, DEFAULT_MAX_DIFF_LINES);
        let text = joined(&lines);
        assert!(text.contains("1   let a = 1;"), "context line numbered from hunk start:\n{text}");
        assert!(text.contains("2 + let b = 3;"), "added line numbered on the new side:\n{text}");
        assert!(text.contains("3   return a + b;"), "numbering advances across lines:\n{text}");
    }

    #[test]
    fn classifies_hunk_and_file_headers() {
        let (lines, _) = render_diff(PATCH, 80, DEFAULT_MAX_DIFF_LINES);
        let text = joined(&lines);
        assert!(text.contains("--- src/a.ts"));
        assert!(text.contains("+++ src/a.ts"));
        assert!(text.contains("@@ -1,3 +1,3 @@"));
    }

    #[test]
    fn truncates_long_patches_with_footer() {
        let mut patch = String::from("--- a\n+++ a\n@@ -1,20 +1,20 @@\n");
        for i in 0..20 {
            patch.push_str(&format!("+line {i}\n"));
        }
        let (lines, summary) = render_diff(&patch, 80, 5);
        assert_eq!(summary.added, 20, "summary counts the whole patch, not the visible slice");
        assert_eq!(lines.len(), 6, "5 visible lines plus the truncation footer");
        // 23 parsed lines (2 file headers + hunk header + 20 additions) - 5 shown.
        assert!(text_of(&lines[5]).contains("+18 more lines"), "{}", text_of(&lines[5]));
    }

    #[test]
    fn renders_no_newline_marker() {
        let patch = "--- a\n+++ a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n";
        let (lines, _) = render_diff(patch, 80, DEFAULT_MAX_DIFF_LINES);
        assert!(joined(&lines).contains("No newline at end of file"));
    }

    #[test]
    fn truncates_lines_to_max_width() {
        let long = "x".repeat(200);
        let patch = format!("--- a\n+++ a\n@@ -1 +1 @@\n-{long}\n+{long}\n");
        let (lines, _) = render_diff(&patch, 40, DEFAULT_MAX_DIFF_LINES);
        for line in &lines {
            assert!(
                UnicodeWidthStr::width(text_of(line).as_str()) <= 40,
                "line exceeds width: {:?}",
                text_of(line)
            );
        }
    }

    #[test]
    fn malformed_hunk_header_does_not_panic() {
        let patch = "--- a\n+++ a\n@@ broken @@\n+x\n";
        let (lines, _) = render_diff(patch, 80, DEFAULT_MAX_DIFF_LINES);
        assert!(joined(&lines).contains('x'));
    }

    #[test]
    fn empty_patch_is_empty() {
        let (lines, summary) = render_diff("", 80, DEFAULT_MAX_DIFF_LINES);
        assert!(lines.is_empty());
        assert_eq!(summary, DiffSummary::default());
    }

    #[test]
    fn unlimited_max_lines_keeps_every_line() {
        let (lines, _) = render_diff(PATCH, 80, 0);
        assert!(lines.iter().all(|line| !text_of(line).contains("more lines")));
    }
}
