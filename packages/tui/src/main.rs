mod action;
mod app;
mod event;
// The RPC transport (client + wire protocol) is kept whole: it is the layer the
// session screen will stream prompts over. Nothing on the welcome screen uses it.
#[allow(dead_code, unused_imports)]
mod rpc;
mod tui;
#[allow(dead_code)]
mod types;
mod ui;

use std::error::Error;

use app::App;
use event::EventHandler;
use tui::TerminalGuard;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    // Dropping the guard restores the terminal, including on an early return.
    let mut terminal = TerminalGuard::init(ui::BG)?;
    let mut app = App::new();
    let mut events = EventHandler::new();

    terminal.draw(|frame| ui::view(&app, frame))?;

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
            terminal.draw(|frame| ui::view(&app, frame))?;
        }
    }

    Ok(())
}
