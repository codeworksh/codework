//! Named actions and the keymap.
//!
//! Key presses are resolved to *named* actions rather than matched at each call
//! site, so a binding is one edit instead of six, and the names can line up with
//! OpenCode's (`app.exit`, `command.palette.show`, …). Only actions the TUI can
//! currently perform are listed — each new screen adds its own, instead of this
//! table binding behaviour that does not exist yet.
//!
//! These are the keys that mean one thing everywhere. A key whose meaning depends on what is on
//! screen — escape, which closes a menu or leaves — stays with the screen, because a keymap can
//! only hold one answer per key.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// How long the leader stays armed while waiting for the key after it.
const LEADER_TIMEOUT: Duration = Duration::from_secs(2);

/// The leader key that every `<leader>` binding is prefixed with. OpenCode
/// defaults to ctrl+x, and the leader is what keeps the rest of the keyboard
/// free for plain typing.
const LEADER: (KeyCode, KeyModifiers) = (KeyCode::Char('x'), KeyModifiers::CONTROL);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// `app.exit` — leave the TUI and hand the terminal back.
    Exit,
}

/// Resolves key presses to actions, including the `<leader>` prefix.
#[derive(Debug, Default)]
pub struct Keymap {
    leader_armed: Option<Instant>,
}

impl Keymap {
    pub fn new() -> Self {
        Self::default()
    }

    /// The action this key triggers.
    ///
    /// Takes `&mut self` because a key can be consumed without triggering
    /// anything: the leader key arms, and any other key clears the arming.
    pub fn resolve(&mut self, key: KeyEvent) -> Option<Action> {
        let leader = self.take_leader(key);
        match (key.code, key.modifiers) {
            // OpenCode's defaults for `app.exit`: ctrl+c, ctrl+d, <leader>q.
            (KeyCode::Char('c'), KeyModifiers::CONTROL) => Some(Action::Exit),
            (KeyCode::Char('d'), KeyModifiers::CONTROL) => Some(Action::Exit),
            (KeyCode::Char('q'), _) if leader => Some(Action::Exit),
            // Escape is deliberately not bound here, though it is what leaves the app: a menu
            // claims it first now, so what it means depends on the screen and `App` decides.
            _ => None,
        }
    }

    /// Whether this key press completes a `<leader>` sequence, arming the leader
    /// if the key is the leader itself.
    fn take_leader(&mut self, key: KeyEvent) -> bool {
        let armed = self
            .leader_armed
            .take()
            .is_some_and(|at| at.elapsed() < LEADER_TIMEOUT);
        if (key.code, key.modifiers) == LEADER {
            self.leader_armed = Some(Instant::now());
        }
        armed
    }
}
