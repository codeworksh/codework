use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::markdown::inline::parse_inline;
use crate::markdown::table::{is_table_row, render_table};
use crate::ui::Theme;

pub fn wrap_text(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 || text.is_empty() {
        return vec![text.to_string()];
    }
    let mut lines = Vec::new();
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return vec![String::new()];
    }
    let mut current_line = String::new();
    let mut current_width = 0usize;

    for word in words {
        let w_len = UnicodeWidthStr::width(word);
        if current_line.is_empty() {
            current_line.push_str(word);
            current_width = w_len;
        } else if current_width + 1 + w_len <= max_width {
            current_line.push(' ');
            current_line.push_str(word);
            current_width += 1 + w_len;
        } else {
            lines.push(current_line);
            current_line = word.to_string();
            current_width = w_len;
        }
    }
    if !current_line.is_empty() {
        lines.push(current_line);
    }
    lines
}

pub fn render_markdown(text: &str, max_width: usize) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let raw_lines: Vec<&str> = text.lines().collect();
    let mut i = 0;

    let border_style = Style::default().fg(Theme::border());
    let code_bg = Theme::bg_surface();

    while i < raw_lines.len() {
        let line = raw_lines[i];
        let trimmed = line.trim();

        // 1. Code Fence
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

            // Top fence header
            let lang_tag = if !lang.is_empty() {
                format!("── [{}] ─", lang)
            } else {
                "──────".to_string()
            };
            let fence_top = format!("┌{}{}", lang_tag, "─".repeat(max_width.saturating_sub(lang_tag.len() + 3)));
            lines.push(Line::from(vec![Span::styled(fence_top, border_style)]));

            let max_code_w = max_width.saturating_sub(4).max(10);
            for c_line in code_lines {
                let display_code = if UnicodeWidthStr::width(c_line) > max_code_w {
                    let mut truncated = String::new();
                    let mut cur = 0;
                    for ch in c_line.chars() {
                        let ch_w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                        if cur + ch_w <= max_code_w.saturating_sub(1) {
                            truncated.push(ch);
                            cur += ch_w;
                        } else {
                            break;
                        }
                    }
                    truncated.push('…');
                    truncated
                } else {
                    c_line.to_string()
                };

                let mut spans = vec![
                    Span::styled("│ ", border_style),
                    Span::styled(
                        display_code.clone(),
                        Style::default().fg(Theme::success()).bg(code_bg),
                    ),
                ];
                let line_len = UnicodeWidthStr::width(display_code.as_str()) + 2;
                if line_len < max_width {
                    spans.push(Span::styled(" ".repeat(max_width - line_len), Style::default().bg(code_bg)));
                }
                spans.push(Span::styled(" │", border_style));
                lines.push(Line::from(spans));
            }

            // Bottom fence footer
            let fence_bot = format!("└{}┘", "─".repeat(max_width.saturating_sub(2)));
            lines.push(Line::from(vec![Span::styled(fence_bot, border_style)]));
            continue;
        }

        // 2. Table Block
        if is_table_row(trimmed) {
            let mut table_rows = Vec::new();
            while i < raw_lines.len() && is_table_row(raw_lines[i]) {
                table_rows.push(raw_lines[i].to_string());
                i += 1;
            }
            let rendered = render_table(&table_rows, max_width);
            lines.extend(rendered);
            continue;
        }

        // 3. Headings
        if trimmed.starts_with("# ") {
            let content = trimmed[2..].trim();
            lines.push(Line::from(vec![
                Span::styled("┃ ", Style::default().fg(Theme::primary()).add_modifier(Modifier::BOLD)),
                Span::styled(
                    content.to_string(),
                    Style::default().fg(Theme::text_primary()).add_modifier(Modifier::BOLD),
                ),
            ]));
            i += 1;
            continue;
        }

        if trimmed.starts_with("## ") {
            let content = trimmed[3..].trim();
            lines.push(Line::from(vec![
                Span::styled("┃ ", Style::default().fg(Theme::primary()).add_modifier(Modifier::BOLD)),
                Span::styled(
                    content.to_string(),
                    Style::default().fg(Theme::text_primary()).add_modifier(Modifier::BOLD),
                ),
            ]));
            i += 1;
            continue;
        }

        if trimmed.starts_with("### ") {
            let content = trimmed[4..].trim();
            lines.push(Line::from(vec![
                Span::styled("│ ", Style::default().fg(Theme::text_muted())),
                Span::styled(
                    content.to_string(),
                    Style::default().fg(Theme::text_secondary()).add_modifier(Modifier::BOLD),
                ),
            ]));
            i += 1;
            continue;
        }

        // 4. Blockquotes
        if trimmed.starts_with('>') {
            let content = trimmed.trim_start_matches('>').trim();
            let wrap_width = max_width.saturating_sub(3).max(10);
            let wrapped = wrap_text(content, wrap_width);
            for w_line in wrapped {
                let mut spans = vec![Span::styled(
                    "│ ",
                    Style::default().fg(Theme::text_muted()),
                )];
                spans.extend(parse_inline(&w_line));
                lines.push(Line::from(spans));
            }
            i += 1;
            continue;
        }

        // 5. Unordered List
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
            let indent = line.len() - line.trim_start().len();
            let content = &trimmed[2..];
            let wrap_width = max_width.saturating_sub(indent + 2).max(10);
            let wrapped = wrap_text(content, wrap_width);
            for (w_idx, w_line) in wrapped.iter().enumerate() {
                let mut spans = Vec::new();
                spans.push(Span::raw(" ".repeat(indent)));
                if w_idx == 0 {
                    spans.push(Span::styled("• ", Style::default().fg(Theme::primary())));
                } else {
                    spans.push(Span::raw("  "));
                }
                spans.extend(parse_inline(w_line));
                lines.push(Line::from(spans));
            }
            i += 1;
            continue;
        }

        // 6. Ordered List
        if let Some(dot_pos) = trimmed.find(". ") {
            let num_part = &trimmed[..dot_pos];
            if num_part.chars().all(|c| c.is_ascii_digit()) && !num_part.is_empty() {
                let indent = line.len() - line.trim_start().len();
                let prefix = format!("{}. ", num_part);
                let prefix_len = prefix.len();
                let content = &trimmed[dot_pos + 2..];
                let wrap_width = max_width.saturating_sub(indent + prefix_len).max(10);
                let wrapped = wrap_text(content, wrap_width);
                for (w_idx, w_line) in wrapped.iter().enumerate() {
                    let mut spans = Vec::new();
                    spans.push(Span::raw(" ".repeat(indent)));
                    if w_idx == 0 {
                        spans.push(Span::styled(prefix.clone(), Style::default().fg(Theme::primary())));
                    } else {
                        spans.push(Span::raw(" ".repeat(prefix_len)));
                    }
                    spans.extend(parse_inline(w_line));
                    lines.push(Line::from(spans));
                }
                i += 1;
                continue;
            }
        }

        // 7. Horizontal Rule
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            let hr = "─".repeat(max_width.min(60));
            lines.push(Line::from(vec![Span::styled(hr, border_style)]));
            i += 1;
            continue;
        }

        // 8. Empty line
        if trimmed.is_empty() {
            lines.push(Line::raw(""));
            i += 1;
            continue;
        }

        // 9. Normal paragraph (word wrapped)
        let wrapped = wrap_text(line, max_width);
        for w_line in wrapped {
            lines.push(Line::from(parse_inline(&w_line)));
        }
        i += 1;
    }

    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wrap_text() {
        let text = "CodeWork is an open-source coding agent harness for the terminal.";
        let wrapped = wrap_text(text, 25);
        assert!(wrapped.len() > 1);
        for line in &wrapped {
            assert!(unicode_width::UnicodeWidthStr::width(line.as_str()) <= 25);
        }
    }

    #[test]
    fn test_render_markdown_wrapping() {
        let text = "This is a long sentence that should definitely be wrapped to fit inside the terminal viewport width.";
        let lines = render_markdown(text, 30);
        assert!(lines.len() >= 3);
    }
}

