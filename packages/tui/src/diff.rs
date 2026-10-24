//! Renders a unified diff (the `patch` field tools such as `edit` return in
//! their result `details`) into styled terminal lines.
//!
//! Diff rendering:
//! - Wide viewports (`max_width >= SPLIT_MIN_WIDTH`) render side-by-side (`old │ new`) split
//!   diffs for file updates; narrower viewports (or pure file additions/deletions) render unified
//!   diffs.
//! - File headers (`---` / `+++`) and raw `@@ ... @@` lines are omitted in favour of line numbers
//!   on both old and new sides and a `⋮` separator between multiple hunks.
//! - Gutter line numbers carry a deeper tint (`diff_add_gutter_bg` / `diff_del_gutter_bg`) distinct
//!   from the full-width line background (`diff_add_bg` / `diff_del_bg`).

use ratatui::style::Style;
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthChar;

use crate::theme::Palette;
use crate::ui::text::{elide, width};

/// Default cap on rendered diff rows per tool call (`0` means unlimited).
pub const DEFAULT_MAX_DIFF_LINES: usize = 60;

/// Minimum width (in columns) at which update diffs switch from unified to side-by-side split view
/// (a 120-column threshold minus the 4-column transcript indent).
pub const SPLIT_MIN_WIDTH: usize = 116;

/// Added/removed counts for the whole patch, before any truncation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DiffSummary {
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Added,
    Removed,
    Context,
}

#[derive(Debug, Clone)]
struct DiffLine {
    kind: Kind,
    text: String,
    old_no: Option<usize>,
    new_no: Option<usize>,
}

#[derive(Debug, Clone, Default)]
struct Hunk {
    lines: Vec<DiffLine>,
}

/// Parses `(old_start, new_start)` out of a unified diff hunk header (`@@ -a,b +c,d @@`).
fn parse_hunk_starts(header: &str) -> (usize, usize) {
    let old_start = header
        .find('-')
        .and_then(|idx| {
            let rest = &header[idx + 1..];
            let end = rest.find([' ', ',']).unwrap_or(rest.len());
            rest[..end].parse::<usize>().ok()
        })
        .unwrap_or(1);
    let new_start = header
        .find('+')
        .and_then(|idx| {
            let rest = &header[idx + 1..];
            let end = rest.find([' ', ',']).unwrap_or(rest.len());
            rest[..end].parse::<usize>().ok()
        })
        .unwrap_or(1);
    (old_start, new_start)
}

fn parse_hunks(patch: &str) -> (Vec<Hunk>, DiffSummary) {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut summary = DiffSummary::default();
    let mut old_ln = 1usize;
    let mut new_ln = 1usize;

    for raw in patch.lines() {
        if raw.starts_with("--- ") || raw.starts_with("+++ ") || raw.starts_with('\\') {
            continue;
        }
        if raw.starts_with("@@") {
            let (o, n) = parse_hunk_starts(raw);
            old_ln = o;
            new_ln = n;
            hunks.push(Hunk::default());
            continue;
        }

        if hunks.is_empty() {
            hunks.push(Hunk::default());
        }
        let hunk = hunks.last_mut().expect("hunk exists");

        if let Some(rest) = raw.strip_prefix('+') {
            summary.added += 1;
            let current = new_ln;
            new_ln += 1;
            hunk.lines.push(DiffLine {
                kind: Kind::Added,
                text: expand_tabs(rest),
                old_no: None,
                new_no: Some(current),
            });
        } else if let Some(rest) = raw.strip_prefix('-') {
            summary.removed += 1;
            let current = old_ln;
            old_ln += 1;
            hunk.lines.push(DiffLine {
                kind: Kind::Removed,
                text: expand_tabs(rest),
                old_no: Some(current),
                new_no: None,
            });
        } else {
            let rest = raw.strip_prefix(' ').unwrap_or(raw);
            let cur_old = old_ln;
            let cur_new = new_ln;
            old_ln += 1;
            new_ln += 1;
            hunk.lines.push(DiffLine {
                kind: Kind::Context,
                text: expand_tabs(rest),
                old_no: Some(cur_old),
                new_no: Some(cur_new),
            });
        }
    }

    hunks.retain(|h| !h.lines.is_empty());
    (hunks, summary)
}

