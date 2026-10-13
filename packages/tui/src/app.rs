//! Application state, and the only place that mutates it.
//!
//! `update` is the single entry point for change: it takes an event and reports
//! whether the screen needs redrawing. That report is the whole redraw policy —
//! there is no tick, so an idle TUI does no work and no repaint.

use crossterm::event::KeyEvent;

use crate::action::{Action, Keymap};
use crate::event::AppEvent;
use crate::theme::{self, Palette};

/// The screens the TUI can show. One, for now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Welcome,
}

pub struct App {
    pub screen: Screen,
    /// The palette every screen draws with. Held here rather than read from a global, so a frame
    /// is a pure function of the app and can be reproduced from a test backend.
    pub theme: &'static Palette,
    pub should_quit: bool,
    keymap: Keymap,
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

impl App {
    pub fn new() -> Self {
        Self {
            screen: Screen::Welcome,
            theme: theme::default_palette(),
            should_quit: false,
            keymap: Keymap::new(),
        }
    }

    /// Apply one event. Returns whether the screen needs to be drawn again.
    pub fn update(&mut self, event: AppEvent) -> bool {
        match event {
            AppEvent::Key(key) => self.handle_key(key),
            // The view reads its size from the frame it draws into, so a resize
            // needs no state change — only a repaint.
            AppEvent::Resize => true,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        match self.keymap.resolve(key) {
            // Nothing to redraw: the loop is about to end.
            Some(Action::Exit) => {
                self.should_quit = true;
                false
            }
            None => false,
        }
    }
}
