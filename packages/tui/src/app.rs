//! Application state, and the only place that mutates it.
//!
//! `update` is the single entry point for change: it takes an event and reports
//! whether the screen needs redrawing. That report is the whole redraw policy —
//! there is no tick, so an idle TUI does no work and no repaint.

use crossterm::event::{KeyCode, KeyEvent};

use crate::action::{Action, Keymap};
use crate::event::AppEvent;
use crate::menu::{Entry, Menu, Preview};
use crate::prompt::Prompt;
use crate::theme::{self, Palette};

/// What the prompt answers an Enter with, until the session screen can act on it. A key that does
/// nothing reads as a bug, so the one that will send says so instead.
const NOT_SENDING: &str = "sending is not wired up yet";

/// What a leading slash offers. Only commands the app can actually perform are listed, and an
/// entry's name is what choosing it matches on.
const COMMANDS: &[Entry] = &[
    Entry {
        name: "theme",
        detail: "pick a palette",
        preview: None,
    },
    Entry {
        name: "exit",
        detail: "close the app",
        preview: None,
    },
];

/// The screens the TUI can show. One, for now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Welcome,
}

/// A menu open over the hero, taking the keyboard while it is there.
///
/// There is one at a time: choosing a command opens the menu it names, so that one replaces the
/// command menu rather than stacking under it.
pub enum Popup {
    /// What a leading slash asks for.
    Commands(Menu),
    /// The palettes the site ships, filtered by `search`, and the one that was on screen before
    /// the picker opened so Escape can put it back.
    Themes {
        search: Prompt,
        menu: Menu,
        initial: &'static Palette,
    },
}

impl Popup {
    pub fn menu(&self) -> &Menu {
        match self {
            Popup::Commands(menu) | Popup::Themes { menu, .. } => menu,
        }
    }

    fn menu_mut(&mut self) -> &mut Menu {
        match self {
            Popup::Commands(menu) | Popup::Themes { menu, .. } => menu,
        }
    }

    /// The menu's own search prompt, when it has one.
    pub fn search(&self) -> Option<&Prompt> {
        match self {
            Popup::Commands(_) => None,
            Popup::Themes { search, .. } => Some(search),
        }
    }

    /// What the menu calls itself, on its border.
    pub fn title(&self) -> &'static str {
        match self {
            Popup::Commands(_) => "commands",
            Popup::Themes { .. } => "themes",
        }
    }
}

