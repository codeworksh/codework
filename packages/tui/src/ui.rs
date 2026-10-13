//! Rendering.
//!
//! Pure: it reads state and draws. Nothing here mutates the app or performs
//! I/O, which is what makes a frame reproducible from a `TestBackend`.

use ratatui::layout::{Alignment, Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use crate::app::{App, Screen};

/// The app background. Painted over the whole viewport each frame, and handed to
/// the terminal at startup so its own background matches.
pub const BG: Color = Color::Rgb(11, 11, 15);
const TEXT: Color = Color::Rgb(205, 214, 244);

/// Draw the active screen.
pub fn view(app: &App, frame: &mut Frame) {
    match app.screen {
        Screen::Welcome => view_welcome(frame),
    }
}

fn view_welcome(frame: &mut Frame) {
    let area = frame.area();
    frame.render_widget(Block::default().style(Style::default().bg(BG)), area);

    let [_, middle, _] = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(1),
        Constraint::Fill(1),
    ])
    .areas(area);
    frame.render_widget(
        Paragraph::new("Welcome to CodeWork")
            .alignment(Alignment::Center)
            .style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        middle,
    );
}
