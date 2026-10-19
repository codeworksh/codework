//! A menu: the choices on offer and the one the cursor is on.
//!
//! State, not drawing: `ui::menu` reads this and paints it. A menu is handed its entries and
//! reports which one is under the cursor; what choosing that entry *means* belongs to the app. The
//! command menu and the theme picker are both one of these, and so are the model and session
//! pickers that come next — the only difference between them is the entries they are given.

use std::borrow::Cow;

use ratatui::style::Color;

/// One choice in a menu.
#[derive(Clone, PartialEq, Eq)]
pub struct Entry {
    /// What choosing this entry identifies (for a session, its id; otherwise its name).
    pub id: Cow<'static, str>,
    /// What the entry is called, and the first thing its row shows.
    pub name: Cow<'static, str>,
    /// A short note beside the name: what choosing it does, or what it is.
    pub detail: Cow<'static, str>,
    /// The colours the entry is about, when it is about colour.
    pub preview: Option<Preview>,
}

impl Entry {
    pub const fn item(name: &'static str, detail: &'static str) -> Self {
        Self {
            id: Cow::Borrowed(name),
            name: Cow::Borrowed(name),
            detail: Cow::Borrowed(detail),
            preview: None,
        }
    }

    pub const fn with_preview(name: &'static str, detail: &'static str, preview: Preview) -> Self {
        Self {
            id: Cow::Borrowed(name),
            name: Cow::Borrowed(name),
            detail: Cow::Borrowed(detail),
            preview: Some(preview),
        }
    }

    pub fn owned(
        id: impl Into<String>,
        name: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            id: Cow::Owned(id.into()),
            name: Cow::Owned(name.into()),
            detail: Cow::Owned(detail.into()),
            preview: None,
        }
    }
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
    all: Vec<Entry>,
    entries: Vec<Entry>,
    cursor: usize,
}

impl Menu {
    /// A menu over `entries`, its cursor on the first of them.
    pub fn new(entries: Vec<Entry>) -> Self {
        Self {
            all: entries.clone(),
            entries,
            cursor: 0,
        }
    }

    /// A menu over `entries`, its cursor on the entry named `name` (or matching `id`).
    ///
    /// That is how a picker opens on what is already in use, as the site's does. When the name is
    /// not there the cursor starts at the top rather than nowhere.
    pub fn at(entries: Vec<Entry>, name: &str) -> Self {
        let cursor = entries
            .iter()
            .position(|entry| entry.name == name || entry.id == name)
            .unwrap_or(0);
        Self {
            all: entries.clone(),
            entries,
            cursor,
        }
    }

    /// Every entry the menu was built with, before filtering. Used to measure column widths so the
    /// box does not narrow and widen as a search query changes.
    pub fn all(&self) -> &[Entry] {
        &self.all
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// The entry under the cursor, when the menu has any.
    pub fn selected(&self) -> Option<&Entry> {
        self.entries.get(self.cursor)
    }

    /// Keep only the entries from [`Self::all`] that match `keep`, preserving the selected entry
    /// when it still matches and otherwise starting at the top.
    pub fn filter(&mut self, mut keep: impl FnMut(&Entry) -> bool) {
        let active = self.selected().map(|entry| entry.id.clone());
        self.entries = self
            .all
            .iter()
            .filter(|entry| keep(entry))
            .cloned()
            .collect();
        self.cursor = active
            .and_then(|id| self.entries.iter().position(|entry| entry.id == id))
            .unwrap_or(0);
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
