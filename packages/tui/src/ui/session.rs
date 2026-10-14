//! The session screen: header, streaming transcript, and prompt composer.
//!
//! Pure, like the welcome screen: it reads `App` and paints into the frame's buffer without
//! mutating state or performing I/O.

use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use super::input;
use super::menu;
use super::text::{self, fitted};
use crate::app::{App, Popup, ToolStatus, TurnState};

const IDLE_HINTS: &str = "enter send · pgup/pgdn scroll · / commands · esc quit";
const BUSY_HINTS: &str = "pgup/pgdn scroll · / commands · esc interrupt";
const COMMAND_HINTS: &str = "↑↓ move · enter choose · esc close";
const SEARCH_HINTS: &str = "↑↓ move · type to search · enter choose · esc close";

pub fn draw(app: &App, frame: &mut Frame) {
    let area = frame.area();
    let palette = app.theme;

    frame.render_widget(
        Block::default().style(Style::default().bg(palette.bg)),
        area,
    );

    if area.height < 6 || area.width < 16 {
        return;
    }

    let [header, rule, body, prompt, hint] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(input::HEIGHT),
        Constraint::Length(1),
    ])
    .areas(area);

    let column = input::centred(Rect {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
    });

    draw_header(app, frame, Rect { y: header.y, height: 1, ..column });
    draw_rule(frame, Rect { y: rule.y, height: 1, ..column }, palette.border_subtle);
    draw_transcript(
        app,
        frame,
        Rect {
            x: column.x,
            y: body.y,
            width: column.width,
            height: body.height,
        },
    );

    let prompt_caret = input::draw(frame.buffer_mut(), prompt, &app.prompt, palette);
    let mut menu_caret = None;

    if let Some(popup) = &app.popup {
        let searchable = popup.search().is_some();
        let wanted = menu::height(popup.menu(), searchable);
        let room = prompt.y.saturating_sub(body.y);
        let height = wanted.min(room);
        let width =
            menu::width(popup.menu(), searchable).min(area.right().saturating_sub(column.x));
        let picker = Rect {
            x: column.x,
            y: prompt.y.saturating_sub(height),
            width,
            height,
        };
        menu_caret = menu::draw(
            frame.buffer_mut(),
            picker,
            popup.title(),
            popup.menu(),
            popup.search(),
            palette,
        );
    }

    if let Some(caret) = menu_caret.or(prompt_caret) {
        frame.set_cursor_position(caret);
    }

    let hints = match (&app.notice, &app.popup) {
        (Some(notice), _) => notice.as_str(),
        (None, Some(Popup::Commands(_) | Popup::Thinking(_))) => COMMAND_HINTS,
        (None, Some(Popup::Themes { .. } | Popup::Models { .. } | Popup::Sessions { .. })) => {
            SEARCH_HINTS
        }
        (None, None) if app.busy => BUSY_HINTS,
        (None, None) => IDLE_HINTS,
    };

    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            hints,
            Style::default().fg(palette.text_muted),
        )))
        .alignment(Alignment::Center),
        hint,
    );
}

fn draw_header(app: &App, frame: &mut Frame, area: Rect) {
    let palette = app.theme;
    let buffer = frame.buffer_mut();

    let title = app
        .session
        .as_ref()
        .map(|s| s.title.as_str())
        .filter(|t| !t.is_empty())
        .unwrap_or("session");

    let mut meta = app.model_label();
    if let Some(thinking) = &app.thinking {
        if thinking != "off" {
            meta.push_str(" · ");
            meta.push_str(thinking);
        }
    }
    if app.usage.total_tokens > 0 {
        meta.push_str(&format!(
            " · {} tok · ${:.4}",
            app.usage.total_tokens, app.usage.cost
        ));
    }

    let meta_width = text::width(&meta) as u16;
    let right_x = if meta_width + 6 <= area.width {
        let x = area.right() - meta_width;
        buffer.set_string(x, area.y, &meta, Style::default().fg(palette.text_muted));
        x.saturating_sub(2)
    } else {
        area.right()
    };

    buffer.set_string(area.x, area.y, "● ", Style::default().fg(palette.brand));
    let title_room = right_x.saturating_sub(area.x + 2) as usize;
    buffer.set_string(
        area.x + 2,
        area.y,
        fitted(title, title_room),
        Style::default().fg(palette.text),
    );
}

fn draw_rule(frame: &mut Frame, area: Rect, color: ratatui::style::Color) {
    let buffer = frame.buffer_mut();
    let style = Style::default().fg(color);
    for x in area.x..area.right() {
        buffer[(x, area.y)].set_char('─').set_style(style);
    }
}

