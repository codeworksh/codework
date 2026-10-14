//! Rendering.
//!
//! Pure: it reads state and draws. Nothing here mutates the app or performs
//! I/O, which is what makes a frame reproducible from a `TestBackend`.

mod badge;
mod field;
mod glyphs;
mod input;
mod menu;
mod session;
mod text;
mod wordmark;

use ratatui::layout::{Alignment, Constraint, Flex, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use crate::app::{App, Popup, Screen};

/// The air the site leaves between its wordmark, its hero copy and its install box, in cells.
const GAP: u16 = 2;

/// The line under the prompt, for each thing that can have the keyboard. Only keys the app answers
/// are listed, so nothing here promises something that does not happen.
const HINTS: &str = "←→ move · / commands · esc quit";
const COMMAND_HINTS: &str = "↑↓ move · enter choose · esc close";
const THEME_HINTS: &str = "↑↓ move · type to search · enter choose · esc close";

/// Draw the active screen.
pub fn view(app: &App, frame: &mut Frame) {
    match app.screen {
        Screen::Welcome => view_welcome(app, frame),
        Screen::Session => session::draw(app, frame),
    }
}

fn view_welcome(app: &App, frame: &mut Frame) {
    let area = frame.area();
    let palette = app.theme;

    // This screen is the site's hero, so it stands on the canvas ground rather than the page one:
    // the field is a deeper panel than the page around it, and its lattice ink is mixed from this
    // ground. Painted every frame, so a theme switch repaints rather than leaving the previous
    // palette in the gaps.
    frame.render_widget(
        Block::default().style(Style::default().bg(palette.field_bg)),
        area,
    );

    // The hero's column, in the order the site stacks it: the wordmark, the prompt box, and the
    // line under it. Centred as one block without the menu, so opening or switching a menu never
    // shifts the wordmark or the prompt line on screen.
    //
    // On a frame too short for the whole column it is the wordmark that goes first: the line you
    // type into outranks the word above it.
    let below = GAP + input::HEIGHT + GAP + 1;
    let art_rows = wordmark::rows(area.width)
        .unwrap_or(0)
        .min(area.height.saturating_sub(below));
    let [art, _, prompt, _, mut hint] = Layout::vertical([
        Constraint::Length(art_rows),
        Constraint::Length(GAP),
        Constraint::Length(input::HEIGHT),
        Constraint::Length(GAP),
        Constraint::Length(1),
    ])
    .flex(Flex::Center)
    .areas(area);

    // The lattice is the wordmark's own grid, so the wordmark decides where it starts. It is laid
    // down first, and everything else is drawn over it — though a frame with no room for the
    // wordmark still gets it, because the site's field covers the whole canvas either way.
    let slot = wordmark::slot(art);
    field::paint(
        frame.buffer_mut(),
        area,
        palette,
        slot.map_or(0, |slot| slot.x),
    );
    if let Some(slot) = slot {
        wordmark::draw(frame.buffer_mut(), slot, palette);
    }

    let prompt_caret = input::draw(frame.buffer_mut(), prompt, &app.prompt, palette);
    let mut menu_caret = None;
    if let Some(popup) = &app.popup {
        // Hung directly under the prompt box and anchored on its left edge, so it reads as the
        // list the line opens into without pushing the hero up.
        let anchor = input::centred(area);
        let searchable = popup.search().is_some();
        let wanted = menu::height(popup.menu(), searchable);
        let room = area.bottom().saturating_sub(prompt.bottom());
        let reserve = if room >= wanted + GAP + 1 {
            GAP + 1
        } else {
            2
        };
        let room_with_hint = room.saturating_sub(reserve);
        let min_rows = if searchable { 5 } else { 3 };
        let max_height = if room_with_hint >= min_rows {
            room_with_hint
        } else {
            room
        };
        let height = wanted.min(max_height);
        let width =
            menu::width(popup.menu(), searchable).min(area.right().saturating_sub(anchor.x));
        let picker = Rect {
            x: anchor.x,
            y: prompt.bottom(),
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
        hint.y = (picker.bottom() + GAP).min(area.bottom().saturating_sub(1));
    }
    if let Some(caret) = menu_caret.or(prompt_caret) {
        frame.set_cursor_position(caret);
    }
    // A key the prompt cannot honour is answered here rather than dropped. The ink is on the span
    // rather than the paragraph: a paragraph style would be patched onto every cell of the row,
    // repainting the lattice behind the line in the hint's colour instead of the grid's.
    let hints = match (&app.notice, &app.popup) {
        (Some(notice), _) => notice.as_str(),
        (None, Some(Popup::Commands(_) | Popup::Thinking(_))) => COMMAND_HINTS,
        (None, Some(Popup::Themes { .. } | Popup::Models { .. } | Popup::Sessions { .. })) => {
            THEME_HINTS
        }
        (None, None) => HINTS,
    };
    if hint.y < area.bottom() {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                hints,
                Style::default().fg(palette.text_muted),
            )))
            .alignment(Alignment::Center),
            hint,
        );
    }
}
