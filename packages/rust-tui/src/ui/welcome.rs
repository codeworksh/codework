use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use crate::types::ModelConfig;
use crate::ui::logo::{render_animated_logo_lines, LOGO_GRADIENT, LOGO_SPARKLE_FRAMES};
use crate::ui::spinner::Spinner;
use crate::ui::theme::Theme;

#[derive(Debug, Clone, Copy)]
pub struct CommandItem {
    pub name: &'static str,
    pub icon: &'static str,
    pub description: &'static str,
    pub icon_color: Color,
}

pub const COMMANDS: &[CommandItem] = &[
    CommandItem {
        name: "/help",
        icon: "?",
        description: "Show available commands and shortcuts",
        icon_color: Theme::SKY,
    },
    CommandItem {
        name: "/clear",
        icon: "↺",
        description: "Clear conversation history and screen",
        icon_color: Theme::WARNING,
    },
    CommandItem {
        name: "/model",
        icon: "✦",
        description: "Switch or view active LLM model",
        icon_color: Theme::PRIMARY,
    },
    CommandItem {
        name: "/session",
        icon: "◷",
        description: "List or resume recent sessions",
        icon_color: Theme::SECONDARY,
    },
    CommandItem {
        name: "/compact",
        icon: "⇥",
        description: "Compact current conversation context",
        icon_color: Theme::SUCCESS,
    },
    CommandItem {
        name: "/exit",
        icon: "✕",
        description: "Exit CodeWork TUI",
        icon_color: Theme::ERROR,
    },
];

