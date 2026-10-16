//! Pure markdown renderer for assistant responses in the session transcript.
//!
//! Renders fenced code blocks, tables, headings, blockquotes, bulleted and numbered lists,
//! horizontal rules, and inline code/bold/italic/link spans using the active `Palette`.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthChar;

use super::text::{elide, width, wrap};
use crate::theme::Palette;

pub fn render(text: &str, max_width: usize, palette: &Palette) -> Vec<Line<'static>> {
    if max_width == 0 {
        return Vec::new();
    }

    let mut lines: Vec<Line<'static>> = Vec::new();
    let raw_lines: Vec<&str> = text.lines().collect();
    let mut i = 0;

    let border_style = Style::default().fg(palette.border_strong);
    let code_bg = palette.surface;

    while i < raw_lines.len() {
        let line = raw_lines[i];
        let trimmed = line.trim();

        // 1. Fenced code block
        if trimmed.starts_with("```") {
            let lang = trimmed.trim_start_matches('`').trim();
            i += 1;
            let mut code_lines = Vec::new();
            while i < raw_lines.len() {
                if raw_lines[i].trim().starts_with("```") {
                    i += 1;
                    break;
                }
                code_lines.push(raw_lines[i]);
                i += 1;
            }

            let box_width = max_width.max(12);
            let lang_tag = if !lang.is_empty() {
                format!("── [{lang}] ─")
            } else {
                "──────".to_string()
            };
            let top_rule = "─".repeat(box_width.saturating_sub(width(&lang_tag) + 2));
            lines.push(Line::from(vec![Span::styled(
                format!("┌{lang_tag}{top_rule}┐"),
                border_style,
            )]));

            let max_code_w = box_width.saturating_sub(4).max(4);
            for c_line in code_lines {
                let expanded = c_line.replace('\t', "    ");
                let display_code = elide(&expanded, max_code_w);
                let code_w = width(&display_code);
                let pad = max_code_w.saturating_sub(code_w);

                lines.push(Line::from(vec![
                    Span::styled("│ ", border_style.bg(code_bg)),
                    Span::styled(
                        display_code,
                        Style::default().fg(palette.text).bg(code_bg),
                    ),
                    Span::styled(" ".repeat(pad), Style::default().bg(code_bg)),
                    Span::styled(" │", border_style.bg(code_bg)),
                ]));
            }

            let bot_rule = "─".repeat(box_width.saturating_sub(2));
            lines.push(Line::from(vec![Span::styled(
                format!("└{bot_rule}┘"),
                border_style,
            )]));
            continue;
        }

        // 2. Table block
        if is_table_row(trimmed) {
            let mut table_rows = Vec::new();
            while i < raw_lines.len() && is_table_row(raw_lines[i]) {
                table_rows.push(raw_lines[i]);
                i += 1;
            }
            lines.extend(render_table(&table_rows, max_width, palette));
            continue;
        }

        // 3. Headings
        if let Some(content) = trimmed
            .strip_prefix("# ")
            .or_else(|| trimmed.strip_prefix("## "))
        {
            lines.push(Line::from(vec![
                Span::styled(
                    "┃ ",
                    Style::default()
                        .fg(palette.brand)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    content.trim().to_string(),
                    Style::default()
                        .fg(palette.text)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            i += 1;
            continue;
        }

        if let Some(content) = trimmed
            .strip_prefix("### ")
            .or_else(|| trimmed.strip_prefix("#### "))
        {
            lines.push(Line::from(vec![
                Span::styled("│ ", Style::default().fg(palette.text_muted)),
                Span::styled(
                    content.trim().to_string(),
                    Style::default()
                        .fg(palette.text_secondary)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            i += 1;
            continue;
        }

        // 4. Blockquotes
        if trimmed.starts_with('>') {
            let content = trimmed.trim_start_matches('>').trim();
            let wrap_width = max_width.saturating_sub(2).max(8);
            for w_line in wrap(content, wrap_width) {
                let mut spans = vec![Span::styled("│ ", Style::default().fg(palette.text_muted))];
                spans.extend(parse_inline(&w_line, palette));
                lines.push(Line::from(spans));
            }
            i += 1;
            continue;
        }

        // 5. Unordered list
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
            let indent = (line.len() - line.trim_start().len()).min(12);
            let content = &trimmed[2..];
            let wrap_width = max_width.saturating_sub(indent + 2).max(8);
            for (w_idx, w_line) in wrap(content, wrap_width).into_iter().enumerate() {
                let mut spans = vec![Span::raw(" ".repeat(indent))];
                if w_idx == 0 {
                    spans.push(Span::styled("• ", Style::default().fg(palette.brand)));
                } else {
                    spans.push(Span::raw("  "));
                }
                spans.extend(parse_inline(&w_line, palette));
                lines.push(Line::from(spans));
            }
            i += 1;
            continue;
        }

        // 6. Ordered list
        if let Some(dot_pos) = trimmed.find(". ") {
            let num_part = &trimmed[..dot_pos];
            if !num_part.is_empty() && num_part.chars().all(|c| c.is_ascii_digit()) {
                let indent = (line.len() - line.trim_start().len()).min(12);
                let prefix = format!("{num_part}. ");
                let prefix_len = prefix.len();
                let content = &trimmed[dot_pos + 2..];
                let wrap_width = max_width.saturating_sub(indent + prefix_len).max(8);
                for (w_idx, w_line) in wrap(content, wrap_width).into_iter().enumerate() {
                    let mut spans = vec![Span::raw(" ".repeat(indent))];
                    if w_idx == 0 {
                        spans.push(Span::styled(
                            prefix.clone(),
                            Style::default().fg(palette.brand),
                        ));
                    } else {
                        spans.push(Span::raw(" ".repeat(prefix_len)));
                    }
                    spans.extend(parse_inline(&w_line, palette));
                    lines.push(Line::from(spans));
                }
                i += 1;
                continue;
            }
        }

        // 7. Horizontal rule
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            let hr = "─".repeat(max_width.min(60));
            lines.push(Line::from(vec![Span::styled(
                hr,
                Style::default().fg(palette.border_subtle),
            )]));
            i += 1;
            continue;
        }

        // 8. Empty line
        if trimmed.is_empty() {
            lines.push(Line::default());
            i += 1;
            continue;
        }

        // 9. Normal paragraph
        for w_line in wrap(line, max_width) {
            lines.push(Line::from(parse_inline(&w_line, palette)));
        }
        i += 1;
    }

    lines
}

pub fn parse_inline(text: &str, palette: &Palette) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut chars = text.chars().peekable();
    let mut buffer = String::new();
    let base_style = Style::default().fg(palette.text);

    while let Some(&ch) = chars.peek() {
        if ch == '`' {
            if !buffer.is_empty() {
                spans.push(Span::styled(std::mem::take(&mut buffer), base_style));
            }
            chars.next();
            let mut code = String::new();
            for c in chars.by_ref() {
                if c == '`' {
                    break;
                }
                code.push(c);
            }
            spans.push(Span::styled(
                code,
                Style::default().fg(palette.brand).bg(palette.surface_2),
            ));
        } else if ch == '*' {
            chars.next();
            if chars.peek() == Some(&'*') {
                chars.next();
                if !buffer.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut buffer), base_style));
                }
                let mut bold_text = String::new();
                while let Some(c) = chars.next() {
                    if c == '*' && chars.peek() == Some(&'*') {
                        chars.next();
                        break;
                    }
                    bold_text.push(c);
                }
                spans.push(Span::styled(
                    bold_text,
                    Style::default()
                        .fg(palette.field_crest)
                        .add_modifier(Modifier::BOLD),
                ));
            } else {
                if !buffer.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut buffer), base_style));
                }
                let mut italic_text = String::new();
                for c in chars.by_ref() {
                    if c == '*' {
                        break;
                    }
                    italic_text.push(c);
                }
                spans.push(Span::styled(
                    italic_text,
                    Style::default()
                        .fg(palette.text_secondary)
                        .add_modifier(Modifier::ITALIC),
                ));
            }
        } else if ch == '[' {
            if !buffer.is_empty() {
                spans.push(Span::styled(std::mem::take(&mut buffer), base_style));
            }
            chars.next();
            let mut link_text = String::new();
            for c in chars.by_ref() {
                if c == ']' {
                    break;
                }
                link_text.push(c);
            }
            if chars.peek() == Some(&'(') {
                chars.next();
                for c in chars.by_ref() {
                    if c == ')' {
                        break;
                    }
                }
                spans.push(Span::styled(
                    link_text,
                    Style::default()
                        .fg(palette.brand)
                        .add_modifier(Modifier::UNDERLINED),
                ));
            } else {
                buffer.push('[');
                buffer.push_str(&link_text);
                buffer.push(']');
            }
        } else {
            buffer.push(ch);
            chars.next();
        }
    }

    if !buffer.is_empty() {
        spans.push(Span::styled(buffer, base_style));
    }

    spans
}

