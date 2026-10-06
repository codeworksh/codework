use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use unicode_width::UnicodeWidthChar;

use crate::ui::theme::Theme;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputVisualLine {
    pub text: String,
    pub start_char_idx: usize,
    pub char_count: usize,
    pub cursor_col: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedInput {
    pub lines: Vec<InputVisualLine>,
    pub cursor_line: usize,
    pub cursor_col: usize,
}

pub fn wrap_input_with_cursor(input: &str, cursor: usize, max_width: usize) -> WrappedInput {
    let max_width = max_width.max(10);
    let total_chars = input.chars().count();
    let cursor = cursor.min(total_chars);

    if input.is_empty() {
        return WrappedInput {
            lines: vec![InputVisualLine {
                text: String::new(),
                start_char_idx: 0,
                char_count: 0,
                cursor_col: Some(0),
            }],
            cursor_line: 0,
            cursor_col: 0,
        };
    }

    let chars_with_idx: Vec<(char, usize)> = input.chars().enumerate().map(|(i, c)| (c, i)).collect();

    // 1. Split into logical lines by newline '\n'
    let mut raw_lines: Vec<(Vec<(char, usize)>, bool)> = Vec::new();
    let mut cur_line_chars: Vec<(char, usize)> = Vec::new();

    for (c, idx) in chars_with_idx {
        if c == '\n' {
            raw_lines.push((std::mem::take(&mut cur_line_chars), true));
        } else {
            cur_line_chars.push((c, idx));
        }
    }
    raw_lines.push((cur_line_chars, false));

    // 2. Wrap each logical line into visual lines of visual width <= max_width
    struct RawVisLine {
        chars: Vec<(char, usize)>,
        start_char_idx: usize,
        ended_with_newline: bool,
    }

    let mut vis_lines: Vec<RawVisLine> = Vec::new();
    let mut current_offset = 0usize;

    for (line_chars, ended_with_newline) in raw_lines {
        if line_chars.is_empty() {
            vis_lines.push(RawVisLine {
                chars: Vec::new(),
                start_char_idx: current_offset,
                ended_with_newline,
            });
            if ended_with_newline {
                current_offset += 1;
            }
            continue;
        }

        // Tokenize line into alternating word and whitespace tokens
        let mut tokens: Vec<Vec<(char, usize)>> = Vec::new();
        let mut cur_token: Vec<(char, usize)> = Vec::new();
        let mut in_ws = false;

        for (c, idx) in line_chars {
            let is_ws = c == ' ' || c == '\t';
            if cur_token.is_empty() {
                in_ws = is_ws;
                cur_token.push((c, idx));
            } else if in_ws == is_ws {
                cur_token.push((c, idx));
            } else {
                tokens.push(std::mem::take(&mut cur_token));
                in_ws = is_ws;
                cur_token.push((c, idx));
            }
        }
        if !cur_token.is_empty() {
            tokens.push(cur_token);
        }

        let mut cur_vis: Vec<(char, usize)> = Vec::new();
        let mut cur_vis_width: usize = 0;

        for token in tokens {
            let tok_width: usize = token
                .iter()
                .map(|(c, _)| UnicodeWidthChar::width(*c).unwrap_or(1))
                .sum();

            if cur_vis.is_empty() {
                if tok_width <= max_width {
                    cur_vis.extend(token);
                    cur_vis_width = tok_width;
                } else {
                    for (c, idx) in token {
                        let cw = UnicodeWidthChar::width(c).unwrap_or(1);
                        if cur_vis_width + cw > max_width && !cur_vis.is_empty() {
                            let start_idx = cur_vis.first().unwrap().1;
                            vis_lines.push(RawVisLine {
                                chars: std::mem::take(&mut cur_vis),
                                start_char_idx: start_idx,
                                ended_with_newline: false,
                            });
                            cur_vis_width = 0;
                        }
                        cur_vis.push((c, idx));
                        cur_vis_width += cw;
                    }
                }
            } else if cur_vis_width + tok_width <= max_width {
                cur_vis.extend(token);
                cur_vis_width += tok_width;
            } else {
                let start_idx = cur_vis.first().unwrap().1;
                vis_lines.push(RawVisLine {
                    chars: std::mem::take(&mut cur_vis),
                    start_char_idx: start_idx,
                    ended_with_newline: false,
                });
                cur_vis_width = 0;

                if tok_width <= max_width {
                    cur_vis.extend(token);
                    cur_vis_width = tok_width;
                } else {
                    for (c, idx) in token {
                        let cw = UnicodeWidthChar::width(c).unwrap_or(1);
                        if cur_vis_width + cw > max_width && !cur_vis.is_empty() {
                            let start_idx = cur_vis.first().unwrap().1;
                            vis_lines.push(RawVisLine {
                                chars: std::mem::take(&mut cur_vis),
                                start_char_idx: start_idx,
                                ended_with_newline: false,
                            });
                            cur_vis_width = 0;
                        }
                        cur_vis.push((c, idx));
                        cur_vis_width += cw;
                    }
                }
            }
        }

        if !cur_vis.is_empty() {
            let start_idx = cur_vis.first().unwrap().1;
            let count = cur_vis.len();
            vis_lines.push(RawVisLine {
                chars: cur_vis,
                start_char_idx: start_idx,
                ended_with_newline,
            });
            current_offset = start_idx + count;
            if ended_with_newline {
                current_offset += 1;
            }
        } else if let Some(last) = vis_lines.last_mut() {
            last.ended_with_newline = ended_with_newline;
            if ended_with_newline {
                current_offset += 1;
            }
        }
    }

    if vis_lines.is_empty() {
        vis_lines.push(RawVisLine {
            chars: Vec::new(),
            start_char_idx: 0,
            ended_with_newline: false,
        });
    }

    // 3. Find cursor line and column
    let total_lines = vis_lines.len();
    let mut resolved_cursor_line = total_lines - 1;
    let mut resolved_cursor_col = vis_lines[resolved_cursor_line].chars.len();

    for (i, r_line) in vis_lines.iter().enumerate() {
        let is_last = i == total_lines - 1;
        let start = r_line.start_char_idx;
        let count = r_line.chars.len();
        let ended_nl = r_line.ended_with_newline;

        if ended_nl {
            if cursor >= start && cursor <= start + count {
                resolved_cursor_line = i;
                resolved_cursor_col = cursor - start;
                break;
            }
        } else if is_last {
            if cursor >= start {
                resolved_cursor_line = i;
                resolved_cursor_col = (cursor - start).min(count);
                break;
            }
        } else if cursor >= start && cursor < start + count {
            resolved_cursor_line = i;
            resolved_cursor_col = cursor - start;
            break;
        }
    }

    // 4. Construct output lines
    let mut output_lines = Vec::with_capacity(total_lines);
    for (i, r_line) in vis_lines.iter().enumerate() {
        let text: String = r_line.chars.iter().map(|(c, _)| *c).collect();
        let char_count = r_line.chars.len();
        let cursor_col = if i == resolved_cursor_line {
            Some(resolved_cursor_col)
        } else {
            None
        };

        output_lines.push(InputVisualLine {
            text,
            start_char_idx: r_line.start_char_idx,
            char_count,
            cursor_col,
        });
    }

    WrappedInput {
        lines: output_lines,
        cursor_line: resolved_cursor_line,
        cursor_col: resolved_cursor_col,
    }
}

pub fn cursor_up_in_input(input: &str, cursor: usize, max_width: usize) -> Option<usize> {
    let wrapped = wrap_input_with_cursor(input, cursor, max_width);
    if wrapped.cursor_line == 0 {
        return None;
    }
    let target_line = wrapped.cursor_line - 1;
    let target = &wrapped.lines[target_line];
    let new_col = wrapped.cursor_col.min(target.char_count);
    Some(target.start_char_idx + new_col)
}

pub fn cursor_down_in_input(input: &str, cursor: usize, max_width: usize) -> Option<usize> {
    let wrapped = wrap_input_with_cursor(input, cursor, max_width);
    if wrapped.cursor_line + 1 >= wrapped.lines.len() {
        return None;
    }
    let target_line = wrapped.cursor_line + 1;
    let target = &wrapped.lines[target_line];
    let new_col = wrapped.cursor_col.min(target.char_count);
    Some(target.start_char_idx + new_col)
}

pub fn render_line_spans(
    line: &InputVisualLine,
    cursor_color: Color,
    cursor_visible: bool,
) -> Vec<Span<'static>> {
    let plain_text = |text: String| Span::styled(text, Style::default().fg(Theme::TEXT_PRIMARY));

    match line.cursor_col {
        // Caret is on this line but in its "off" blink phase: draw the text
        // untouched so the caret cell goes blank without shifting the layout.
        Some(_) if !cursor_visible => vec![plain_text(line.text.clone())],
        None => vec![plain_text(line.text.clone())],
        Some(col) => {
            let char_count = line.char_count;
            let col = col.min(char_count);
            let chars: Vec<char> = line.text.chars().collect();

            if col >= char_count {
                vec![
                    plain_text(line.text.clone()),
                    Span::styled("█", Style::default().fg(cursor_color)),
                ]
            } else {
                let before: String = chars[..col].iter().collect();
                let cur_char = chars[col];
                let after: String = chars[col + 1..].iter().collect();
                vec![
                    plain_text(before),
                    Span::styled(
                        cur_char.to_string(),
                        Style::default()
                            .fg(Theme::BG_CARD)
                            .bg(cursor_color)
                            .add_modifier(Modifier::BOLD),
                    ),
                    plain_text(after),
                ]
            }
        }
    }
}

