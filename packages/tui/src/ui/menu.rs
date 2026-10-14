//! Drawing a menu.
//!
//! The command menu and the theme picker are one widget: a bordered list, the row under the cursor
//! marked and filled, every entry's note beside its name. Rows are drawn on the canvas, not on the
//! lattice the hero runs behind them, and an entry that previews a palette wears that palette's own
//! ground and ink on its name — so the theme picker shows what it offers instead of describing it,
//! the way the site's preview cards do.
//!
//! It scrolls. The site ships 22 palettes and a 24-row terminal has no room for 22 rows under the
//! prompt, so the window follows the cursor rather than the menu growing to fit every entry.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::{Block, Widget};

use super::badge;
use super::text::{self, fitted, scrolled};
use crate::menu::Menu;
use crate::prompt::Prompt;
use crate::theme::Palette;

/// The most rows a menu shows at once. Eight leaves room on a 24-row terminal for the wordmark and
/// the line you are typing into, which is the whole point of scrolling the rest.
const MAX_ROWS: u16 = 8;
/// What marks the row the cursor is on. The other rows leave the same two cells blank, so the
/// names line up.
const MARKER: &str = "❯ ";
/// What a menu's search line shows before anything is typed into it.
const SEARCH_PLACEHOLDER: &str = "search...";
/// What a filtered menu shows when no entry matches the search query.
const EMPTY: &str = "no matches";
/// The tag on the top-right border showing how to close the menu.
const ESC: &str = "esc";
/// The air between a name and its note.
const GAP: u16 = 2;
/// The blank cell that ends every row, so neither the fill nor a note touches the border.
const PAD: u16 = 1;

/// The height a menu asks for: a border, an optional search line and divider, its rows, and a
/// border.
pub fn height(menu: &Menu, searchable: bool) -> u16 {
    let rows = menu.entries().len().clamp(1, MAX_ROWS as usize) as u16;
    let search = if searchable { 2 } else { 0 };
    rows + search + 2
}

/// The width a menu wants: the marker, the longest name, the longest note, and the border, measured
/// against the menu's full entry set so filtering never makes the box jump horizontally.
pub fn width(menu: &Menu, searchable: bool) -> u16 {
    let marker = text::width(MARKER) as u16;
    let entries = menu.all();
    let names = entries
        .iter()
        .map(|entry| text::width(&entry.name))
        .max()
        .unwrap_or(0) as u16;
    let notes = entries
        .iter()
        .map(|entry| text::width(&entry.detail))
        .max()
        .unwrap_or(0) as u16;
    let rows_width = marker + names + GAP + notes + PAD + 2;
    if searchable {
        let search_width = marker + text::width(SEARCH_PLACEHOLDER) as u16 + PAD + 14;
        rows_width.max(search_width)
    } else {
        rows_width
    }
}

