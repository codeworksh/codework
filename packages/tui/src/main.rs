mod app;
// The RPC transport (client + wire protocol) is kept whole: it is the layer the
// session screen will stream prompts over. Nothing on the welcome screen uses it.
#[allow(dead_code, unused_imports)]
mod rpc;
#[allow(dead_code)]
mod types;
mod ui;

use std::io::{self, Write};

use crossterm::event::{self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use app::App;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Install panic hook to restore terminal on crash
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let _ = disable_raw_mode();
        let mut out = io::stdout();
        let _ = execute!(out, LeaveAlternateScreen, DisableBracketedPaste);
        let _ = out.write_all(b"\x1b]111\x07\x1b[0m");
        let _ = out.flush();
        original_hook(panic_info);
    }));

    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    // Set terminal background to #1E1E2E (OSC 11), clear screen, and enter alternate screen
    let _ = stdout.write_all(b"\x1b]11;#1E1E2E\x07\x1b[48;2;30;30;46m\x1b[2J\x1b[H");
    let _ = stdout.flush();
    execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    let mut app = App::new();

    // Dedicated OS thread reading events from standard input.
    // Reading crossterm events on a dedicated thread avoids task cancellation drops
    // during tokio::select!, eliminates multi-thread races on stdin, and ensures fast typing
    // never loses characters.
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || loop {
        match event::read() {
            Ok(ev) => {
                if event_tx.send(ev).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    });

    terminal.draw(ui::render_welcome)?;

    while let Some(event) = event_rx.recv().await {
        handle_event(&mut app, event);
        // Drain any additional events buffered so a burst or paste does not lag.
        while let Ok(event) = event_rx.try_recv() {
            handle_event(&mut app, event);
        }

        terminal.draw(ui::render_welcome)?;

        if app.should_quit {
            break;
        }
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableBracketedPaste
    )?;
    terminal.show_cursor()?;
    let mut out = io::stdout();
    let _ = out.write_all(b"\x1b]111\x07\x1b[0m");
    let _ = out.flush();

    Ok(())
}

fn handle_event(app: &mut App, event: Event) {
    if let Event::Key(key) = event {
        // Ignore key release events from terminals supporting keyboard protocols
        if key.kind != KeyEventKind::Release {
            app.handle_key(key);
        }
    }
}
