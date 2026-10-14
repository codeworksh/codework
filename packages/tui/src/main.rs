mod action;
mod app;
mod event;
mod menu;
mod prompt;
mod rpc;
mod theme;
mod tui;
mod types;
mod ui;

use std::error::Error;

use app::App;
use event::EventHandler;
use tui::TerminalGuard;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut events = EventHandler::new();
    // The app first: it owns the palette, and the terminal's own background is set from it so the
    // ground beneath the frames matches the ground inside them.
    let mut app = App::new(events.sender());
    // Dropping the guard restores the terminal, including on an early return.
    let mut terminal = TerminalGuard::init(app.background())?;

    terminal.draw(app.background(), |frame| ui::view(&app, frame))?;

    while let Some(event) = events.next().await {
        let mut redraw = app.update(event);
        // Apply everything already queued before painting, so a burst of typing
        // or a resize storm costs one frame rather than one frame per event.
        for event in events.drain() {
            redraw |= app.update(event);
        }
        if app.should_quit {
            break;
        }
        if redraw {
            terminal.draw(app.background(), |frame| ui::view(&app, frame))?;
        }
    }

    Ok(())
}