/// Draw `menu` in `area`, titled `title` on its top-left border and `esc` on its top-right border,
/// with an optional `search` input at the top. Reports the search caret's cell when `search` is
/// present.
///
/// Nothing is drawn in too little space: a menu needs a border either side of at least one row, and
/// room for a marker beside it. A frame that small has nowhere to put a list, and the keys still
/// reach the menu that is there.
pub fn draw(
    buffer: &mut Buffer,
    area: Rect,
    title: &str,
    menu: &Menu,
    search: Option<&Prompt>,
    palette: &Palette,
) -> Option<(u16, u16)> {
    // The screen's layout can ask for rows a short frame does not have, so the menu draws inside
    // what is left of the buffer rather than trusting the rect it was handed.
    let area = area.intersection(buffer.area);
    let marker = text::width(MARKER) as u16;
    if area.height < 3 || area.width < marker + GAP + PAD + 2 {
        return None;
    }

    let border_style = Style::default().fg(palette.border_subtle);
    let block = Block::bordered().border_style(border_style);
    let inner = block.inner(area);
    block.render(area, buffer);
    badge::draw_left(buffer, area, title, Style::default().fg(palette.brand));
    if area.width >= text::width(title) as u16 + text::width(ESC) as u16 + 9 {
        badge::draw_right(buffer, area, ESC, Style::default().fg(palette.text_muted));
    }

    let (caret, list_y, list_height) = if let Some(search) = search {
        for x in inner.x..inner.x + inner.width {
            buffer[(x, inner.y)].set_char(' ');
        }
        buffer.set_string(inner.x, inner.y, MARKER, Style::default().fg(palette.brand));
        let text_x = inner.x + marker;
        let usable = inner.width.saturating_sub(marker + 1) as usize;
        let (caret_x, text, ink) = if search.text().is_empty() {
            (
                text_x,
                fitted(SEARCH_PLACEHOLDER, usable),
                palette.text_muted,
            )
        } else {
            let (text, offset) = scrolled(search.text(), search.before_caret(), usable);
            (text_x + offset, text, palette.text)
        };
        buffer.set_string(text_x, inner.y, text, Style::default().fg(ink));
        let caret = Some((caret_x, inner.y));

        if inner.height >= 3 {
            let div_y = inner.y + 1;
            buffer[(area.x, div_y)]
                .set_char('├')
                .set_style(border_style);
            for x in inner.x..inner.x + inner.width {
                buffer[(x, div_y)].set_char('─').set_style(border_style);
            }
            buffer[(area.right() - 1, div_y)]
                .set_char('┤')
                .set_style(border_style);
            (caret, inner.y + 2, inner.height - 2)
        } else {
            (caret, inner.y + 1, inner.height.saturating_sub(1))
        }
    } else {
        (None, inner.y, inner.height)
    };

    if list_height == 0 {
        return caret;
    }

    let entries = menu.entries();
    if entries.is_empty() {
        for x in inner.x..inner.x + inner.width {
            buffer[(x, list_y)].set_char(' ');
        }
        let usable = inner.width.saturating_sub(marker + PAD) as usize;
        buffer.set_string(
            inner.x + marker,
            list_y,
            fitted(EMPTY, usable),
            Style::default().fg(palette.text_muted),
        );
        return caret;
    }

    // The two columns every row is laid out in, measured from all entries so the note column does
    // not shift while filtering. A narrow frame takes from the notes first: the names are what you
    // are reading.
    let names = menu
        .all()
        .iter()
        .map(|entry| text::width(&entry.name))
        .max()
        .unwrap_or(0) as u16;
    let named = names.min(inner.width.saturating_sub(marker + GAP + PAD));
    let notes = inner.width.saturating_sub(marker + named + GAP + PAD);

    let first = window(menu.cursor(), list_height as usize, entries.len());
    for (row, entry) in entries[first..]
        .iter()
        .take(list_height as usize)
        .enumerate()
    {
        let y = list_y + row as u16;
        let selected = first + row == menu.cursor();

        // The row's own cells first, so a name and its note sit on the canvas rather than on the
        // lattice behind them — the same blanking as the preview below, without a colour of its
        // own. Only the cursor's row then gets a fill: right across, the way the site fills a
        // hovered row, and inside the border, where a row of whole cells lands.
        for x in inner.x..inner.x + inner.width {
            buffer[(x, y)].set_char(' ');
        }
        if selected {
            buffer.set_style(
                Rect {
                    x: inner.x,
                    y,
                    width: inner.width,
                    height: 1,
                },
                Style::default().bg(palette.surface_2),
            );
            buffer.set_string(inner.x, y, MARKER, Style::default().fg(palette.brand));
        }

        // The name, in its own colours when the entry has some: a theme's row wears that theme's
        // ground and ink, so a list of themes previews itself.
        let name = fitted(&entry.name, named as usize);
        let ink = match entry.preview {
            Some(preview) => Style::default().fg(preview.fg).bg(preview.bg),
            None if selected => Style::default().fg(palette.text),
            None => Style::default().fg(palette.text_secondary),
        };
        buffer.set_string(inner.x + marker, y, name, ink);

        buffer.set_string(
            inner.x + marker + named + GAP,
            y,
            fitted(&entry.detail, notes as usize),
            Style::default().fg(if selected {
                palette.text
            } else {
                palette.text_muted
            }),
        );
    }

    caret
}

/// The first entry the window shows, so that the cursor's entry is in it and the window is full
/// whenever there are entries to fill it.
fn window(cursor: usize, rows: usize, entries: usize) -> usize {
    cursor
        .saturating_sub(rows.saturating_sub(1))
        .min(entries.saturating_sub(rows))
}
