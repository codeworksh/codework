//! The prompt line.
//!
//! The site puts its install command in a bordered box under the hero copy, and the prompt takes
//! that place and that box: the same `max-w-xl` width, the same strong outline, the same `alpha`
//! tag on the top border. It is only an outline — the site fills its box with a card surface, and
//! a terminal cannot: the fill would sit on half-cells the border does not cover, so the box stands
//! open on the canvas and the lattice runs through it like it does through the word's gaps.
//!
//! It draws the line and *reports* the cell the caret belongs in instead of painting a block
//! there. The terminal's own cursor blinks, sits at the right height to be an input method's
//! anchor, and costs one call.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::{Block, Widget};
use unicode_width::UnicodeWidthStr;

use super::badge;
use super::text::fitted;
use crate::prompt::Prompt;
use crate::theme::Palette;

/// The box's own width — the site's `max-w-xl`, an about-72-cell column — and one line inside a
/// border.
pub const WIDTH: u16 = 72;
pub const HEIGHT: u16 = 3;

/// What opens the line, in the accent ink. Not the site's `$`: that one introduces a shell
/// command, and this one introduces a prompt.
const MARKER: &str = "❯ ";
/// What an empty line shows: the example the site gives for its own CLI.
const PLACEHOLDER: &str = "build me flappy bird";
/// The tag the site clips to the box's top border, because this TUI is at the same stage the CLI
/// is.
const TAG: &str = "alpha";

/// Draw the prompt in `area`, centred to [`WIDTH`], and report where the caret goes.
pub fn draw(
    buffer: &mut Buffer,
    area: Rect,
    prompt: &Prompt,
    palette: &Palette,
) -> Option<(u16, u16)> {
    draw_in(buffer, centred(area), prompt, palette)
}

/// Draw the prompt filling `column` directly, and report where the caret goes. `None` when
/// `column` is too small to hold the box or too narrow for the line inside it.
pub fn draw_in(
    buffer: &mut Buffer,
    column: Rect,
    prompt: &Prompt,
    palette: &Palette,
) -> Option<(u16, u16)> {
    let marker = MARKER.width() as u16;
    if column.width < marker + 4 || column.height < HEIGHT {
        return None;
    }
    let block = Block::bordered().border_style(Style::default().fg(palette.border_strong));
    let inner = block.inner(column);
    block.render(column, buffer);
    badge::draw(buffer, column, TAG, palette);
    let usable = inner.width.saturating_sub(marker + 1) as usize;
    let layout = prompt.layout(usable);
    let start = layout
        .caret
        .1
        .saturating_sub(inner.height.saturating_sub(1) as usize);
    for row in 0..inner.height {
        for x in inner.x..inner.right() {
            buffer[(x, inner.y + row)].set_char(' ');
        }
        let at = start + row as usize;
        if let Some(line) = layout.lines.get(at) {
            buffer.set_string(
                inner.x,
                inner.y + row,
                if at == 0 { MARKER } else { "· " },
                Style::default().fg(palette.brand),
            );
            if prompt.text().is_empty() {
                buffer.set_string(
                    inner.x + marker,
                    inner.y + row,
                    fitted(PLACEHOLDER, usable),
                    Style::default().fg(palette.text_muted),
                );
            } else {
                buffer.set_string(
                    inner.x + marker,
                    inner.y + row,
                    line,
                    Style::default().fg(palette.text),
                );
            }
        }
    }
    Some((
        inner.x + marker + layout.caret.0 as u16,
        inner.y + (layout.caret.1 - start) as u16,
    ))
}

/// Grow to six visible text rows, then scroll the composer to keep its caret visible.
pub fn height(prompt: &Prompt, width: u16, available: u16) -> u16 {
    let usable = width.saturating_sub(MARKER.width() as u16 + 3) as usize;
    (prompt.layout(usable).lines.len().clamp(1, 6) as u16 + 2).min(available.max(HEIGHT))
}

/// The box's own rect: [`WIDTH`] wide and centred in `area`, and no larger than it.
///
/// A menu under the prompt anchors itself on this, so it opens flush with the box's left edge
/// rather than centred under the middle of the line.
pub fn centred(area: Rect) -> Rect {
    let width = WIDTH.min(area.width);
    Rect {
        x: area.x + (area.width - width) / 2,
        y: area.y,
        width,
        height: area.height,
    }
}
