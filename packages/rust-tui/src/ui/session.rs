use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

use crate::markdown::{render_markdown, wrap_text};
use crate::types::{ConversationTurn, ModelConfig, SessionInfo, SessionStats};
use crate::ui::logo::{render_animated_logo_lines, render_header_logo};
use crate::ui::spinner::Spinner;
use crate::ui::theme::Theme;
use crate::ui::welcome::{CommandItem, COMMANDS};

pub fn render_session(
    f: &mut Frame,
    area: Rect,
    session_info: Option<&SessionInfo>,
    turns: &[ConversationTurn],
    stats: &SessionStats,
    config: &ModelConfig,
    input_buffer: &str,
    cursor_pos: usize,
    scroll_offset: usize,
    dropdown_index: usize,
    spinner: &Spinner,
    is_streaming: bool,
) {
    let pad_top = if area.height >= 12 { 1u16 } else { 0u16 };
    let cursor_visible = spinner.cursor_visible();
    let content_area = Rect::new(
        area.x,
        area.y + pad_top,
        area.width,
        area.height.saturating_sub(pad_top),
    );

    let sidebar_width = (content_area.width / 4).clamp(24, 32);
    let main_width = content_area.width.saturating_sub(sidebar_width + 1);

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(main_width),
            Constraint::Length(1),
            Constraint::Length(sidebar_width),
        ])
        .split(content_area);

    let max_input_text_width = (main_width as usize).saturating_sub(6).max(10);
    let wrapped_input = crate::ui::input::wrap_input_with_cursor(input_buffer, cursor_pos, max_input_text_width);
    let max_visible_lines = 8usize;
    let num_input_lines = if is_streaming {
        1
    } else {
        wrapped_input.lines.len().clamp(1, max_visible_lines)
    };
    let input_area_height = (num_input_lines + 2) as u16;

    let main_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Top header (title, divider, padding)
            Constraint::Min(5),    // Conversation turns
            Constraint::Length(input_area_height), // Input area (top line, text lines, bottom line)
        ])
        .split(chunks[0]);

    let border_style = Style::default().fg(Theme::BORDER);

    // 1. Main Header with 2-space padding
    let sess_title = session_info
        .map(|s| s.title.as_str())
        .unwrap_or("CodeWork Session");
    let sess_dir = session_info
        .map(|s| s.directory.as_str())
        .unwrap_or("active session");

    let max_dir_len = (main_width as usize).saturating_sub(32).clamp(12, 40);
    let formatted_dir = crate::git::truncate_path(std::path::Path::new(sess_dir), max_dir_len);
    let mut title_spans = vec![Span::raw("  ")];
    title_spans.extend(render_header_logo(spinner.tick_count(), is_streaming));
    title_spans.push(Span::styled(format!("· {} ", sess_title), Style::default().fg(Theme::TEXT_PRIMARY)));
    title_spans.push(Span::styled(format!("({})", formatted_dir), Style::default().fg(Theme::TEXT_MUTED)));

    let header_lines = vec![
        Line::from(title_spans),
        Line::from(vec![
            Span::raw("  "),
            Span::styled("─".repeat((main_width as usize).saturating_sub(3)), border_style),
        ]),
        Line::raw(""),
    ];
    f.render_widget(Paragraph::new(header_lines), main_chunks[0]);

    // 2. Conversation Render Lines (inside conv_area with 2-column padding)
    let conv_area = Rect::new(
        main_chunks[1].x + 2,
        main_chunks[1].y,
        main_chunks[1].width.saturating_sub(4),
        main_chunks[1].height,
    );
    let max_text_width = conv_area.width as usize;
    let mut conv_lines: Vec<Line<'static>> = Vec::new();

    for turn in turns {
        // Prompt Box with border and background color
        conv_lines.extend(render_user_prompt_box(&turn.prompt, max_text_width));
        conv_lines.push(Line::raw(""));

        // Thinking indicator
        if !turn.thinking.is_empty() {
            let spin_char = if turn.streaming { spinner.current() } else { "●" };
            conv_lines.push(Line::from(vec![
                Span::styled(format!("{} ", spin_char), Style::default().fg(Theme::ACTIVITY)),
                Span::styled("Thinking", Style::default().fg(Theme::ACTIVITY).add_modifier(Modifier::BOLD)),
            ]));

            let wrap_think_w = max_text_width.saturating_sub(4).max(10);
            for t_line in turn.thinking.lines().take(8) {
                let wrapped = wrap_text(t_line, wrap_think_w);
                for w_line in wrapped {
                    conv_lines.push(Line::from(vec![
                        Span::styled("  │ ", Style::default().fg(Theme::TEXT_MUTED)),
                        Span::styled(w_line, Style::default().fg(Theme::TEXT_MUTED).add_modifier(Modifier::ITALIC)),
                    ]));
                }
            }
            conv_lines.push(Line::raw(""));
        }

        // Active Tool
        if let Some(tool) = &turn.active_tool {
            conv_lines.push(Line::from(vec![
                Span::styled(format!("{} ", spinner.current()), Style::default().fg(Theme::ACTIVITY)),
                Span::styled(tool.clone(), Style::default().fg(Theme::TEXT_PRIMARY)),
            ]));
        }

        // Completed Tools
        for tool in &turn.completed_tools {
            conv_lines.push(Line::from(vec![
                Span::styled("✓ ", Style::default().fg(Theme::SUCCESS)),
                Span::styled(tool.clone(), Style::default().fg(Theme::SUCCESS)),
            ]));
        }

        if turn.active_tool.is_some() || !turn.completed_tools.is_empty() {
            conv_lines.push(Line::raw(""));
        }

        // Response markdown (word-wrapped and formatted)
        if !turn.response.is_empty() {
            let rendered = render_markdown(&turn.response, max_text_width);
            conv_lines.extend(rendered);
            conv_lines.push(Line::raw(""));
        }

        // Error line
        if let Some(err) = &turn.error {
            conv_lines.push(Line::from(vec![
                Span::styled("✗ ", Style::default().fg(Theme::ERROR).add_modifier(Modifier::BOLD)),
                Span::styled(err.clone(), Style::default().fg(Theme::ERROR)),
            ]));
            conv_lines.push(Line::raw(""));
        }

        // Turn Footer
        let elapsed_sec = if let Some(end) = turn.end_time {
            (end - turn.start_time) as f64 / 1000.0
        } else {
            (chrono::Utc::now().timestamp_millis() - turn.start_time) as f64 / 1000.0
        };

        let footer_spans = vec![
            Span::styled("● ", Style::default().fg(Theme::ACCENT)),
            Span::styled("Build   ", Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD)),
            Span::styled(format!("{}   ", turn.model_name), Style::default().fg(Theme::MODEL)),
            Span::styled(format!("{:.1}s   ", elapsed_sec), Style::default().fg(Theme::TEXT_MUTED)),
            Span::styled(format!("{:.1} tok/s", turn.tokens_per_sec), Style::default().fg(Theme::TEXT_MUTED)),
        ];
        conv_lines.push(Line::from(footer_spans));
        conv_lines.push(Line::raw(""));
    }

    let total_lines = conv_lines.len();
    let viewport_height = conv_area.height as usize;

    let max_scroll = total_lines.saturating_sub(viewport_height);
    let clamped_offset = scroll_offset.min(max_scroll);
    let effective_scroll = max_scroll.saturating_sub(clamped_offset);

    let chat_paragraph = Paragraph::new(conv_lines).scroll((effective_scroll as u16, 0));
    f.render_widget(chat_paragraph, conv_area);

    // Bottom Input Section: line on top, input text line, line on bottom
    let top_divider_line = if clamped_offset > 0 {
        let tag = format!(" [↑ History +{} lines (End to bottom)] ", clamped_offset);
        let rem = (main_width as usize).saturating_sub(tag.len() + 3);
        let left_dashes = rem / 2;
        let right_dashes = rem.saturating_sub(left_dashes);
        Line::from(vec![
            Span::raw("  "),
            Span::styled("─".repeat(left_dashes), border_style),
            Span::styled(tag, Style::default().fg(Theme::ACTIVITY).add_modifier(Modifier::BOLD)),
            Span::styled("─".repeat(right_dashes), border_style),
        ])
    } else {
        Line::from(vec![
            Span::raw("  "),
            Span::styled("─".repeat((main_width as usize).saturating_sub(3)), border_style),
        ])
    };

    let mut input_widget_lines = Vec::new();
    input_widget_lines.push(top_divider_line);

    if is_streaming {
        input_widget_lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(format!("{} ", spinner.current()), Style::default().fg(Theme::ACTIVITY)),
            Span::styled("Generating response... (Ctrl+C to interrupt)", Style::default().fg(Theme::TEXT_MUTED)),
        ]));
    } else {
        let total_input_lines = wrapped_input.lines.len();
        let scroll_top = if wrapped_input.cursor_line >= max_visible_lines {
            wrapped_input.cursor_line + 1 - max_visible_lines
        } else {
            0
        };
        let visible_slice = &wrapped_input.lines[scroll_top..(scroll_top + max_visible_lines).min(total_input_lines)];

        for (idx, line) in visible_slice.iter().enumerate() {
            let line_idx = scroll_top + idx;
            let mut spans = if line_idx == 0 {
                vec![
                    Span::raw("  "),
                    Span::styled("❯ ", Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD)),
                ]
            } else {
                vec![
                    Span::raw("    "),
                ]
            };
            spans.extend(crate::ui::input::render_line_spans(line, Theme::ACCENT, cursor_visible));
            input_widget_lines.push(Line::from(spans));
        }
    }

    let bottom_divider_line = Line::from(vec![
        Span::raw("  "),
        Span::styled("─".repeat((main_width as usize).saturating_sub(3)), border_style),
    ]);
    input_widget_lines.push(bottom_divider_line);

    f.render_widget(Paragraph::new(input_widget_lines), main_chunks[2]);

    // Command Dropdown Popup in Session
    let is_dropdown_open = !is_streaming && input_buffer.starts_with('/') && !input_buffer.contains(' ');
    if is_dropdown_open {
        let matching_cmds: Vec<&CommandItem> = COMMANDS
            .iter()
            .filter(|cmd| cmd.name.starts_with(input_buffer))
            .collect();

        let num_rows = matching_cmds.len().max(1) as u16;
        let popup_h = (num_rows + 2).min(main_chunks[1].height);
        let popup_w = (main_width as u16).saturating_sub(4).max(20);
        let popup_x = main_chunks[2].x + 2;
        let popup_y = main_chunks[2].y.saturating_sub(popup_h);

        let popup_rect = Rect::new(popup_x, popup_y, popup_w, popup_h);

        f.render_widget(Clear, popup_rect);

        let popup_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Theme::SKY))
            .title(Span::styled(" Commands ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD)))
            .title_bottom(Span::styled(
                " ↑/↓ navigate • Tab complete • Enter select • Esc dismiss ",
                Style::default().fg(Theme::TEXT_MUTED),
            ))
            .style(Style::default().bg(Theme::BG_SURFACE));

        f.render_widget(popup_block, popup_rect);

        let inner_rect = Rect::new(
            popup_rect.x + 1,
            popup_rect.y + 1,
            popup_rect.width.saturating_sub(2),
            popup_rect.height.saturating_sub(2),
        );

        let mut cmd_lines = Vec::new();
        if matching_cmds.is_empty() {
            cmd_lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled("No matching commands", Style::default().fg(Theme::TEXT_MUTED)),
            ]));
        } else {
            for (idx, cmd) in matching_cmds.iter().enumerate() {
                let is_selected = idx == dropdown_index;
                if is_selected {
                    cmd_lines.push(Line::from(vec![
                        Span::styled("▶ ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD)),
                        Span::styled(format!("{} ", cmd.icon), Style::default().fg(cmd.icon_color).add_modifier(Modifier::BOLD)),
                        Span::styled(
                            format!("{:<10}", cmd.name),
                            Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(cmd.description, Style::default().fg(Theme::TEXT_PRIMARY)),
                    ]));
                } else {
                    cmd_lines.push(Line::from(vec![
                        Span::styled("  ", Style::default()),
                        Span::styled(format!("{} ", cmd.icon), Style::default().fg(cmd.icon_color)),
                        Span::styled(
                            format!("{:<10}", cmd.name),
                            Style::default().fg(Theme::TEXT_SECONDARY),
                        ),
                        Span::styled(cmd.description, Style::default().fg(Theme::TEXT_MUTED)),
                    ]));
                }
            }
        }

        f.render_widget(Paragraph::new(cmd_lines), inner_rect);
    }

    // Vertical Divider
    let vert_div = (0..chunks[1].height)
        .map(|_| Line::from(Span::styled("│", border_style)))
        .collect::<Vec<_>>();
    f.render_widget(Paragraph::new(vert_div), chunks[1]);

    // 3. Right Sidebar with padding
    let sidebar_area = Rect::new(
        chunks[2].x + 2,
        chunks[2].y,
        chunks[2].width.saturating_sub(3),
        chunks[2].height,
    );

    let sidebar_block = Block::default()
        .borders(Borders::NONE);

    let mut sidebar_lines = Vec::new();

    // Codework logo at the top of the right sidebar
    if sidebar_area.height >= 18 {
        let logo_pad = (sidebar_area.width as usize).saturating_sub(20) / 2;
        sidebar_lines.extend(render_animated_logo_lines(logo_pad, spinner.tick_count()));
        sidebar_lines.push(Line::raw(""));
    }

    sidebar_lines.push(Line::from(Span::styled("MODEL", Style::default().fg(Theme::TEXT_MUTED).add_modifier(Modifier::BOLD))));
    sidebar_lines.push(Line::from(vec![
        Span::styled(format!("{} ", config.provider), Style::default().fg(Theme::TEXT_PRIMARY)),
        Span::styled(&config.model, Style::default().fg(Theme::MODEL).add_modifier(Modifier::BOLD)),
    ]));
    sidebar_lines.push(Line::raw(""));

    sidebar_lines.push(Line::from(Span::styled("CONTEXT", Style::default().fg(Theme::TEXT_MUTED).add_modifier(Modifier::BOLD))));
    let pct = (stats.total_tokens as f64 / 1_000_000.0 * 100.0).clamp(0.0, 100.0);
    let filled = ((pct / 10.0).round() as usize).min(10);
    let empty = 10 - filled;
    let bar = format!("[{}{}] {:.1}%", "█".repeat(filled), "░".repeat(empty), pct);
    sidebar_lines.push(Line::from(Span::styled(bar, Style::default().fg(Theme::ACCENT))));
    sidebar_lines.push(Line::from(Span::styled(
        format!("{} / 1.0M tokens", stats.total_tokens),
        Style::default().fg(Theme::TEXT_MUTED),
    )));
    sidebar_lines.push(Line::raw(""));

    sidebar_lines.push(Line::from(Span::styled("METRICS", Style::default().fg(Theme::TEXT_MUTED).add_modifier(Modifier::BOLD))));
    sidebar_lines.push(Line::from(vec![
        Span::styled("Turns: ", Style::default().fg(Theme::TEXT_MUTED)),
        Span::styled(format!("{}", stats.turns_count), Style::default().fg(Theme::TEXT_PRIMARY)),
    ]));
    sidebar_lines.push(Line::from(vec![
        Span::styled("Cost:  ", Style::default().fg(Theme::TEXT_MUTED)),
        Span::styled(format!("${:.4}", stats.cost), Style::default().fg(Theme::SUCCESS)),
    ]));
    sidebar_lines.push(Line::raw(""));

    sidebar_lines.push(Line::from(Span::styled("CONTROLS", Style::default().fg(Theme::TEXT_MUTED).add_modifier(Modifier::BOLD))));
    sidebar_lines.push(Line::from(Span::styled("Ctrl+C  Interrupt / Exit", Style::default().fg(Theme::TEXT_SECONDARY))));
    sidebar_lines.push(Line::from(Span::styled("↑ / ↓   Scroll chat", Style::default().fg(Theme::TEXT_SECONDARY))));
    sidebar_lines.push(Line::from(Span::styled("Home/End Top / Bottom", Style::default().fg(Theme::TEXT_SECONDARY))));
    sidebar_lines.push(Line::from(Span::styled("Esc     Return to home", Style::default().fg(Theme::TEXT_SECONDARY))));

    f.render_widget(Paragraph::new(sidebar_lines).block(sidebar_block), sidebar_area);
}