fn draw_transcript(app: &App, frame: &mut Frame, area: Rect) {
    if area.height == 0 || area.width < 6 {
        return;
    }

    let palette = app.theme;
    let wrap_width = area.width.saturating_sub(2) as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();

    for (idx, turn) in app.turns.iter().enumerate() {
        if idx > 0 {
            lines.push(Line::default());
        }

        // User prompt
        for (line_idx, chunk) in wrap(&turn.prompt, wrap_width).into_iter().enumerate() {
            let prefix = if line_idx == 0 { "❯ " } else { "  " };
            lines.push(Line::from(vec![
                Span::styled(prefix, Style::default().fg(palette.brand)),
                Span::styled(chunk, Style::default().fg(palette.text)),
            ]));
        }

        // Reasoning / thinking
        if !turn.thinking.is_empty() {
            for (line_idx, chunk) in wrap(turn.thinking.trim(), wrap_width.saturating_sub(2))
                .into_iter()
                .enumerate()
            {
                let prefix = if line_idx == 0 { "  ◌ " } else { "    " };
                lines.push(Line::from(vec![
                    Span::styled(prefix, Style::default().fg(palette.text_muted)),
                    Span::styled(chunk, Style::default().fg(palette.text_muted)),
                ]));
            }
        }

        // Tool calls
        for tool in &turn.tools {
            let (icon, icon_color) = match tool.status {
                ToolStatus::Running => ("  ⚙ ", palette.brand),
                ToolStatus::Completed => ("  ✓ ", palette.brand),
                ToolStatus::Failed => ("  ✗ ", palette.field_crest),
            };
            let room = wrap_width.saturating_sub(text::width(&tool.name) + 3);
            let detail = if tool.summary.is_empty() || room == 0 {
                String::new()
            } else {
                format!(" {}", fitted(&tool.summary, room))
            };
            lines.push(Line::from(vec![
                Span::styled(icon, Style::default().fg(icon_color)),
                Span::styled(tool.name.clone(), Style::default().fg(palette.text_secondary)),
                Span::styled(detail, Style::default().fg(palette.text_muted)),
            ]));
            if tool.status == ToolStatus::Failed {
                if let Some(output) = &tool.output {
                    if let Some(first_line) = output.lines().next() {
                        lines.push(Line::from(vec![
                            Span::raw("    "),
                            Span::styled(
                                fitted(first_line, wrap_width.saturating_sub(2)).to_string(),
                                Style::default().fg(palette.field_crest),
                            ),
                        ]));
                    }
                }
            }
        }

        // Plugin / runtime notices
        for notice in &turn.notices {
            for (line_idx, chunk) in wrap(notice, wrap_width.saturating_sub(2))
                .into_iter()
                .enumerate()
            {
                let prefix = if line_idx == 0 { "  ⚠ " } else { "    " };
                lines.push(Line::from(vec![
                    Span::styled(prefix, Style::default().fg(palette.field_hover)),
                    Span::styled(chunk, Style::default().fg(palette.text_secondary)),
                ]));
            }
        }

        // Assistant response
        if !turn.text.is_empty() {
            lines.push(Line::default());
            for chunk in wrap(turn.text.trim_end(), wrap_width) {
                lines.push(Line::from(vec![
                    Span::raw("  "),
                    Span::styled(chunk, Style::default().fg(palette.text)),
                ]));
            }
        }

        // Turn status
        match &turn.state {
            TurnState::Running => {
                if app.reconnecting {
                    lines.push(Line::from(Span::styled(
                        "  ◌ reconnecting to server...",
                        Style::default().fg(palette.field_hover),
                    )));
                } else if turn.text.is_empty() && turn.thinking.is_empty() && turn.tools.is_empty()
                {
                    lines.push(Line::from(Span::styled(
                        "  ● thinking...",
                        Style::default().fg(palette.brand),
                    )));
                }
            }
            TurnState::Succeeded => {}
            TurnState::Failed(err) => {
                for (line_idx, chunk) in wrap(err, wrap_width.saturating_sub(2))
                    .into_iter()
                    .enumerate()
                {
                    let prefix = if line_idx == 0 { "  ✗ " } else { "    " };
                    lines.push(Line::from(vec![
                        Span::styled(prefix, Style::default().fg(palette.field_crest)),
                        Span::styled(chunk, Style::default().fg(palette.field_crest)),
                    ]));
                }
            }
            TurnState::Interrupted(reason) => {
                lines.push(Line::from(Span::styled(
                    format!("  ○ interrupted ({reason})"),
                    Style::default().fg(palette.text_muted),
                )));
            }
        }
    }

    let visible = area.height as usize;
    let max_scroll = lines.len().saturating_sub(visible);
    let scroll_from_bottom = app.scroll.min(max_scroll);
    let start = max_scroll.saturating_sub(scroll_from_bottom);
    let slice: Vec<Line<'static>> = lines.into_iter().skip(start).take(visible).collect();

    frame.render_widget(Paragraph::new(slice), area);
}

/// Wrap `text` into lines that fit within `max_width` terminal columns.
fn wrap(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for raw_line in text.split('\n') {
        if raw_line.is_empty() {
            out.push(String::new());
            continue;
        }
        let mut current = String::new();
        let mut current_width = 0usize;
        for word in raw_line.split_whitespace() {
            let word_width = text::width(word);
            if current.is_empty() {
                if word_width <= max_width {
                    current.push_str(word);
                    current_width = word_width;
                } else {
                    let mut rest = word;
                    while !rest.is_empty() {
                        let part = fitted(rest, max_width);
                        if part.is_empty() {
                            break;
                        }
                        out.push(part.to_string());
                        rest = &rest[part.len()..];
                    }
                }
            } else if current_width + 1 + word_width <= max_width {
                current.push(' ');
                current.push_str(word);
                current_width += 1 + word_width;
            } else {
                out.push(current);
                current = word.to_string();
                current_width = word_width;
            }
        }
        if !current.is_empty() {
            out.push(current);
        }
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}