fn expand_tabs(text: &str) -> String {
    text.replace('\t', "    ")
}

/// Added/removed counts for the whole of `patch`, without building any styled lines.
pub fn counts(patch: &str) -> DiffSummary {
    parse_hunks(patch).1
}

/// The new-file path from a patch's `+++` header, when present.
pub fn patch_path(patch: &str) -> Option<String> {
    patch
        .lines()
        .find_map(|line| line.strip_prefix("+++ "))
        .map(|path| {
            let trimmed = path.trim();
            trimmed.strip_prefix("b/").unwrap_or(trimmed).to_string()
        })
}

/// Renders `patch` into styled lines using split view when `max_width >= SPLIT_MIN_WIDTH` (and the
/// patch modifies existing lines) or unified view otherwise.
pub fn render_diff(
    patch: &str,
    max_width: usize,
    max_lines: usize,
    palette: &Palette,
) -> (Vec<Line<'static>>, DiffSummary) {
    let (hunks, summary) = parse_hunks(patch);
    if hunks.is_empty() || max_width < 8 {
        return (Vec::new(), summary);
    }

    let has_old = summary.removed > 0
        || hunks
            .iter()
            .any(|h| h.lines.iter().any(|l| l.kind == Kind::Context));
    let use_split = max_width >= SPLIT_MIN_WIDTH && has_old && summary.added > 0;

    let mut all_lines = if use_split {
        render_split(&hunks, max_width, palette)
    } else {
        render_unified(&hunks, max_width, palette)
    };

    if max_lines > 0 && all_lines.len() > max_lines {
        let remaining = all_lines.len() - max_lines;
        all_lines.truncate(max_lines);
        all_lines.push(Line::from(vec![Span::styled(
            format!("  ⋯ +{remaining} more diff lines"),
            Style::default().fg(palette.text_muted),
        )]));
    }

    (all_lines, summary)
}

fn render_unified(hunks: &[Hunk], max_width: usize, palette: &Palette) -> Vec<Line<'static>> {
    let max_line_no = hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter_map(|l| l.old_no.max(l.new_no))
        .max()
        .unwrap_or(1);
    let gutter_width = max_line_no.to_string().len().max(2);
    // "[gutter] [sign] " -> gutter_width + 1 + 3 = gutter_width + 4
    let prefix_width = gutter_width + 4;
    let content_width = max_width.saturating_sub(prefix_width).max(1);

    let mut out: Vec<Line<'static>> = Vec::new();

    for (hunk_idx, hunk) in hunks.iter().enumerate() {
        if hunk_idx > 0 {
            out.push(Line::from(vec![Span::styled(
                format!("{:>width$}  ⋮", "", width = gutter_width),
                Style::default().fg(palette.text_muted),
            )]));
        }

        for line in &hunk.lines {
            let line_no = match line.kind {
                Kind::Removed => line.old_no,
                Kind::Added | Kind::Context => line.new_no,
            };
            let (sign, fg, line_bg, gutter_fg, gutter_bg) = match line.kind {
                Kind::Added => (
                    " + ",
                    palette.text,
                    Some(palette.diff_add_bg()),
                    palette.success(),
                    palette.diff_add_gutter_bg(),
                ),
                Kind::Removed => (
                    " - ",
                    palette.text_secondary,
                    Some(palette.diff_del_bg()),
                    palette.error(),
                    palette.diff_del_gutter_bg(),
                ),
                Kind::Context => (
                    "   ",
                    palette.text_secondary,
                    None,
                    palette.text_muted,
                    palette.surface,
                ),
            };

            let chunks = wrap_chars(&line.text, content_width);
            for (chunk_idx, chunk) in chunks.into_iter().enumerate() {
                let gutter_text = if chunk_idx == 0 {
                    line_no
                        .map(|n| format!("{n:>gutter_width$} "))
                        .unwrap_or_else(|| format!("{:>gutter_width$} ", ""))
                } else {
                    format!("{:>gutter_width$} ", "")
                };
                let sign_text = if chunk_idx == 0 { sign } else { "   " };

                let mut spans = vec![
                    Span::styled(gutter_text, Style::default().fg(gutter_fg).bg(gutter_bg)),
                    Span::styled(
                        sign_text,
                        match line_bg {
                            Some(bg) => Style::default().fg(gutter_fg).bg(bg),
                            None => Style::default().fg(gutter_fg),
                        },
                    ),
                ];

                let chunk_w = width(&chunk);
                let content_style = match line_bg {
                    Some(bg) => Style::default().fg(fg).bg(bg),
                    None => Style::default().fg(fg),
                };
                spans.push(Span::styled(chunk, content_style));

                if let Some(bg) = line_bg {
                    let used = prefix_width + chunk_w;
                    if used < max_width {
                        spans.push(Span::styled(
                            " ".repeat(max_width - used),
                            Style::default().bg(bg),
                        ));
                    }
                }

                out.push(Line::from(spans));
            }
        }
    }

    out
}