#[allow(dead_code)]
pub fn render_input_with_cursor(input: &str, cursor: usize) -> Vec<Span<'static>> {
    crate::ui::input::render_input_with_cursor(input, cursor)
}

pub fn render_user_prompt_box(prompt: &str, max_text_width: usize) -> Vec<Line<'static>> {
    let box_bg = Theme::BG_USER_MSG;
    let border_color = Theme::BORDER_USER_MSG;
    let wrap_w = max_text_width.saturating_sub(6).max(10);

    let mut prompt_lines = Vec::new();
    for raw_line in prompt.lines() {
        let wrapped = wrap_text(raw_line, wrap_w);
        if wrapped.is_empty() {
            prompt_lines.push(String::new());
        } else {
            prompt_lines.extend(wrapped);
        }
    }
    if prompt_lines.is_empty() {
        prompt_lines.push(prompt.to_string());
    }

    // Full width user message box across the entire conversation area
    let box_w = max_text_width;
    let avail_w = box_w.saturating_sub(4);

    let mut lines = Vec::new();

    // 1. Top border: ╭── ❯ ──────────────────────╮
    let top_prefix = "╭── ";
    let top_icon = "❯ ";
    let top_right = "╮";
    let bar_len = box_w.saturating_sub(7);

    lines.push(Line::from(vec![
        Span::styled(top_prefix, Style::default().fg(border_color).bg(box_bg)),
        Span::styled(
            top_icon,
            Style::default().fg(Theme::PRIMARY).bg(box_bg).add_modifier(Modifier::BOLD),
        ),
        Span::styled("─".repeat(bar_len), Style::default().fg(border_color).bg(box_bg)),
        Span::styled(top_right, Style::default().fg(border_color).bg(box_bg)),
    ]));

    // 2. Middle lines: │  <text>                 │
    for p_line in prompt_lines {
        let line_w = UnicodeWidthStr::width(p_line.as_str());
        let (display_text, actual_w) = if line_w > avail_w {
            let mut truncated = String::new();
            let mut cur_w = 0;
            for ch in p_line.chars() {
                let ch_w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                if cur_w + ch_w + 1 <= avail_w {
                    truncated.push(ch);
                    cur_w += ch_w;
                } else {
                    break;
                }
            }
            truncated.push('…');
            let tw = UnicodeWidthStr::width(truncated.as_str());
            (truncated, tw)
        } else {
            (p_line, line_w)
        };
        let pad = avail_w.saturating_sub(actual_w);
        lines.push(Line::from(vec![
            Span::styled("│ ", Style::default().fg(border_color).bg(box_bg)),
            Span::styled(
                display_text,
                Style::default().fg(Theme::TEXT_PRIMARY).bg(box_bg).add_modifier(Modifier::BOLD),
            ),
            Span::styled(" ".repeat(pad), Style::default().bg(box_bg)),
            Span::styled(" │", Style::default().fg(border_color).bg(box_bg)),
        ]));
    }

    // 3. Bottom border: ╰────────────────────────╯
    let bot_bar_len = box_w.saturating_sub(2);
    lines.push(Line::from(vec![
        Span::styled("╰", Style::default().fg(border_color).bg(box_bg)),
        Span::styled("─".repeat(bot_bar_len), Style::default().fg(border_color).bg(box_bg)),
        Span::styled("╯", Style::default().fg(border_color).bg(box_bg)),
    ]));

    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_visual_width(line: &Line) -> usize {
        line.spans.iter().map(|s| UnicodeWidthStr::width(s.content.as_ref())).sum()
    }

    #[test]
    fn test_render_user_prompt_box_single_line() {
        let lines = render_user_prompt_box("Hello CodeWork", 60);
        assert_eq!(lines.len(), 3);
        let expected_w = line_visual_width(&lines[0]);
        assert_eq!(expected_w, 60, "Box width must equal full max_text_width");
        for line in &lines {
            assert_eq!(line_visual_width(line), expected_w, "All lines in user prompt box must have equal visual width");
        }
    }

    #[test]
    fn test_render_user_prompt_box_multiline() {
        let lines = render_user_prompt_box("Line 1\nLine 2 is longer\nLine 3", 60);
        assert_eq!(lines.len(), 5);
        let expected_w = line_visual_width(&lines[0]);
        assert_eq!(expected_w, 60, "Box width must equal full max_text_width");
        for line in &lines {
            assert_eq!(line_visual_width(line), expected_w, "All lines in multiline box must have equal visual width");
        }
    }

    #[test]
    fn test_render_user_prompt_box_has_background() {
        let lines = render_user_prompt_box("check background color", 50);
        for line in &lines {
            for span in &line.spans {
                assert_eq!(span.style.bg, Some(Theme::BG_USER_MSG));
            }
        }
    }
}
