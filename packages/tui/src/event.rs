//! Input.
//!
//! A dedicated OS thread reads crossterm events and forwards them; the UI thread
//! only ever waits on this channel. Reading on the UI task instead would drop
//! events whenever the loop is cancelled or busy, and concurrent stdin reads
//! race. The thread ends when the receiver is dropped, which is how shutdown
//! stops it — there is no flag to check and nothing to join.

use crossterm::event::{Event, KeyEvent, KeyEventKind};
use tokio::sync::mpsc;

/// What the app reacts to: the events that actually change the screen. Anything
/// else crossterm can deliver is dropped at the boundary rather than carried
/// around unhandled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    Key(KeyEvent),
    /// The terminal changed size. The payload is deliberately not carried: the
    /// view reads its own dimensions from the frame it is drawing into, so a
    /// stale copy in state would be one more thing to keep in sync.
    Resize,
}

pub struct EventHandler {
    rx: mpsc::UnboundedReceiver<AppEvent>,
}

impl Default for EventHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl EventHandler {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        std::thread::spawn(move || loop {
            match crossterm::event::read() {
                Ok(event) => {
                    let Some(event) = translate(event) else {
                        continue;
                    };
                    if tx.send(event).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        });
        Self { rx }
    }

    /// Wait for the next event. `None` once the input thread has stopped.
    pub async fn next(&mut self) -> Option<AppEvent> {
        self.rx.recv().await
    }

    /// Take everything already queued.
    ///
    /// Called after each `next`, so a burst of typing or a resize storm is
    /// applied in one batch and costs one frame instead of one frame per event.
    pub fn drain(&mut self) -> Vec<AppEvent> {
        let mut batch = Vec::new();
        while let Ok(event) = self.rx.try_recv() {
            batch.push(event);
        }
        batch
    }
}

/// Only key presses are meaningful. Terminals that report key releases (the
/// keyboard protocol asks them to) would otherwise act on every key twice.
fn translate(event: Event) -> Option<AppEvent> {
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => Some(AppEvent::Key(key)),
        Event::Resize(_, _) => Some(AppEvent::Resize),
        _ => None,
    }
}
