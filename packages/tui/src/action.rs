//! Named actions and the keymap.
//!
//! Key presses are resolved to *named* actions rather than matched at each call
//! site, so a binding is one edit instead of six, and the names follow one
//! scheme (`app.exit`, `command.palette.show`, …). Only actions the TUI can
//! currently perform are listed — each new screen adds its own, instead of this
//! table binding behaviour that does not exist yet.
//!
//! These are the keys that mean one thing everywhere. A key whose meaning depends on what is on
//! screen — escape, which closes a menu or leaves — stays with the screen, because a keymap can
//! only hold one answer per key.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

/// How long the leader stays armed while waiting for the key after it.
const LEADER_TIMEOUT: Duration = Duration::from_secs(2);

/// The leader key that every `<leader>` binding is prefixed with: ctrl+x. The
/// leader is what keeps the rest of the keyboard free for plain typing.
const LEADER: (KeyCode, KeyModifiers) = (KeyCode::Char('x'), KeyModifiers::CONTROL);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// `app.exit` — leave the TUI and hand the terminal back.
    Exit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// The key triggered a named action.
    Action(Action),
    /// The key armed or spent the `<leader>` prefix without triggering an action, so it must
    /// not fall through to the prompt.
    Consumed,
    /// The key is not bound here.
    Unbound,
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

    /// What this key press means to the keymap.
    ///
    /// Takes `&mut self` because a key can be consumed without triggering
    /// anything: the leader key arms, and any key pressed while it is armed
    /// spends the prefix rather than typing into the prompt.
    pub fn resolve(&mut self, key: KeyEvent) -> Resolution {
        if (key.code, key.modifiers) == LEADER {
            if key.kind != KeyEventKind::Repeat {
                self.leader_armed = Some(Instant::now());
            }
            return Resolution::Consumed;
        }
        let leader = self
            .leader_armed
            .take()
            .is_some_and(|at| at.elapsed() < LEADER_TIMEOUT);
        match (key.code, key.modifiers) {
            // `app.exit`: ctrl+c, ctrl+d, <leader>q.
            (KeyCode::Char('c'), KeyModifiers::CONTROL) => Resolution::Action(Action::Exit),
            (KeyCode::Char('d'), KeyModifiers::CONTROL) => Resolution::Action(Action::Exit),
            (KeyCode::Char('q'), KeyModifiers::NONE) if leader => Resolution::Action(Action::Exit),
            _ if leader => Resolution::Consumed,
            // Escape is deliberately not bound here, though it is what leaves the app: a menu
            // claims it first now, so what it means depends on the screen and `App` decides.
            _ => Resolution::Unbound,
        }
    }
}