fn render_split(hunks: &[Hunk], max_width: usize, palette: &Palette) -> Vec<Line<'static>> {
    let max_line_no = hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter_map(|l| l.old_no.max(l.new_no))
        .max()
        .unwrap_or(1);
    let gutter_width = max_line_no.to_string().len().max(2);

    let left_width = (max_width.saturating_sub(1)) / 2;
    let right_width = max_width.saturating_sub(1 + left_width);

    let mut out: Vec<Line<'static>> = Vec::new();

    for (hunk_idx, hunk) in hunks.iter().enumerate() {
        if hunk_idx > 0 {
            let left_sep = format!(
                "{:<width$}",
                format!("{:>gw$}  ⋮", "", gw = gutter_width),
                width = left_width
            );
            let right_sep = format!(
                "{:<width$}",
                format!("{:>gw$}  ⋮", "", gw = gutter_width),
                width = right_width
            );
            out.push(Line::from(vec![
                Span::styled(left_sep, Style::default().fg(palette.text_muted)),
                Span::styled("│", Style::default().fg(palette.border_subtle)),
                Span::styled(right_sep, Style::default().fg(palette.text_muted)),
            ]));
        }

        let mut i = 0;
        let lines = &hunk.lines;
        while i < lines.len() {
            if lines[i].kind == Kind::Context {
                let mut row_spans =
                    format_split_cell(Some(&lines[i]), true, left_width, gutter_width, palette);
                row_spans.push(Span::styled(
                    "│",
                    Style::default().fg(palette.border_subtle),
                ));
                row_spans.extend(format_split_cell(
                    Some(&lines[i]),
                    false,
                    right_width,
                    gutter_width,
                    palette,
                ));
                out.push(Line::from(row_spans));
                i += 1;
                continue;
            }

            let mut removed = Vec::new();
            let mut added = Vec::new();
            while i < lines.len() && lines[i].kind != Kind::Context {
                match lines[i].kind {
                    Kind::Removed => removed.push(&lines[i]),
                    Kind::Added => added.push(&lines[i]),
                    Kind::Context => unreachable!(),
                }
                i += 1;
            }

            let rows = removed.len().max(added.len());
            for r in 0..rows {
                let mut row_spans = format_split_cell(
                    removed.get(r).copied(),
                    true,
                    left_width,
                    gutter_width,
                    palette,
                );
                row_spans.push(Span::styled(
                    "│",
                    Style::default().fg(palette.border_subtle),
                ));
                row_spans.extend(format_split_cell(
                    added.get(r).copied(),
                    false,
                    right_width,
                    gutter_width,
                    palette,
                ));
                out.push(Line::from(row_spans));
            }
        }
    }

    out
}