pub fn render_welcome(
    f: &mut Frame,
    area: Rect,
    input: &str,
    cursor_pos: usize,
    dropdown_index: usize,
    active_config: Option<&ModelConfig>,
    status_message: Option<&str>,
    spinner: &Spinner,
) {
    let card_width = 78u16.min(area.width.saturating_sub(2));
    let cursor_visible = spinner.cursor_visible();
    let is_dropdown_open = input.starts_with('/') && !input.contains(' ');

    let matching_cmds: Vec<&CommandItem> = if is_dropdown_open {
        COMMANDS
            .iter()
            .filter(|cmd| cmd.name.starts_with(input))
            .collect()
    } else {
        Vec::new()
    };

    let max_welcome_text_w = (card_width as usize).saturating_sub(6).max(10);
    let wrapped_welcome = crate::ui::input::wrap_input_with_cursor(input, cursor_pos, max_welcome_text_w);
    let max_visible_welcome = 5usize;
    let num_welcome_lines = if input.is_empty() {
        1
    } else {
        wrapped_welcome.lines.len().clamp(1, max_visible_welcome)
    };

    // Calculate Card 2 (Bottom Card) height
    let card2_height = if is_dropdown_open {
        let rows = matching_cmds.len().max(1) as u16;
        // 1 (top border) + 1 (header "Commands") + rows + 1 (empty line) + num_lines + 1 (bottom border)
        4 + rows + num_welcome_lines as u16
    } else {
        2 + num_welcome_lines as u16
    };

    // Total content height
    let total_height = 17 + 1 + 2 + 1 + card2_height + 1;

    let start_x = (area.width.saturating_sub(card_width)) / 2;
    let start_y = (area.height.saturating_sub(total_height)) / 2;

    // 1. Top Card (Main Status / Welcome Card)
    let top_h = 17u16.min(area.height.saturating_sub(start_y));
    let top_rect = Rect::new(start_x, start_y, card_width, top_h);

    let top_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Theme::BORDER))
        .style(Style::default().bg(Theme::BG_SURFACE));
    f.render_widget(top_block, top_rect);

    if top_h >= 5 {
        let inner_w = card_width.saturating_sub(2);
        let inner_x = start_x + 1;
        let inner_y = start_y + 1;

        // Header bar inside card
        let sparkle_frame = LOGO_SPARKLE_FRAMES[(spinner.tick_count() / 2) % LOGO_SPARKLE_FRAMES.len()];
        let sparkle_color = LOGO_GRADIENT[spinner.tick_count() % LOGO_GRADIENT.len()];
        let left_part_len = 2 + "codework v0.0.1".len();
        let right_part = "open-source harness";
        let header_pad = (inner_w as usize).saturating_sub(left_part_len + right_part.len());

        let header_line = Line::from(vec![
            Span::styled(
                format!("{} ", sparkle_frame),
                Style::default().fg(sparkle_color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "codework ",
                Style::default().fg(Theme::TEXT_PRIMARY).add_modifier(Modifier::BOLD),
            ),
            Span::styled("v0.0.1", Style::default().fg(Theme::TEXT_MUTED)),
            Span::raw(" ".repeat(header_pad)),
            Span::styled(right_part, Style::default().fg(Theme::TEXT_MUTED)),
        ]);
        let divider_line = Line::from(Span::styled(
            "─".repeat(inner_w as usize),
            Style::default().fg(Theme::BORDER),
        ));
        f.render_widget(
            Paragraph::new(vec![header_line, divider_line]),
            Rect::new(inner_x, inner_y, inner_w, 2),
        );

        // Columns area
        let content_y = inner_y + 2;
        let content_h = top_h.saturating_sub(4);
        let left_w = 28u16.min(inner_w);

        // Left Column: Headline + Logo + Model info
        let mut left_lines = Vec::new();
        left_lines.push(Line::from(Span::styled(
            "The Open-Source",
            Style::default().fg(Theme::TEXT_PRIMARY).add_modifier(Modifier::BOLD),
        )));
        left_lines.push(Line::from(Span::styled(
            "Coding Agent Harness",
            Style::default().fg(Theme::ACCENT),
        )));
        left_lines.push(Line::raw(""));

        // CW Logo with animated gradient
        left_lines.extend(render_animated_logo_lines(0, spinner.tick_count()));

        left_lines.push(Line::raw(""));
        left_lines.push(Line::raw(""));

        let model_str = active_config
            .map(|c| format!("{}:{}", c.provider, c.model))
            .unwrap_or_else(|| "codework:default".to_string());
        left_lines.push(Line::from(Span::styled(
            model_str,
            Style::default().fg(Theme::MODEL),
        )));
        left_lines.push(Line::from(Span::styled(
            "plugins • sandboxed",
            Style::default().fg(Theme::TEXT_MUTED),
        )));

        f.render_widget(
            Paragraph::new(left_lines).alignment(Alignment::Center),
            Rect::new(inner_x, content_y, left_w, content_h),
        );

        // Vertical divider
        if inner_w > left_w {
            let div_lines: Vec<Line> = (0..content_h)
                .map(|_| Line::from(Span::styled("│", Style::default().fg(Theme::BORDER))))
                .collect();
            f.render_widget(
                Paragraph::new(div_lines),
                Rect::new(inner_x + left_w, content_y, 1, content_h),
            );
        }

        // Right Column: Agent Loop, Plugins, Platform
        let right_x = inner_x + left_w + 1;
        let right_w = inner_w.saturating_sub(left_w + 1);
        if right_w > 0 {
            let div_width = right_w.saturating_sub(4) as usize;
            let right_lines = vec![
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled(
                        "Agent Loop & Tools",
                        Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD),
                    ),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("Understand ", Style::default().fg(Theme::TEXT_SECONDARY)),
                    Span::styled("search & read codebase", Style::default().fg(Theme::TEXT_MUTED)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("Modify     ", Style::default().fg(Theme::TEXT_SECONDARY)),
                    Span::styled("edit files & apply diffs", Style::default().fg(Theme::TEXT_MUTED)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("Execute    ", Style::default().fg(Theme::TEXT_SECONDARY)),
                    Span::styled("sandboxed commands & shell", Style::default().fg(Theme::TEXT_MUTED)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("Debug      ", Style::default().fg(Theme::TEXT_SECONDARY)),
                    Span::styled("autonomous test & iterate", Style::default().fg(Theme::TEXT_MUTED)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("─".repeat(div_width), Style::default().fg(Theme::BORDER)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled(
                        "Plugins & MCP",
                        Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD),
                    ),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("Plugin SDK ", Style::default().fg(Theme::TEXT_SECONDARY)),
                    Span::styled("custom tools, drivers & hooks", Style::default().fg(Theme::TEXT_MUTED)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("MCP Ready  ", Style::default().fg(Theme::TEXT_SECONDARY)),
                    Span::styled("plug in external tool servers", Style::default().fg(Theme::TEXT_MUTED)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("─".repeat(div_width), Style::default().fg(Theme::BORDER)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled(
                        "Developer Platform",
                        Style::default().fg(Theme::ACCENT).add_modifier(Modifier::BOLD),
                    ),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("Sandboxed  ", Style::default().fg(Theme::TEXT_SECONDARY)),
                    Span::styled("isolated execution", Style::default().fg(Theme::TEXT_MUTED)),
                ]),
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("Open Source", Style::default().fg(Theme::TEXT_SECONDARY)),
                    Span::styled("build & run your agent", Style::default().fg(Theme::TEXT_MUTED)),
                ]),
            ];
            f.render_widget(
                Paragraph::new(right_lines),
                Rect::new(right_x, content_y, right_w, content_h),
            );
        }
    }

    // 2. Supporting Copy
    let copy_y = start_y + top_h + 1;
    if copy_y + 2 <= area.height {
        let copy_lines = vec![
            Line::from(vec![
                Span::styled(
                    "Codework: ",
                    Style::default().fg(Theme::PINK),
                ),
                Span::styled(
                    "Build, run, and customize AI coding agents with plugins to",
                    Style::default().fg(Theme::TEXT_MUTED).add_modifier(Modifier::ITALIC),
                ),
            ]),
            Line::from(vec![
                Span::styled(
                    "understand code, edit files, execute commands, and debug autonomously.",
                    Style::default().fg(Theme::TEXT_MUTED).add_modifier(Modifier::ITALIC),
                ),
            ]),
        ];
        f.render_widget(Paragraph::new(copy_lines), Rect::new(start_x, copy_y, card_width, 2));
    }

    // 3. Unified Input and Commands Box
    let bot_y = copy_y + 3;
    let bot_h = card2_height.min(area.height.saturating_sub(bot_y));
    if bot_h >= 3 {
        let bot_border_color = if is_dropdown_open {
            Theme::SKY
        } else {
            Theme::BORDER_BOX
        };

        let bot_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(bot_border_color))
            .style(Style::default().bg(Theme::BG_SURFACE));
        let bot_inner = Rect::new(start_x + 1, bot_y + 1, card_width.saturating_sub(2), bot_h.saturating_sub(2));

        f.render_widget(bot_block, Rect::new(start_x, bot_y, card_width, bot_h));

        let mut bot_lines = Vec::new();
        if is_dropdown_open {
            bot_lines.push(Line::from(Span::styled(
                "Commands",
                Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD),
            )));

            if matching_cmds.is_empty() {
                bot_lines.push(Line::from(Span::styled(
                    "No matching commands",
                    Style::default().fg(Theme::TEXT_MUTED),
                )));
            } else {
                for (idx, cmd) in matching_cmds.iter().enumerate() {
                    let is_selected = idx == dropdown_index;
                    if is_selected {
                        bot_lines.push(Line::from(vec![
                            Span::styled("▶ ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD)),
                            Span::styled(format!("{} ", cmd.icon), Style::default().fg(cmd.icon_color).add_modifier(Modifier::BOLD)),
                            Span::styled(
                                format!("{:<10}", cmd.name),
                                Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD),
                            ),
                            Span::styled(cmd.description, Style::default().fg(Theme::TEXT_PRIMARY)),
                        ]));
                    } else {
                        bot_lines.push(Line::from(vec![
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

            bot_lines.push(Line::raw(""));

            let total_w_lines = wrapped_welcome.lines.len();
            let scroll_top = if wrapped_welcome.cursor_line >= max_visible_welcome {
                wrapped_welcome.cursor_line + 1 - max_visible_welcome
            } else {
                0
            };
            let visible_slice = &wrapped_welcome.lines[scroll_top..(scroll_top + max_visible_welcome).min(total_w_lines)];
            for (i, line) in visible_slice.iter().enumerate() {
                let l_idx = scroll_top + i;
                let prefix = if l_idx == 0 {
                    Span::styled("> ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD))
                } else {
                    Span::raw("  ")
                };
                let mut spans = vec![prefix];
                spans.extend(crate::ui::input::render_line_spans(line, Theme::SKY, cursor_visible));
                bot_lines.push(Line::from(spans));
            }
        } else {
            if input.is_empty() {
                let mut spans = vec![
                    Span::styled("> ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD)),
                    Span::styled(
                        "Type a message or / for commands...",
                        Style::default().fg(Theme::TEXT_MUTED),
                    ),
                ];
                spans.push(if cursor_visible {
                    Span::styled("█", Style::default().fg(Theme::SKY))
                } else {
                    Span::raw(" ")
                });
                bot_lines.push(Line::from(spans));
            } else {
                let total_w_lines = wrapped_welcome.lines.len();
                let scroll_top = if wrapped_welcome.cursor_line >= max_visible_welcome {
                    wrapped_welcome.cursor_line + 1 - max_visible_welcome
                } else {
                    0
                };
                let visible_slice = &wrapped_welcome.lines[scroll_top..(scroll_top + max_visible_welcome).min(total_w_lines)];
                for (i, line) in visible_slice.iter().enumerate() {
                    let l_idx = scroll_top + i;
                    let prefix = if l_idx == 0 {
                        Span::styled("> ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD))
                    } else {
                        Span::raw("  ")
                    };
                    let mut spans = vec![prefix];
                    spans.extend(crate::ui::input::render_line_spans(line, Theme::SKY, cursor_visible));
                    bot_lines.push(Line::from(spans));
                }
            }
        }

        f.render_widget(Paragraph::new(bot_lines), bot_inner);
    }

    // 4. Status Bar / Footer
    let footer_y = bot_y + bot_h;
    if footer_y < area.height {
        let left_text = if is_dropdown_open {
            "↑/↓ to navigate • Enter to select • Esc to dismiss"
        } else {
            "Press Enter to submit • Esc to exit"
        };
        let left_span = Span::styled(left_text, Style::default().fg(Theme::TEXT_MUTED));

        let (right_spans, right_len) = if let Some(msg) = status_message {
            (
                vec![Span::styled(
                    msg.to_string(),
                    Style::default().fg(Theme::ACTIVITY),
                )],
                msg.len(),
            )
        } else if let Some(cfg) = active_config {
            let text = format!("✓ Connected: {} ({})", cfg.provider, cfg.model);
            (
                vec![
                    Span::styled("✓ ", Style::default().fg(Theme::SUCCESS)),
                    Span::styled("Connected: ", Style::default().fg(Theme::TEXT_MUTED)),
                    Span::styled(&cfg.provider, Style::default().fg(Theme::MODEL)),
                    Span::styled(" (", Style::default().fg(Theme::TEXT_MUTED)),
                    Span::styled(&cfg.model, Style::default().fg(Theme::MODEL)),
                    Span::styled(")", Style::default().fg(Theme::TEXT_MUTED)),
                ],
                text.len(),
            )
        } else {
            (
                vec![Span::styled(
                    "No model connected (/model)",
                    Style::default().fg(Theme::TEXT_MUTED),
                )],
                "No model connected (/model)".len(),
            )
        };

        let footer_pad = (card_width as usize).saturating_sub(left_text.len() + right_len);
        let mut footer_spans = vec![left_span];
        footer_spans.push(Span::raw(" ".repeat(footer_pad)));
        footer_spans.extend(right_spans);

        f.render_widget(
            Paragraph::new(Line::from(footer_spans)),
            Rect::new(start_x, footer_y, card_width, 1),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_commands_have_valid_icons() {
        for cmd in COMMANDS {
            assert!(!cmd.name.is_empty(), "command name must not be empty");
            assert!(cmd.name.starts_with('/'), "command name must start with /");
            assert!(!cmd.icon.is_empty(), "command icon must not be empty");
            assert!(!cmd.description.is_empty(), "description must not be empty");
        }
    }

    #[test]
    fn test_commands_filter_prefix() {
        let matching: Vec<&CommandItem> = COMMANDS.iter().filter(|c| c.name.starts_with("/m")).collect();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].name, "/model");
        assert_eq!(matching[0].icon, "✦");
    }
}

