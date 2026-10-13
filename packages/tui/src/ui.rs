//! Rendering.
//!
//! Pure: it reads state and draws. Nothing here mutates the app or performs
//! I/O, which is what makes a frame reproducible from a `TestBackend`.

mod field;
mod glyphs;
mod wordmark;

use ratatui::style::Style;
use ratatui::widgets::Block;
use ratatui::Frame;

use crate::app::{App, Screen};

/// Draw the active screen.
pub fn view(app: &App, frame: &mut Frame) {
    match app.screen {
        Screen::Welcome => view_welcome(app, frame),
    }
}

fn view_welcome(app: &App, frame: &mut Frame) {
    let area = frame.area();
    // This screen is the site's hero, so it stands on the canvas ground rather than
    // the page one: the field is a deeper panel than the page around it, and its
    // lattice ink is mixed from this ground. Painted every frame, so a theme switch
    // repaints rather than leaving the previous palette in the gaps.
    let canvas = Style::default().bg(app.theme.field_bg);
    frame.render_widget(Block::default().style(canvas), area);

    // Three layers, in the order the site paints them: the ground, the lattice on the
    // wordmark's own pixel grid, then the word over it. A frame with no room for
    // either glyph still gets the lattice: the site's field covers the whole canvas
    // whether or not the word fits.
    let slot = wordmark::slot(area);
    field::paint(
        frame.buffer_mut(),
        area,
        app.theme,
        slot.map_or(0, |slot| slot.x),
    );
    if let Some(slot) = slot {
        wordmark::draw(frame.buffer_mut(), slot, app.theme);
    }
}
