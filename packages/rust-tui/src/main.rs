mod app;
mod catalog;
mod config;
mod credentials;
mod diff;
mod git;
mod markdown;
mod rpc;
mod tool;
mod types;
mod ui;

use std::io::{self, Write};
use std::time::Duration;

use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::style::Style;
use ratatui::widgets::Block;
use ratatui::Terminal;
use tokio::time::interval;

use app::{ActiveScreen, App};
use ui::{render_model_browser, render_session, render_theme_picker, render_welcome};

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
    let mut ticker = interval(Duration::from_millis(80));

    // Dedicated OS thread reading events from standard input.
    // Reading crossterm events on a dedicated thread avoids task cancellation drops
    // during tokio::select!, eliminates multi-thread races on stdin, and ensures fast typing
    // never loses characters.
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        loop {
            match event::read() {
                Ok(ev) => {
                    if event_tx.send(ev).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    loop {
        terminal.draw(|f| {
            let area = f.area();
            // Fill the entire terminal viewport with Deep Black (#0B0B0F) background
            f.render_widget(
                Block::default().style(Style::default().bg(ui::Theme::bg_app())),
                area,
            );
            match app.screen {
                ActiveScreen::Welcome => {
                    render_welcome(
                        f,
                        area,
                        &app.welcome_input,
                        app.welcome_cursor,
                        app.welcome_dropdown_index,
                        app.active_config.as_ref(),
                        app.welcome_status_message.as_deref(),
                        &app.spinner,
                    );
                }
                ActiveScreen::ModelFlow => {
                    render_model_browser(f, area, &app.model_browser, &app.spinner);
                }
                ActiveScreen::Session => {
                    if let Some(cfg) = &app.active_config {
                        render_session(
                            f,
                            area,
                            app.session_info.as_ref(),
                            &app.turns,
                            &app.session_stats,
                            cfg,
                            &app.session_input,
                            app.session_cursor,
                            app.session_scroll_offset,
                            app.session_dropdown_index,
                            &app.spinner,
                            app.is_streaming,
                        );
                    }
                }
            }

            if app.theme_picker_open {
                render_theme_picker(f, area, app.theme_picker_index);
            }
        })?;

        tokio::select! {
            _ = ticker.tick() => {
                app.on_tick();
            }
            Some(event) = event_rx.recv() => {
                handle_event(&mut app, event);
                // Drain any additional events buffered so fast typing / bursts / pastes don't lag or drop!
                while let Ok(event) = event_rx.try_recv() {
                    handle_event(&mut app, event);
                }
            }
        }

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
    match event {
        Event::Key(key) => {
            // Ignore key release events from terminals supporting keyboard protocols
            if key.kind != KeyEventKind::Release {
                app.handle_key(key);
            }
        }
        Event::Mouse(mouse) => {
            app.handle_mouse(mouse);
        }
        Event::Paste(text) => {
            app.handle_paste(&text);
        }
        _ => {}
    }
}