fn is_table_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|') || (trimmed.contains('|') && trimmed.ends_with('|'))
}

fn is_delimiter_row(line: &str) -> bool {
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
    if let Some(rest) = trimmed.strip_prefix('|') {
        trimmed = rest;
    }
    if let Some(rest) = trimmed.strip_suffix('|') {
        trimmed = rest;
    }
    trimmed.split('|').map(|c| c.trim().to_string()).collect()
}

fn spans_visual_width(spans: &[Span]) -> usize {
    spans.iter().map(|s| width(s.content.as_ref())).sum()
}

fn truncate_spans(spans: Vec<Span<'static>>, target_w: usize) -> Vec<Span<'static>> {
    if target_w == 0 {
        return Vec::new();
    }
    let max_avail = target_w.saturating_sub(1);
    let mut result = Vec::new();
    let mut current_w = 0;

    for span in spans {
        let span_w = width(span.content.as_ref());
        if current_w + span_w <= max_avail {
            current_w += span_w;
            result.push(span);
        } else {
            let mut partial = String::new();
            for ch in span.content.chars() {
                let ch_w = ch.width().unwrap_or(0);
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

fn render_table(rows: &[&str], max_width: usize, palette: &Palette) -> Vec<Line<'static>> {
    if rows.is_empty() {
        return Vec::new();
    }

    let parsed_rows: Vec<Vec<String>> = rows.iter().map(|r| parse_cells(r)).collect();
    let col_count = parsed_rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if col_count == 0 {
        return Vec::new();
    }

    let mut col_widths = vec![4usize; col_count];
    for row in &parsed_rows {
        for (i, cell) in row.iter().enumerate() {
            if i < col_count {
                let parsed = parse_inline(cell, palette);
                let w = spans_visual_width(&parsed);
                if w > col_widths[i] {
                    col_widths[i] = w;
                }
            }
        }
    }

    let border_overhead = col_count * 3 + 1;
    let avail_for_cells = max_width.saturating_sub(border_overhead).max(col_count * 6);
    let total_cell_w: usize = col_widths.iter().sum();

    if total_cell_w > avail_for_cells {
        col_widths = col_widths
            .iter()
            .map(|&w| (w * avail_for_cells / total_cell_w).max(6))
            .collect();
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

    let border_style = Style::default().fg(palette.border_subtle);
    let header_style = Style::default()
        .fg(palette.brand)
        .add_modifier(Modifier::BOLD);

    let mut lines = Vec::new();

    let mut top_border = String::from("┌");
    for (i, w) in col_widths.iter().enumerate() {
        top_border.push_str(&"─".repeat(*w + 2));
        top_border.push(if i + 1 < col_count { '┬' } else { '┐' });
    }
    lines.push(Line::from(vec![Span::styled(top_border, border_style)]));

    let mut has_header = false;
    for (row_idx, row) in parsed_rows.iter().enumerate() {
        if row_idx == 1 && rows.get(1).is_some_and(|s| is_delimiter_row(s)) {
            let mut mid_border = String::from("├");
            for (i, w) in col_widths.iter().enumerate() {
                mid_border.push_str(&"─".repeat(*w + 2));
                mid_border.push(if i + 1 < col_count { '┼' } else { '┤' });
            }
            lines.push(Line::from(vec![Span::styled(mid_border, border_style)]));
            has_header = true;
            continue;
        }

        let mut row_spans = vec![Span::styled("│", border_style)];
        for (col_idx, &w) in col_widths.iter().enumerate() {
            let cell = row.get(col_idx).map(|s| s.as_str()).unwrap_or("");
            let is_header_row = row_idx == 0 && !has_header;

            let cell_spans = if is_header_row {
                vec![Span::styled(cell.to_string(), header_style)]
            } else {
                parse_inline(cell, palette)
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

    let mut bottom_border = String::from("└");
    for (i, w) in col_widths.iter().enumerate() {
        bottom_border.push_str(&"─".repeat(*w + 2));
        bottom_border.push(if i + 1 < col_count { '┴' } else { '┘' });
    }
    lines.push(Line::from(vec![Span::styled(bottom_border, border_style)]));

    lines
}