#[allow(dead_code)]
pub fn render_input_with_cursor(input: &str, cursor: usize) -> Vec<Span<'static>> {
    let line = InputVisualLine {
        text: input.to_string(),
        start_char_idx: 0,
        char_count: input.chars().count(),
        cursor_col: Some(cursor),
    };
    render_line_spans(&line, Theme::ACCENT, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_input() {
        let wrapped = wrap_input_with_cursor("", 0, 40);
        assert_eq!(wrapped.lines.len(), 1);
        assert_eq!(wrapped.cursor_line, 0);
        assert_eq!(wrapped.cursor_col, 0);
        assert_eq!(wrapped.lines[0].text, "");
        assert_eq!(wrapped.lines[0].cursor_col, Some(0));
    }

    #[test]
    fn test_short_single_line_cursor_positions() {
        let text = "hello";
        let w0 = wrap_input_with_cursor(text, 0, 20);
        assert_eq!(w0.cursor_line, 0);
        assert_eq!(w0.cursor_col, 0);
        assert_eq!(w0.lines[0].cursor_col, Some(0));

        let w2 = wrap_input_with_cursor(text, 2, 20);
        assert_eq!(w2.cursor_line, 0);
        assert_eq!(w2.cursor_col, 2);

        let w5 = wrap_input_with_cursor(text, 5, 20);
        assert_eq!(w5.cursor_line, 0);
        assert_eq!(w5.cursor_col, 5);
    }

    #[test]
    fn test_soft_wrap_words() {
        let text = "hello world how are you";
        let wrapped = wrap_input_with_cursor(text, text.len(), 12);
        assert!(wrapped.lines.len() >= 2);
        let reconstructed: String = wrapped.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(reconstructed, text);
        assert_eq!(wrapped.cursor_line, wrapped.lines.len() - 1);
        assert_eq!(wrapped.cursor_col, wrapped.lines.last().unwrap().char_count);
    }

    #[test]
    fn test_long_word_split() {
        let text = "abcdefghijklmnopqrstuvwxyz";
        let wrapped = wrap_input_with_cursor(text, 15, 10);
        assert_eq!(wrapped.lines.len(), 3);
        assert_eq!(wrapped.lines[0].text, "abcdefghij");
        assert_eq!(wrapped.lines[1].text, "klmnopqrst");
        assert_eq!(wrapped.lines[2].text, "uvwxyz");
        assert_eq!(wrapped.cursor_line, 1);
        assert_eq!(wrapped.cursor_col, 5);
    }

    #[test]
    fn test_explicit_newlines() {
        let text = "line1\nline2\nline3";
        let wrapped = wrap_input_with_cursor(text, 7, 30);
        assert_eq!(wrapped.lines.len(), 3);
        assert_eq!(wrapped.lines[0].text, "line1");
        assert_eq!(wrapped.lines[1].text, "line2");
        assert_eq!(wrapped.lines[2].text, "line3");
        // Index 7 is 'i' in "line2" (l=6, i=7)
        assert_eq!(wrapped.cursor_line, 1);
        assert_eq!(wrapped.cursor_col, 1);
    }

    #[test]
    fn test_cursor_up_down_navigation() {
        let text = "first line\nsecond long line\nthird";
        let max_w = 40;
        // Cursor at column 5 on second line ("second long line" starts at 11, col 5 is at 16)
        let cur = 16;
        let up = cursor_up_in_input(text, cur, max_w);
        assert_eq!(up, Some(5)); // col 5 on "first line" (start 0 + 5)

        let down = cursor_down_in_input(text, cur, max_w);
        assert_eq!(down, Some(28 + 5)); // third line starts at 28, length 5
    }
}