pub struct App {
    pub screen: Screen,
    /// The palette every screen draws with. Held here rather than read from a global, so a frame
    /// is a pure function of the app and can be reproduced from a test backend.
    pub theme: &'static Palette,
    /// The prompt line: its text and where the caret is in it.
    pub prompt: Prompt,
    /// The menu on screen, if there is one. It is modal: while it is up the prompt behind it does
    /// not see a key.
    pub popup: Option<Popup>,
    /// A line of plain truth about the prompt, shown in place of the key hints. It is set by keys
    /// the prompt cannot honour and cleared by the first one it can.
    pub notice: Option<&'static str>,
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
            prompt: Prompt::default(),
            popup: None,
            notice: None,
            should_quit: false,
            keymap: Keymap::new(),
        }
    }

    /// Apply one event. Returns whether the screen needs to be drawn again.
    pub fn update(&mut self, event: AppEvent) -> bool {
        match event {
            AppEvent::Key(key) => self.handle_key(key),
            // A paste is text: into the theme search when the theme picker is open, otherwise into
            // the prompt line.
            AppEvent::Paste(text) => {
                if let Some(Popup::Themes {
                    search,
                    menu,
                    initial,
                }) = &mut self.popup
                {
                    if !search.insert_text(&text) {
                        return false;
                    }
                    self.theme = filter_themes(search.text(), menu, *initial);
                    return true;
                }
                let changed = self.prompt.insert_text(&text);
                if changed {
                    self.notice = None;
                    self.sync_commands();
                }
                changed
            }
            // The view reads its size from the frame it draws into, so a resize
            // needs no state change — only a repaint.
            AppEvent::Resize => true,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        // Named actions first, so a key bound to the app is never typed into the prompt. The exits
        // are the terminal's whether or not a menu is up.
        if let Some(Action::Exit) = self.keymap.resolve(key) {
            self.should_quit = true;
            // Nothing to redraw: the loop is about to end.
            return false;
        }
        // Escape closes what is open and, with nothing open, leaves. It is not in the keymap
        // because a keymap holds one answer per key and this one has two.
        if key.code == KeyCode::Esc {
            return self.escape();
        }
        // A menu claims the keys that walk or choose from it. The theme picker takes any other
        // editing key into its own search line; the command menu leaves editing keys to the prompt
        // line so typing or erasing `/` filters or closes it.
        if self.popup.is_some() {
            if self.menu_key(key) {
                return true;
            }
            if let Some(Popup::Themes {
                search,
                menu,
                initial,
            }) = &mut self.popup
            {
                if !search.edit(key) {
                    return false;
                }
                self.theme = filter_themes(search.text(), menu, *initial);
                return true;
            }
        }
        // Enter is the prompt's, not the keymap's, because it only means something once there is
        // something to send.
        if key.code == KeyCode::Enter {
            self.notice = Some(NOT_SENDING);
            return true;
        }
        // Everything the keymap did not claim belongs to the prompt, so a character types rather
        // than doing nothing.
        let edited = self.prompt.edit(key);
        if edited {
            self.notice = None;
            self.sync_commands();
        }
        edited
    }

    /// Open, filter, or close the command menu to match a leading slash on the prompt line.
    fn sync_commands(&mut self) {
        let Some(query) = self.prompt.text().strip_prefix('/') else {
            if matches!(self.popup, Some(Popup::Commands(_))) {
                self.popup = None;
            }
            return;
        };
        let query = query.to_ascii_lowercase();
        let mut menu = match self.popup.take() {
            Some(Popup::Commands(menu)) => menu,
            _ => Menu::new(COMMANDS.to_vec()),
        };
        menu.filter(|entry| entry.name.starts_with(&query));
        if !menu.entries().is_empty() {
            self.popup = Some(Popup::Commands(menu));
        }
    }

    /// A key for the menu on screen: the arrows walk it and Enter takes what it is on.
    fn menu_key(&mut self, key: KeyEvent) -> bool {
        let step = match key.code {
            KeyCode::Up => -1,
            KeyCode::Down => 1,
            KeyCode::Enter => return self.choose(),
            _ => return false,
        };
        let Some(popup) = &mut self.popup else {
            return false;
        };
        if !popup.menu_mut().step(step) {
            return false;
        }
        // Walking the theme picker previews each palette on the whole screen as the cursor lands
        // on it; Enter keeps it and Escape puts the initial one back.
        if let Popup::Themes { menu, .. } = popup {
            if let Some(palette) = menu.selected().and_then(|entry| theme_named(entry.name)) {
                self.theme = palette;
            }
        }
        true
    }

    /// Take the entry the cursor is on.
    fn choose(&mut self) -> bool {
        let Some(chosen) = self
            .popup
            .as_ref()
            .and_then(|popup| popup.menu().selected())
            .map(|entry| entry.name)
        else {
            return false;
        };
        let Some(popup) = self.popup.take() else {
            return false;
        };
        match popup {
            // The command is spent with the slash that was typed for it, and the picker it opened
            // starts on the palette already in use.
            Popup::Commands(_) => match chosen {
                "theme" => {
                    self.prompt.clear();
                    self.popup = Some(Popup::Themes {
                        search: Prompt::default(),
                        menu: themes(self.theme.name),
                        initial: self.theme,
                    });
                }
                "exit" => self.should_quit = true,
                _ => {}
            },
            // A palette: moving the cursor already applied it, so Enter only has to close the
            // picker and keep what is on screen.
            Popup::Themes { .. } => {
                if let Some(palette) = theme_named(chosen) {
                    self.theme = palette;
                }
            }
        }
        true
    }

    /// Close what is open, or leave when nothing is.
    fn escape(&mut self) -> bool {
        let Some(popup) = self.popup.take() else {
            self.should_quit = true;
            return false;
        };
        match popup {
            // Closing the command menu takes its slash back, so the line is what it was before the
            // command started and `/` asks for it again.
            Popup::Commands(_) => self.prompt.clear(),
            // Leaving the theme picker without choosing puts back the palette that was on screen
            // before the preview started.
            Popup::Themes { initial, .. } => self.theme = initial,
        }
        true
    }
}

fn theme_named(name: &str) -> Option<&'static Palette> {
    theme::PALETTES.iter().find(|palette| palette.name == name)
}

/// Filter the theme picker's entries by `query` (matching palette name or scheme) and return the
/// palette to preview on screen — the selected match when there is one, else `initial`.
fn filter_themes(query: &str, menu: &mut Menu, initial: &'static Palette) -> &'static Palette {
    let query = query.trim().to_ascii_lowercase();
    menu.filter(|entry| {
        query.is_empty()
            || entry.name.to_ascii_lowercase().contains(&query)
            || entry.detail.to_ascii_lowercase().contains(&query)
    });
    menu.selected()
        .and_then(|entry| theme_named(entry.name))
        .unwrap_or(initial)
}

/// The theme picker: one entry per palette the site ships, its cursor on `active`.
///
/// Each entry previews its own palette on the strength of `field_bg` and `text` alone — the ground
/// the screen would stand on and the ink the words would be in, which is what tells one palette
/// from another at a glance.
fn themes(active: &str) -> Menu {
    Menu::at(
        theme::PALETTES
            .iter()
            .map(|palette| Entry {
                name: palette.name,
                detail: palette.scheme.name(),
                preview: Some(Preview {
                    bg: palette.field_bg,
                    fg: palette.text,
                }),
            })
            .collect(),
        active,
    )
}
