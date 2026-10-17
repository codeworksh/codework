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
use super::markdown;
use super::menu;
use super::text::{self, elide, fitted, wrap};
use crate::app::{App, Popup, TurnState};
use crate::diff::{self, DEFAULT_MAX_DIFF_LINES};
use crate::tool::{self, ToolRow, ToolStatus};

const IDLE_HINTS: &str = "enter send · ↑↓/wheel scroll · / commands · esc quit";
const BUSY_HINTS: &str = "↑↓/wheel scroll · / commands · esc interrupt";
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

    // Responsive horizontal padding: 1 column on narrow terminals (< 44 cols), 2 otherwise.
    let pad = if area.width < 44 { 1 } else { 2 };
    let column = Rect {
        x: area.x + pad,
        y: area.y,
        width: area.width.saturating_sub(pad * 2),
        height: area.height,
    };

    draw_header(
        app,
        frame,
        Rect {
            y: header.y,
            height: 1,
            ..column
        },
    );
    draw_rule(frame, rule, palette.border_subtle);
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

    let prompt_box = Rect {
        x: column.x,
        y: prompt.y,
        width: column.width,
        height: prompt.height,
    };
    let prompt_caret = input::draw_in(frame.buffer_mut(), prompt_box, &app.prompt, palette);
    let mut menu_caret = None;

    if let Some(popup) = &app.popup {
        let searchable = popup.search().is_some();
        let wanted = menu::height(popup.menu(), searchable);
        let room = prompt_box.y.saturating_sub(body.y);
        let height = wanted.min(room);
        let width = menu::width(popup.menu(), searchable).min(column.width);
        let picker = Rect {
            x: column.x,
            y: prompt_box.y.saturating_sub(height),
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
    if let Some(thinking) = app.thinking_label() {
        if thinking != "off" {
            meta.push_str(" · ");
            meta.push_str(&thinking);
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
    let fitted_title = fitted(title, title_room);
    buffer.set_string(
        area.x + 2,
        area.y,
        fitted_title,
        Style::default().fg(palette.text),
    );

    // On wider terminals, show the session's working directory beside its title.
    if area.width >= 64 {
        if let Some(session) = &app.session {
            let dir = session.host_dir.as_deref().unwrap_or(&session.directory);
            let title_cols = text::width(fitted_title) as u16;
            let dir_x = area.x + 2 + title_cols + 2;
            if dir_x + 8 < right_x {
                let dir_room = right_x.saturating_sub(dir_x) as usize;
                buffer.set_string(
                    dir_x,
                    area.y,
                    fitted(dir, dir_room),
                    Style::default().fg(palette.text_muted),
                );
            }
        }
    }
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

        // Tool calls (grouped when 3+ identical non-diff calls settle in a row)
        for row in tool::group(&turn.tools) {
            match row {
                ToolRow::Single(tool) => {
                    if let Some(patch) = &tool.patch {
                        let counts = diff::counts(patch);
                        let path = tool
                            .target
                            .clone()
                            .or_else(|| diff::patch_path(patch))
                            .unwrap_or_else(|| tool.name.clone());
                        let spans = vec![
                            Span::styled("  ← ", Style::default().fg(palette.brand)),
                            Span::styled("Edit ", Style::default().fg(palette.text)),
                            Span::styled(path, Style::default().fg(palette.text_secondary)),
                            Span::styled(" (", Style::default().fg(palette.text_muted)),
                            Span::styled(
                                format!("+{}", counts.added),
                                Style::default().fg(palette.success()),
                            ),
                            Span::raw(" "),
                            Span::styled(
                                format!("-{}", counts.removed),
                                Style::default().fg(palette.error()),
                            ),
                            Span::styled(")", Style::default().fg(palette.text_muted)),
                        ];
                        lines.push(Line::from(spans));

                        let diff_width = wrap_width.saturating_sub(4).max(16);
                        let (diff_lines, _) =
                            diff::render_diff(patch, diff_width, DEFAULT_MAX_DIFF_LINES, palette);
                        for mut dline in diff_lines {
                            dline.spans.insert(0, Span::raw("    "));
                            lines.push(dline);
                        }
                        continue;
                    }

                    let (icon, icon_color) = match tool.status {
                        ToolStatus::Running => ("  ⚙ ", palette.brand),
                        ToolStatus::Completed => ("  ✓ ", palette.success()),
                        ToolStatus::Failed => ("  ✗ ", palette.error()),
                    };
                    let mut spans = vec![
                        Span::styled(icon, Style::default().fg(icon_color)),
                        Span::styled(tool.name.clone(), Style::default().fg(palette.text)),
                    ];
                    let mut used = 4 + text::width(&tool.name);
                    if let Some(target) = &tool.target {
                        let room = wrap_width.saturating_sub(used + 1);
                        if room > 4 {
                            let shown = elide(target, room);
                            used += 1 + text::width(&shown);
                            spans.push(Span::styled(
                                format!(" {shown}"),
                                Style::default().fg(palette.text_secondary),
                            ));
                        }
                    }
                    if let Some(summary) = &tool.summary {
                        let room = wrap_width.saturating_sub(used + 3);
                        if room > 4 {
                            let shown = elide(summary, room);
                            spans.push(Span::styled(
                                format!(" · {shown}"),
                                Style::default().fg(if tool.status == ToolStatus::Failed {
                                    palette.error()
                                } else {
                                    palette.text_muted
                                }),
                            ));
                        }
                    }
                    lines.push(Line::from(spans));

                    if tool.status == ToolStatus::Failed {
                        if let Some(output) = &tool.output {
                            for err_line in output.lines().take(3) {
                                lines.push(Line::from(vec![
                                    Span::raw("    "),
                                    Span::styled(
                                        elide(err_line, wrap_width.saturating_sub(2)),
                                        Style::default().fg(palette.error()),
                                    ),
                                ]));
                            }
                        }
                    }
                }
                ToolRow::Run {
                    name,
                    members,
                    failed,
                } => {
                    let (icon, icon_color) = if failed > 0 {
                        ("  ✗ ", palette.error())
                    } else {
                        ("  ✓ ", palette.success())
                    };
                    let heading = format!("{name} ×{}", members.len());
                    let targets = tool::run_targets(&members);
                    let room = wrap_width.saturating_sub(4 + text::width(&heading) + 3);
                    let mut spans = vec![
                        Span::styled(icon, Style::default().fg(icon_color)),
                        Span::styled(heading, Style::default().fg(palette.text)),
                    ];
                    if !targets.is_empty() && room > 4 {
                        spans.push(Span::styled(
                            format!(" · {}", elide(&targets, room)),
                            Style::default().fg(palette.text_muted),
                        ));
                    }
                    if failed > 0 {
                        spans.push(Span::styled(
                            format!(" · {failed} failed"),
                            Style::default().fg(palette.error()),
                        ));
                    }
                    lines.push(Line::from(spans));
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
                    Span::styled(prefix, Style::default().fg(palette.warning())),
                    Span::styled(chunk, Style::default().fg(palette.text_secondary)),
                ]));
            }
        }

        // Assistant response (markdown)
        if !turn.text.is_empty() {
            lines.push(Line::default());
            for mut md_line in markdown::render(turn.text.trim_end(), wrap_width, palette) {
                md_line.spans.insert(0, Span::raw("  "));
                lines.push(md_line);
            }
        }

        // Turn status
        match &turn.state {
            TurnState::Running => {
                if app.reconnecting {
                    lines.push(Line::from(Span::styled(
                        "  ◌ reconnecting to server...",
                        Style::default().fg(palette.warning()),
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
                        Span::styled(prefix, Style::default().fg(palette.error())),
                        Span::styled(chunk, Style::default().fg(palette.error())),
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

    let total_lines = lines.len();
    let visible = area.height as usize;
    let max_scroll = total_lines.saturating_sub(visible);
    app.max_scroll.set(max_scroll);
    let scroll_from_bottom = app.scroll.min(max_scroll);
    let start = max_scroll.saturating_sub(scroll_from_bottom);
    let slice: Vec<Line<'static>> = lines.into_iter().skip(start).take(visible).collect();

    let text_area = if max_scroll > 0 {
        Rect {
            width: area.width.saturating_sub(2),
            ..area
        }
    } else {
        area
    };
    frame.render_widget(Paragraph::new(slice), text_area);

    if max_scroll > 0 {
        draw_scrollbar(frame, area, total_lines, visible, start, app.theme);
    }
}

fn draw_scrollbar(
    frame: &mut Frame,
    area: Rect,
    total_lines: usize,
    visible: usize,
    start: usize,
    palette: &crate::theme::Palette,
) {
    if area.height == 0 || total_lines <= visible {
        return;
    }
    let track_h = area.height as usize;
    let thumb_h = ((visible * track_h) / total_lines).clamp(1, track_h);
    let max_start = total_lines.saturating_sub(visible);
    let max_thumb_top = track_h.saturating_sub(thumb_h);
    let thumb_top = if max_start == 0 {
        0
    } else {
        (start * max_thumb_top + (max_start / 2)) / max_start
    };

    let x = area.right().saturating_sub(1);
    let buffer = frame.buffer_mut();
    let track_style = Style::default().fg(palette.border_subtle);
    let thumb_style = Style::default().fg(palette.brand);

    for row in 0..track_h {
        let y = area.y + row as u16;
        if row >= thumb_top && row < thumb_top + thumb_h {
            buffer[(x, y)].set_char('┃').set_style(thumb_style);
        } else {
            buffer[(x, y)].set_char('│').set_style(track_style);
        }
    }
}
