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
use super::text::{fitted, scrolled};
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

/// Draw the prompt in `area`, centred, and report where the caret goes. `None` when the area is
/// too small to hold the box, or too narrow for the line inside it.
pub fn draw(
    buffer: &mut Buffer,
    area: Rect,
    prompt: &Prompt,
    palette: &Palette,
) -> Option<(u16, u16)> {
    let column = centred(area);
    // Measured rather than assumed to be two cells: a terminal that draws `❯` wide would
    // otherwise put the caret a column out.
    let marker = MARKER.width() as u16;
    // Too narrow for a marker and a line, or too short for the border: the box is all or nothing.
    if column.width < marker + 2 || column.height < HEIGHT {
        return None;
    }
    let block = Block::bordered().border_style(Style::default().fg(palette.border_strong));
    let inner = block.inner(column);
    block.render(column, buffer);

    // The tag rides the top border, as the site's badge does.
    badge::draw(buffer, column, TAG, palette);

    // One column stays free at the end of the line, because that is where a terminal puts the
    // caret once the text fills the rest.
    let text_x = inner.x + marker;
    let usable = inner.width.saturating_sub(marker + 1) as usize;

    buffer.set_string(inner.x, inner.y, MARKER, Style::default().fg(palette.brand));
    let (caret_x, text, ink) = if prompt.text().is_empty() {
        (text_x, fitted(PLACEHOLDER, usable), palette.text_muted)
    } else {
        let (text, offset) = scrolled(prompt.text(), prompt.before_caret(), usable);
        (text_x + offset, text, palette.text)
    };
    buffer.set_string(text_x, inner.y, text, Style::default().fg(ink));
    Some((caret_x, inner.y))
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
        height: area.height.min(HEIGHT),
    }
}
