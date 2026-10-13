//! Rendering.
//!
//! Pure: it reads state and draws. Nothing here mutates the app or performs
//! I/O, which is what makes a frame reproducible from a `TestBackend`.

use ratatui::layout::{Alignment, Constraint, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use crate::app::{App, Screen};

/// Draw the active screen.
pub fn view(app: &App, frame: &mut Frame) {
    match app.screen {
        Screen::Welcome => view_welcome(app, frame),
    }
}

fn view_welcome(app: &App, frame: &mut Frame) {
    let palette = app.theme;
    let area = frame.area();
    // The ground is painted every frame, so a theme switch repaints rather than
    // leaving the previous palette in the gaps.
    let ground = Style::default().bg(palette.bg);
    frame.render_widget(Block::default().style(ground), area);

    let [_, middle, _] = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(1),
        Constraint::Fill(1),
    ])
    .areas(area);
    let heading = Style::default()
        .fg(palette.text)
        .add_modifier(Modifier::BOLD);
    frame.render_widget(
        Paragraph::new("Welcome to CodeWork")
            .alignment(Alignment::Center)
            .style(heading),
        middle,
    );
}
