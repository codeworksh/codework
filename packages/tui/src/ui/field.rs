//! The hero's lattice.
//!
//! Ported from the landing site's `field.tsx`, whose hero "rests on the grid alone": a hairline
//! grid on the wordmark's own pixel grid, a line every `GRID_CELLS` (two) of its cells, drawn
//! across the whole canvas in an ink mixed 22% from the ground toward the dim ramp step — the
//! palette's `field_grid`, which the generator bakes from that recipe.
//! Everything else that file draws — the drifting noise, the glow that follows the pointer, the
//! mark stamped wherever you click, the extension tiles — belongs to interaction, or to the bare
//! texture of the footer, so none of it is on the hero at rest.
//!
//! A terminal has no hairline, but `─` and `│` are one pixel thick and join edge to edge, so the
//! lattice survives at cell resolution. One cell of the site's grid is one terminal column and half
//! a terminal row — the same pairing that keeps the wordmark square — so a line every two cells is
//! a line every second column, and a line every two rows is a line in every row. The lattice is
//! anchored on the wordmark's origin plus half a cell: that is the phase whose lines land on cell
//! centres, where a box-drawing character draws itself rather than at the cell's edge.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

use crate::theme::Palette;

/// Each faint grid square contains two by two field cells.
const GRID_CELLS: i32 = 2;

/// Paint the lattice over `area`, on top of the ground already painted there. `origin` is the
/// column the wordmark's own pixel grid starts at: the site anchors its field and this grid on the
/// wordmark slot, so these are the wordmark's lines rather than an arbitrary lattice.
pub fn paint(buffer: &mut Buffer, area: Rect, palette: &Palette, origin: u16) {
    for row in 0..area.height {
        for col in 0..area.width {
            let x = (area.x + col) as i32 - origin as i32;
            let cell = &mut buffer[(area.x + col, area.y + row)];
            // Every row carries the horizontal line and every second column the vertical one, so
            // the crossings are the columns one step into each square.
            cell.set_char(if x.rem_euclid(GRID_CELLS) == 1 {
                '┼'
            } else {
                '─'
            });
            // The ink is the line's own; the background stays whatever the ground painted.
            cell.set_fg(palette.field_grid);
        }
    }
}
