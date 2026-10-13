//! The CodeWork wordmark, drawn on the site's pixel grid.
//!
//! The site's glyph cells are square, but a terminal cell is about twice as tall as it is wide.
//! Pairing two glyph rows into the upper and lower half of one block character gives each glyph
//! cell a square terminal cell, so the wordmark keeps its proportions at 1:1 — which is the only
//! scale where a ten-row letter survives, as a downscaled copy turns to mush.
//!
//! The site also draws two faint hairline echoes of the glyph outline behind the wordmark, offset
//! by a fraction of a cell. A stroke that thin has no cell-resolution equivalent: any shifted copy
//! doubles the stroke weight and fills the counters of O, D and R, so the wordmark is drawn in one
//! ink instead.
//!
//! Its pixel cells are also the field's grid, so this module owns where that grid starts, in
//! [`Slot`].

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

use super::glyphs::{MARK, WORDMARK};
use crate::theme::Palette;

/// Air on each side, as the site keeps the wordmark clear of its frame rather than edge to edge.
const MARGIN: usize = 2;

/// A pixel glyph: `rows[y]` holds `width` cells, `1` filled and `0` empty.
pub struct Glyph {
    pub width: usize,
    pub height: usize,
    pub rows: &'static [&'static str],
}

impl Glyph {
    fn filled(&self, x: usize, y: usize) -> bool {
        self.rows
            .get(y)
            .and_then(|row| row.as_bytes().get(x))
            .is_some_and(|cell| *cell == b'1')
    }

    fn row_filled(&self, row: usize) -> bool {
        (0..self.width).any(|x| self.filled(x, row * 2) || self.filled(x, row * 2 + 1))
    }

    /// The terminal rows the glyph needs, two glyph rows to a row. Trailing empty rows are
    /// dropped: the last glyph row exists only to leave room for the site's outline echoes.
    fn rows(&self) -> usize {
        (0..self.height.div_ceil(2))
            .rev()
            .find(|row| self.row_filled(*row))
            .map_or(0, |row| row + 1)
    }
}

/// One terminal cell, from the two glyph pixels it carries.
fn cell(upper: bool, lower: bool) -> char {
    match (upper, lower) {
        (true, true) => '█',
        (true, false) => '▀',
        (false, true) => '▄',
        (false, false) => ' ',
    }
}

/// The glyph to draw in a frame this wide: the wordmark, else the mark, else nothing.
fn glyph_for(width: usize) -> Option<&'static Glyph> {
    for glyph in [&WORDMARK, &MARK] {
        if glyph.width + MARGIN * 2 <= width {
            return Some(glyph);
        }
    }
    None
}

/// Where the wordmark sits in this frame, and which glyph it is. The glyph's pixel grid is the
/// field's grid too, so the field is anchored on `x`.
#[derive(Clone, Copy)]
pub struct Slot {
    /// The column of the glyph's first pixel column, and the row of its first pixel row.
    pub x: u16,
    pub y: u16,
    glyph: &'static Glyph,
}

/// The slot for a frame this size: centred, or `None` when the frame cannot hold the glyph — too
/// narrow for even the mark, or too short for its rows. Nothing is scaled down to fit, because at
/// any smaller scale a ten-row letter turns to mush.
pub fn slot(area: Rect) -> Option<Slot> {
    let glyph = glyph_for(area.width as usize)?;
    let rows = glyph.rows() as u16;
    if rows > area.height {
        return None;
    }
    Some(Slot {
        x: area.width.saturating_sub(glyph.width as u16) / 2,
        y: (area.height - rows) / 2,
        glyph,
    })
}

/// Draw the glyph into the slot.
///
/// Only its filled pixels are written: an empty one keeps whatever is behind it, so the lattice
/// stays unbroken through the counters of O, D and R and the gaps between the letters, exactly as
/// it does on the site.
pub fn draw(buffer: &mut Buffer, slot: Slot, palette: &Palette) {
    for row in 0..slot.glyph.rows() {
        for col in 0..slot.glyph.width {
            let symbol = cell(
                slot.glyph.filled(col, row * 2),
                slot.glyph.filled(col, row * 2 + 1),
            );
            if symbol == ' ' {
                continue;
            }
            let pixel = &mut buffer[(slot.x + col as u16, slot.y + row as u16)];
            pixel.set_char(symbol);
            pixel.set_fg(palette.brand);
        }
    }
}
