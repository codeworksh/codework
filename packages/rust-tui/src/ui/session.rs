use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use crate::markdown::{render_markdown, wrap_text};
use crate::types::{ConversationTurn, ModelConfig, SessionInfo, SessionStats};
use crate::ui::spinner::Spinner;
use crate::ui::theme::Theme;

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
    spinner: &Spinner,
    is_streaming: bool,
) {
    let sidebar_width = (area.width / 4).clamp(24, 32);
    let main_width = area.width.saturating_sub(sidebar_width + 1);

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(main_width),
            Constraint::Length(1),
            Constraint::Length(sidebar_width),
        ])
        .split(area);

    let main_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2), // Top header
            Constraint::Min(5),    // Conversation turns
            Constraint::Length(1), // Divider
            Constraint::Length(2), // Input area
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

    let formatted_dir = crate::git::truncate_path(std::path::Path::new(sess_dir), 36);
    let header_lines = vec![
        Line::from(vec![
            Span::raw("  "),
            Span::styled("codework ", Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD)),
            Span::styled(format!("· {} ", sess_title), Style::default().fg(Theme::TEXT_PRIMARY)),
            Span::styled(format!("({})", formatted_dir), Style::default().fg(Theme::TEXT_MUTED)),
        ]),
        Line::from(vec![
            Span::raw("  "),
            Span::styled("─".repeat((main_width as usize).saturating_sub(3)), border_style),
        ]),
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
        // Prompt
        conv_lines.push(Line::from(vec![
            Span::styled("❯ ", Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD)),
            Span::styled(
                turn.prompt.clone(),
                Style::default().fg(Theme::TEXT_PRIMARY).add_modifier(Modifier::BOLD),
            ),
        ]));
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

    // Bottom Divider with Scroll History Indicator
    let divider_line = if clamped_offset > 0 {
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
    f.render_widget(Paragraph::new(divider_line), main_chunks[2]);

    // Bottom Input Bar (aligned with conv_area)
    let input_area = Rect::new(
        main_chunks[3].x + 2,
        main_chunks[3].y,
        main_chunks[3].width.saturating_sub(4),
        main_chunks[3].height,
    );

    let input_line = if is_streaming {
        Line::from(vec![
            Span::styled(format!("{} ", spinner.current()), Style::default().fg(Theme::ACTIVITY)),
            Span::styled("Generating response... (Ctrl+C to interrupt)", Style::default().fg(Theme::TEXT_MUTED)),
        ])
    } else {
        let mut spans = vec![
            Span::styled("❯ ", Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD)),
        ];
        spans.extend(render_input_with_cursor(input_buffer, cursor_pos));
        Line::from(spans)
    };
    f.render_widget(Paragraph::new(input_line), input_area);

    // Vertical Divider
    let vert_div = (0..area.height)
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
        .title(Span::styled("Session", Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD)))
        .borders(Borders::NONE);

    let mut sidebar_lines = Vec::new();
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

pub fn render_input_with_cursor(input: &str, cursor: usize) -> Vec<Span<'static>> {
    let char_count = input.chars().count();
    let cursor = cursor.min(char_count);
    let chars: Vec<char> = input.chars().collect();

    if cursor >= char_count {
        vec![
            Span::styled(input.to_string(), Style::default().fg(Theme::TEXT_PRIMARY)),
            Span::styled("█", Style::default().fg(Theme::ACCENT)),
        ]
    } else {
        let before: String = chars[..cursor].iter().collect();
        let cur_char = chars[cursor];
        let after: String = chars[cursor + 1..].iter().collect();
        vec![
            Span::styled(before, Style::default().fg(Theme::TEXT_PRIMARY)),
            Span::styled(
                cur_char.to_string(),
                Style::default().fg(Theme::BG_CARD).bg(Theme::ACCENT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(after, Style::default().fg(Theme::TEXT_PRIMARY)),
        ]
    }
}
