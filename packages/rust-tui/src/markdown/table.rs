use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::markdown::inline::parse_inline;
use crate::ui::Theme;

pub fn is_table_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|') || (trimmed.contains('|') && trimmed.ends_with('|'))
}

pub fn is_delimiter_row(line: &str) -> bool {
    let trimmed = line.trim();
    if !is_table_row(trimmed) {
        return false;
    }
    let cells = parse_cells(trimmed);
    !cells.is_empty()
        && cells.iter().all(|c| {
            let s = c.trim();
            !s.is_empty() && s.chars().all(|ch| ch == '-' || ch == ':' || ch == ' ')
        })
}

fn parse_cells(line: &str) -> Vec<String> {
    let mut trimmed = line.trim();
    if trimmed.starts_with('|') {
        trimmed = &trimmed[1..];
    }
    if trimmed.ends_with('|') {
        trimmed = &trimmed[..trimmed.len().saturating_sub(1)];
    }
    trimmed.split('|').map(|c| c.trim().to_string()).collect()
}

fn spans_visual_width(spans: &[Span]) -> usize {
    spans.iter().map(|s| UnicodeWidthStr::width(s.content.as_ref())).sum()
}

fn truncate_spans(spans: Vec<Span<'static>>, target_w: usize) -> Vec<Span<'static>> {
    if target_w == 0 {
        return Vec::new();
    }
    let max_avail = target_w.saturating_sub(1); // leave 1 col for '…'
    let mut result = Vec::new();
    let mut current_w = 0;

    for span in spans {
        let span_w = UnicodeWidthStr::width(span.content.as_ref());
        if current_w + span_w <= max_avail {
            current_w += span_w;
            result.push(span);
        } else {
            let mut partial = String::new();
            for ch in span.content.chars() {
                let ch_w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                if current_w + ch_w <= max_avail {
                    partial.push(ch);
                    current_w += ch_w;
                } else {
                    break;
                }
            }
            if !partial.is_empty() {
                result.push(Span::styled(partial, span.style));
            }
            result.push(Span::styled("…", span.style));
            return result;
        }
    }
    result.push(Span::raw("…"));
    result
}

pub fn render_table(rows: &[String], max_width: usize) -> Vec<Line<'static>> {
    if rows.is_empty() {
        return Vec::new();
    }

    let parsed_rows: Vec<Vec<String>> = rows.iter().map(|r| parse_cells(r)).collect();
    if parsed_rows.is_empty() {
        return Vec::new();
    }

    let col_count = parsed_rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if col_count == 0 {
        return Vec::new();
    }

    // Measure raw max width of each column based on visual text length
    let mut col_widths = vec![4usize; col_count];
    for row in &parsed_rows {
        for (i, cell) in row.iter().enumerate() {
            if i < col_count {
                let parsed = parse_inline(cell);
                let w = spans_visual_width(&parsed);
                if w > col_widths[i] {
                    col_widths[i] = w;
                }
            }
        }
    }

    // Overhead: Each column is " cell ", with border on each side: col_count * 3 + 1
    // E.g. for 2 columns: "│ col1 │ col2 │" has 2 * 3 + 1 = 7 border/padding chars.
    let border_overhead = col_count * 3 + 1;
    let avail_for_cells = max_width.saturating_sub(border_overhead).max(col_count * 6);
    let total_cell_w: usize = col_widths.iter().sum();

    if total_cell_w > avail_for_cells {
        // Proportionally scale columns to fit within avail_for_cells
        let mut new_widths = Vec::new();
        for &w in &col_widths {
            let scaled = (w * avail_for_cells / total_cell_w).max(6);
            new_widths.push(scaled);
        }
        col_widths = new_widths;
        // Fine-tune if sum exceeds avail_for_cells
        while col_widths.iter().sum::<usize>() > avail_for_cells {
            if let Some(max_col) = col_widths.iter_mut().max() {
                if *max_col > 6 {
                    *max_col -= 1;
                } else {
                    break;
                }
            }
        }
    }

    let border_style = Style::default().fg(Theme::BORDER);
    let header_style = Style::default()
        .fg(Theme::PRIMARY)
        .add_modifier(Modifier::BOLD);

    let mut lines = Vec::new();

    // Top border: ┌───┬───┐
    let mut top_border = String::from("┌");
    for (i, w) in col_widths.iter().enumerate() {
        top_border.push_str(&"─".repeat(*w + 2));
        if i + 1 < col_count {
            top_border.push('┬');
        } else {
            top_border.push('┐');
        }
    }
    lines.push(Line::from(vec![Span::styled(top_border, border_style)]));

    let mut has_header = false;
    for (row_idx, row) in parsed_rows.iter().enumerate() {
        // Skip delimiter row
        if row_idx == 1 && rows.get(1).map(|s| is_delimiter_row(s)).unwrap_or(false) {
            // Render middle divider: ├───┼───┤
            let mut mid_border = String::from("├");
            for (i, w) in col_widths.iter().enumerate() {
                mid_border.push_str(&"─".repeat(*w + 2));
                if i + 1 < col_count {
                    mid_border.push('┼');
                } else {
                    mid_border.push('┤');
                }
            }
            lines.push(Line::from(vec![Span::styled(mid_border, border_style)]));
            has_header = true;
            continue;
        }

        let mut row_spans = Vec::new();
        row_spans.push(Span::styled("│", border_style));

        for (col_idx, &w) in col_widths.iter().enumerate() {
            let cell = row.get(col_idx).map(|s| s.as_str()).unwrap_or("");
            let is_header_row = row_idx == 0 && !has_header;

            let cell_spans = if is_header_row {
                vec![Span::styled(cell.to_string(), header_style)]
            } else {
                parse_inline(cell)
            };

            let visual_w = spans_visual_width(&cell_spans);
            let final_spans = if visual_w > w {
                truncate_spans(cell_spans, w)
            } else {
                cell_spans
            };

            let final_w = spans_visual_width(&final_spans);
            let pad = w.saturating_sub(final_w);

            row_spans.push(Span::raw(" "));
            row_spans.extend(final_spans);
            row_spans.push(Span::raw(" ".repeat(pad + 1)));
            row_spans.push(Span::styled("│", border_style));
        }

        lines.push(Line::from(row_spans));
    }

    // Bottom border: └───┴───┘
    let mut bottom_border = String::from("└");
    for (i, w) in col_widths.iter().enumerate() {
        bottom_border.push_str(&"─".repeat(*w + 2));
        if i + 1 < col_count {
            bottom_border.push('┴');
        } else {
            bottom_border.push('┘');
        }
    }
    lines.push(Line::from(vec![Span::styled(bottom_border, border_style)]));

    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_table_alignment() {
        let rows = vec![
            "| Package | Role |".to_string(),
            "|---|---|".to_string(),
            "| `@codeworksh/cli` (packages/codework) | The user-facing command-line tool (codework). |".to_string(),
            "| `@codeworksh/aikit` (packages/aikit) | Unified multi-provider LLM client SDK. |".to_string(),
        ];
        let lines = render_table(&rows, 60);
        assert!(!lines.is_empty());
        let expected_w = spans_visual_width(&lines[0].spans);
        for line in &lines {
            let line_w = spans_visual_width(&line.spans);
            assert_eq!(line_w, expected_w, "All table lines must have identical visual width!");
        }
    }
}

