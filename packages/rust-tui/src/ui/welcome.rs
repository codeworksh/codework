use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use crate::types::ModelConfig;
use crate::ui::session::render_input_with_cursor;
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
        icon_color: Color::Rgb(6, 182, 212), // Cyan #06b6d4
    },
    CommandItem {
        name: "/clear",
        icon: "↺",
        description: "Clear conversation history and screen",
        icon_color: Color::Rgb(250, 204, 21), // Yellow #facc15
    },
    CommandItem {
        name: "/model",
        icon: "✦",
        description: "Switch or view active LLM model",
        icon_color: Color::Rgb(192, 132, 252), // Purple #c084fc
    },
    CommandItem {
        name: "/session",
        icon: "◷",
        description: "List or resume recent sessions",
        icon_color: Color::Rgb(129, 140, 248), // Indigo #818cf8
    },
    CommandItem {
        name: "/compact",
        icon: "⇥",
        description: "Compact current conversation context",
        icon_color: Color::Rgb(16, 185, 129), // Green #10b981
    },
    CommandItem {
        name: "/exit",
        icon: "✕",
        description: "Exit CodeWork TUI",
        icon_color: Color::Rgb(248, 113, 113), // Red #f87171
    },
];

const LOGO_GRADIENT: [Color; 9] = [
    Color::Rgb(236, 72, 153), // #ec4899 - Pink
    Color::Rgb(217, 70, 239), // #d946ef - Magenta
    Color::Rgb(192, 132, 252), // #c084fc - Purple
    Color::Rgb(168, 85, 247), // #a855f7 - Violet
    Color::Rgb(129, 140, 248), // #818cf8 - Indigo
    Color::Rgb(99, 102, 241),  // #6366f1 - Blue
    Color::Rgb(56, 189, 248),  // #38bdf8 - Sky
    Color::Rgb(6, 182, 212),   // #06b6d4 - Cyan
    Color::Rgb(34, 211, 238),  // #22d3ee - Light Cyan
];

const LOGO_LINES: [&str; 5] = [
    "▄██████▄  ▄██   ▄██▄",
    "██▀       ███   ████",
    "██        ███ █ ████",
    "██▄       ██████████",
    "▀██████▀   ▀█▀   ▀█▀",
];

pub fn render_welcome(
    f: &mut Frame,
    area: Rect,
    input: &str,
    cursor_pos: usize,
    dropdown_index: usize,
    active_config: Option<&ModelConfig>,
    status_message: Option<&str>,
) {
    let card_width = 78u16.min(area.width.saturating_sub(2));
    let is_dropdown_open = input.starts_with('/') && !input.contains(' ');

    let matching_cmds: Vec<&CommandItem> = if is_dropdown_open {
        COMMANDS
            .iter()
            .filter(|cmd| cmd.name.starts_with(input))
            .collect()
    } else {
        Vec::new()
    };

    // Calculate Card 2 (Bottom Card) height
    let card2_height = if is_dropdown_open {
        let rows = matching_cmds.len().max(1) as u16;
        // 1 (top border) + 1 (header "Commands") + rows + 1 (empty line) + 1 (input line) + 1 (bottom border)
        5 + rows
    } else {
        3
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
        .border_style(Style::default().fg(Theme::BORDER));
    f.render_widget(top_block, top_rect);

    if top_h >= 5 {
        let inner_w = card_width.saturating_sub(2);
        let inner_x = start_x + 1;
        let inner_y = start_y + 1;

        // Header bar inside card
        let left_part = "codework v0.0.1";
        let right_part = "open-source harness";
        let header_pad = (inner_w as usize).saturating_sub(left_part.len() + right_part.len());

        let header_line = Line::from(vec![
            Span::styled(
                "codework ",
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
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
            Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
        )));
        left_lines.push(Line::from(Span::styled(
            "Coding Agent Harness",
            Style::default().fg(Theme::ACCENT),
        )));
        left_lines.push(Line::raw(""));

        // Logo with gradient
        for line in LOGO_LINES {
            let chars: Vec<char> = line.chars().collect();
            let mut spans = Vec::new();
            for (col_idx, &ch) in chars.iter().enumerate() {
                let color_idx = ((col_idx as f32 / chars.len() as f32) * LOGO_GRADIENT.len() as f32) as usize;
                let color = LOGO_GRADIENT[color_idx.min(LOGO_GRADIENT.len() - 1)];
                spans.push(Span::styled(ch.to_string(), Style::default().fg(color)));
            }
            left_lines.push(Line::from(spans));
        }

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
            .border_style(Style::default().fg(bot_border_color));
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

            let mut input_spans = vec![
                Span::styled("> ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD)),
            ];
            input_spans.extend(render_input_with_cursor(input, cursor_pos));
            bot_lines.push(Line::from(input_spans));
        } else {
            if input.is_empty() {
                bot_lines.push(Line::from(vec![
                    Span::styled("> ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD)),
                    Span::styled(
                        "Type a message or / for commands...",
                        Style::default().fg(Theme::TEXT_MUTED),
                    ),
                    Span::styled("█", Style::default().fg(Theme::SKY)),
                ]));
            } else {
                let mut input_spans = vec![
                    Span::styled("> ", Style::default().fg(Theme::SKY).add_modifier(Modifier::BOLD)),
                ];
                input_spans.extend(render_input_with_cursor(input, cursor_pos));
                bot_lines.push(Line::from(input_spans));
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

