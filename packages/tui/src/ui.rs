use ratatui::layout::{Alignment, Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

/// The app's background, painted over the whole viewport each frame.
const BG: Color = Color::Rgb(11, 11, 15);
const TEXT: Color = Color::Rgb(205, 214, 244);

/// The one screen the TUI has today.
pub fn render_welcome(f: &mut Frame) {
    let area = f.area();
    f.render_widget(Block::default().style(Style::default().bg(BG)), area);

    let [_, middle, _] = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(1),
        Constraint::Fill(1),
    ])
    .areas(area);
    f.render_widget(
        Paragraph::new("Welcome to CodeWork")
            .alignment(Alignment::Center)
            .style(Style::default().fg(TEXT).add_modifier(Modifier::BOLD)),
        middle,
    );
}
