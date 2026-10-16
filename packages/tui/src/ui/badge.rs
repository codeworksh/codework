//! The tag a box clips to its top border.
//!
//! The site pins an `alpha` badge to the install box's top border, and the prompt box and every
//! menu wear the same badge. It is written on the border row itself rather than inside it: that row
//! belongs to the border, so the tag stands on the canvas the way the line does.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;

use super::text;
use crate::theme::Palette;

/// Draw `label` as a tag on the top border of `area`, inset from its right corner, in the accent
/// ink. The cells either side of the label are written with it, because they are part of the tag:
/// they clear the border line underneath.
pub fn draw(buffer: &mut Buffer, area: Rect, label: &str, palette: &Palette) {
    draw_right(buffer, area, label, Style::default().fg(palette.brand));
}

/// Draw `label` as a tag on the top border of `area`, inset from its left corner.
pub fn draw_left(buffer: &mut Buffer, area: Rect, label: &str, ink: Style) {
    let width = text::width(label) as u16 + 2;
    if width + 4 > area.width {
        return;
    }
    let at = area.x + 2;
    write_tag(buffer, at, area.y, width, label, ink);
}

/// Draw `label` as a tag on the top border of `area`, inset from its right corner.
pub fn draw_right(buffer: &mut Buffer, area: Rect, label: &str, ink: Style) {
    let width = text::width(label) as u16 + 2;
    // The inset is the site's, and a border too short for the tag keeps its line rather than
    // wearing half a label.
    if width + 2 > area.width {
        return;
    }
    let at = area.right() - width - 2;
    write_tag(buffer, at, area.y, width, label, ink);
}

fn write_tag(buffer: &mut Buffer, at: u16, y: u16, width: u16, label: &str, ink: Style) {
    buffer.set_string(at, y, " ", ink);
    buffer.set_string(at + 1, y, label, ink);
    buffer.set_string(at + width - 1, y, " ", ink);
}