fn format_split_cell(
    line: Option<&DiffLine>,
    is_left: bool,
    col_width: usize,
    gutter_width: usize,
    palette: &Palette,
) -> Vec<Span<'static>> {
    let Some(line) = line else {
        return vec![Span::styled(
            " ".repeat(col_width),
            Style::default().bg(palette.surface),
        )];
    };

    let line_no = if is_left { line.old_no } else { line.new_no };
    let (sign, fg, line_bg, gutter_fg, gutter_bg) = match line.kind {
        Kind::Added => (
            " + ",
            palette.text,
            Some(palette.diff_add_bg()),
            palette.success(),
            palette.diff_add_gutter_bg(),
        ),
        Kind::Removed => (
            " - ",
            palette.text_secondary,
            Some(palette.diff_del_bg()),
            palette.error(),
            palette.diff_del_gutter_bg(),
        ),
        Kind::Context => (
            "   ",
            palette.text_secondary,
            None,
            palette.text_muted,
            palette.surface,
        ),
    };

    let prefix_w = gutter_width + 4;
    let content_w = col_width.saturating_sub(prefix_w);
    let gutter_str = line_no
        .map(|n| format!("{n:>gutter_width$} "))
        .unwrap_or_else(|| format!("{:>gutter_width$} ", ""));
    let shown = elide(&line.text, content_w);
    let pad = content_w.saturating_sub(width(&shown));

    let content_style = match line_bg {
        Some(bg) => Style::default().fg(fg).bg(bg),
        None => Style::default().fg(fg),
    };
    let sign_style = match line_bg {
        Some(bg) => Style::default().fg(gutter_fg).bg(bg),
        None => Style::default().fg(gutter_fg),
    };

    vec![
        Span::styled(gutter_str, Style::default().fg(gutter_fg).bg(gutter_bg)),
        Span::styled(sign, sign_style),
        Span::styled(format!("{shown}{}", " ".repeat(pad)), content_style),
    ]
}

fn wrap_chars(text: &str, max_cols: usize) -> Vec<String> {
    if text.is_empty() || max_cols == 0 {
        return vec![String::new()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_w = 0usize;

    for ch in text.chars() {
        let ch_w = ch.width().unwrap_or(0);
        if current_w + ch_w > max_cols && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            current_w = 0;
        }
        current.push(ch);
        current_w += ch_w;
    }
    if !current.is_empty() || chunks.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::default_palette;

    const PATCH: &str = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n let a = 1;\n-let b = 2;\n+let b = 3;\n return a + b;\n";

    fn text_of(line: &Line) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    fn joined(lines: &[Line]) -> String {
        lines.iter().map(text_of).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn counts_added_and_removed() {
        let summary = counts(PATCH);
        assert_eq!(summary.added, 1);
        assert_eq!(summary.removed, 1);
    }

    #[test]
    fn strips_b_prefix_from_patch_path() {
        assert_eq!(patch_path(PATCH).as_deref(), Some("src/a.ts"));
    }

    #[test]
    fn unified_view_shows_both_old_and_new_line_numbers_and_omits_raw_headers() {
        let (lines, _) = render_diff(PATCH, 80, DEFAULT_MAX_DIFF_LINES, default_palette());
        let text = joined(&lines);
        assert!(!text.contains("---"), "file headers omitted:\n{text}");
        assert!(!text.contains("@@"), "raw hunk header omitted:\n{text}");
        assert!(
            text.contains(" 2  - let b = 2;"),
            "removed line has old line number:\n{text}"
        );
        assert!(
            text.contains(" 2  + let b = 3;"),
            "added line has new line number:\n{text}"
        );
    }

    #[test]
    fn multi_hunk_diff_renders_vertical_ellipsis_between_hunks() {
        let multi = "--- a/f.rs\n+++ b/f.rs\n@@ -1,2 +1,2 @@\n-old1\n+new1\n@@ -10,2 +10,2 @@\n-old10\n+new10\n";
        let (lines, _) = render_diff(multi, 80, DEFAULT_MAX_DIFF_LINES, default_palette());
        let text = joined(&lines);
        assert!(
            text.contains('⋮'),
            "expected ⋮ separator between hunks:\n{text}"
        );
    }

    #[test]
    fn wide_viewport_uses_side_by_side_split_view() {
        let (lines, _) = render_diff(PATCH, 130, DEFAULT_MAX_DIFF_LINES, default_palette());
        let text = joined(&lines);
        assert!(
            text.contains('│'),
            "expected split divider │ on wide viewport:\n{text}"
        );
        // In split view, `- let b = 2;` and `+ let b = 3;` sit on the same row!
        assert_eq!(
            lines.len(),
            3,
            "context + paired replacement + context = 3 rows:\n{text}"
        );
    }
}
