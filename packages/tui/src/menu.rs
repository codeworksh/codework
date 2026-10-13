//! A menu: the choices on offer and the one the cursor is on.
//!
//! State, not drawing: `ui::menu` reads this and paints it. A menu is handed its entries and
//! reports which one is under the cursor; what choosing that entry *means* belongs to the app. The
//! command menu and the theme picker are both one of these, and so are the model and session
//! pickers that come next — the only difference between them is the entries they are given.

use ratatui::style::Color;

/// One choice in a menu.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// What the entry is called, and the first thing its row shows. It is also its identity: the
    /// app matches on it, and [`Menu::at`] finds it.
    pub name: &'static str,
    /// A short note beside the name: what choosing it does, or what it is.
    pub detail: &'static str,
    /// The colours the entry is about, when it is about colour.
    pub preview: Option<Preview>,
}

/// A ground and an ink an entry wears on its own name.
///
/// A list of themes is then a list of themes, rather than a list of their names: the site's picker
/// previews each one too, in its name's colour and its card's screenshot.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Preview {
    /// What the name is drawn on: for a palette, its own canvas.
    pub bg: Color,
    /// What it is drawn in: for a palette, its primary ink.
    pub fg: Color,
}

/// The entries, and where the cursor is among them.
pub struct Menu {
    entries: Vec<Entry>,
    cursor: usize,
}

impl Menu {
    /// A menu over `entries`, its cursor on the first of them.
    pub fn new(entries: Vec<Entry>) -> Self {
        Self { entries, cursor: 0 }
    }

    /// A menu over `entries`, its cursor on the entry named `name`.
    ///
    /// That is how a picker opens on what is already in use, as the site's does. When the name is
    /// not there the cursor starts at the top rather than nowhere.
    pub fn at(entries: Vec<Entry>, name: &str) -> Self {
        let cursor = entries
            .iter()
            .position(|entry| entry.name == name)
            .unwrap_or(0);
        Self { entries, cursor }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// The entry under the cursor.
    pub fn selected(&self) -> &Entry {
        &self.entries[self.cursor]
    }

    /// Move the cursor `step` entries, wrapping at both ends, so the last entry is one key from the
    /// first however long the list is — as the site's picker wraps its deck. Reports whether the
    /// cursor moved.
    pub fn step(&mut self, step: isize) -> bool {
        let len = self.entries.len() as isize;
        if len == 0 {
            return false;
        }
        let at = (self.cursor as isize + step).rem_euclid(len) as usize;
        if at == self.cursor {
            return false;
        }
        self.cursor = at;
        true
    }
}
