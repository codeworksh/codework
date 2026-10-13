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
    /// The palettes the site ships.
    Themes(Menu),
}

impl Popup {
    pub fn menu(&self) -> &Menu {
        match self {
            Popup::Commands(menu) | Popup::Themes(menu) => menu,
        }
    }

    fn menu_mut(&mut self) -> &mut Menu {
        match self {
            Popup::Commands(menu) | Popup::Themes(menu) => menu,
        }
    }

    /// What the menu calls itself, on its border.
    pub fn title(&self) -> &'static str {
        match self {
            Popup::Commands(_) => "commands",
            Popup::Themes(_) => "themes",
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
            // A paste is text, and a menu takes no text: it is dropped rather than typed into the
            // line the menu is standing in front of.
            AppEvent::Paste(text) => {
                if self.popup.is_some() {
                    return false;
                }
                let changed = self.prompt.insert_text(&text);
                if changed {
                    self.notice = None;
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
        // A menu takes the keyboard while it is up. It is modal, so a key it does not want is
        // dropped rather than typed into the prompt standing behind it.
        if self.popup.is_some() {
            return self.menu_key(key);
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
            // A slash alone on the line asks for the commands, the way a chat prompt does. The
            // slash stays on the line: it is the command being completed, and what Escape takes
            // back.
            if self.prompt.text() == "/" {
                self.popup = Some(Popup::Commands(Menu::new(COMMANDS.to_vec())));
            }
        }
        edited
    }

    /// A key for the menu on screen: the arrows walk it and Enter takes what it is on.
    fn menu_key(&mut self, key: KeyEvent) -> bool {
        let step = match key.code {
            KeyCode::Up => -1,
            KeyCode::Down => 1,
            KeyCode::Enter => return self.choose(),
            _ => return false,
        };
        self.popup
            .as_mut()
            .is_some_and(|popup| popup.menu_mut().step(step))
    }

    /// Take the entry the cursor is on.
    fn choose(&mut self) -> bool {
        let Some(popup) = self.popup.take() else {
            return false;
        };
        let chosen = popup.menu().selected().name;
        match popup {
            // The command is spent with the slash that was typed for it, and the picker it opened
            // starts on the palette already in use.
            Popup::Commands(_) => match chosen {
                "theme" => {
                    self.prompt.clear();
                    self.popup = Some(Popup::Themes(themes(self.theme.name)));
                }
                "exit" => self.should_quit = true,
                _ => {}
            },
            // A palette: take it. Choosing the one already on screen just closes the picker, as
            // the site's does.
            Popup::Themes(_) => {
                if let Some(palette) = theme::PALETTES
                    .iter()
                    .find(|palette| palette.name == chosen)
                {
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
        // Closing the command menu takes its slash back, so the line is what it was before the
        // command started and `/` asks for it again. The theme picker was opened by a command that
        // spent its slash already.
        if matches!(popup, Popup::Commands(_)) {
            self.prompt.clear();
        }
        true
    }
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
