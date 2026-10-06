use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

use crate::ui::theme::{self, Theme};

/// The `/theme` picker: a centered overlay listing all 6 palettes. Moving the
/// cursor switches the live palette, so the entire UI recolors behind it as a
/// preview before you commit with Enter.
pub fn render_theme_picker(f: &mut Frame, area: Rect, cursor: usize) {
    let palettes = theme::PALETTES;
    let width = 46u16.min(area.width.saturating_sub(4));
    let height = (palettes.len() as u16 + 6).min(area.height.saturating_sub(2));
    if width == 0 || height < 3 {
        return;
    }

    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    let rect = Rect::new(x, y, width, height);

    f.render_widget(Clear, rect);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Theme::border_active()))
        .title(Span::styled(
            " Theme ",
            Style::default()
                .fg(Theme::border_active())
                .add_modifier(Modifier::BOLD),
        ))
        .title_bottom(Span::styled(
            " ↑/↓ preview • Enter apply • Esc revert ",
            Style::default().fg(Theme::text_muted()),
        ))
        .style(Style::default().bg(Theme::bg_surface()));
    f.render_widget(block, rect);

    let inner = Rect::new(x + 1, y + 1, width.saturating_sub(2), height.saturating_sub(2));
    let mut lines = Vec::with_capacity(palettes.len() + 1);
    lines.push(Line::from(""));

    for (idx, palette) in palettes.iter().enumerate() {
        let is_selected = idx == cursor;
        let is_active = idx == theme::active_index();

        let cursor_span = if is_selected {
            Span::styled(
                "▶ ",
                Style::default()
                    .fg(Theme::border_active())
                    .add_modifier(Modifier::BOLD),
            )
        } else {
            Span::raw("  ")
        };

        // A two-cell swatch in the palette's own background gives an at-a-glance
        // preview even for themes that only differ in subtle tones.
        let swatch = Span::styled("  ", Style::default().bg(palette.bg_app));
        let mode_tag = if palette.dark { "dark" } else { "light" };

        let name_style = if is_selected {
            Style::default()
                .fg(Theme::text_primary())
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Theme::text_secondary())
        };

        lines.push(Line::from(vec![
            cursor_span,
            swatch,
            Span::raw(" "),
            Span::styled(format!("{:<18}", palette.label), name_style),
            Span::styled(
                format!("({mode_tag})"),
                Style::default().fg(Theme::text_muted()),
            ),
            Span::raw("  "),
            Span::styled(
                if is_active { "● current" } else { "" },
                Style::default()
                    .fg(Theme::success())
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
    }

    f.render_widget(Paragraph::new(lines), inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_palettes_available_for_picker() {
        assert_eq!(theme::PALETTES.len(), 6);
        assert_eq!(theme::PALETTES[0].id, "catppuccin-mocha");
    }
}
