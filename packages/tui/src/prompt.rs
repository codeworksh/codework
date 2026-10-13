//! The prompt line's text and caret.
//!
//! State, not drawing: `ui::input` reads this and reports the cell the caret lands in. The app
//! resolves named actions first, so an exit key never reaches here — every key that does either
//! moves the caret, changes the text, or is not ours.

use std::ops::Range;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// The prompt's text and caret.
///
/// The caret is a UTF-8 byte offset into `text`, kept on a character boundary by every operation
/// that moves it so slicing before or after the caret is direct.
#[derive(Default)]
pub struct Prompt {
    text: String,
    caret: usize,
}

impl Prompt {
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The text before the caret, which is what the widget measures to scroll a long line.
    pub fn before_caret(&self) -> &str {
        &self.text[..self.caret]
    }

    /// Empty the line. Escape does this when it takes back the slash that asked for the command
    /// menu, so the line is what it was before the command started.
    pub fn clear(&mut self) {
        self.text.clear();
        self.caret = 0;
    }

    /// Apply one key. Reports whether the prompt changed, which is the redraw.
    pub fn edit(&mut self, key: KeyEvent) -> bool {
        match (key.code, key.modifiers) {
            (KeyCode::Char('a'), KeyModifiers::CONTROL) | (KeyCode::Home, _) => self.jump(0),
            (KeyCode::Char('e'), KeyModifiers::CONTROL) | (KeyCode::End, _) => {
                self.jump(self.text.len())
            }
            (KeyCode::Char('u'), KeyModifiers::CONTROL) => self.remove_range(0..self.caret),
            (KeyCode::Char('k'), KeyModifiers::CONTROL) => {
                self.remove_range(self.caret..self.text.len())
            }
            (KeyCode::Char('w'), KeyModifiers::CONTROL)
            | (KeyCode::Backspace, KeyModifiers::ALT) => {
                self.remove_range(self.prev_word()..self.caret)
            }
            (KeyCode::Left, m) if m.intersects(KeyModifiers::ALT | KeyModifiers::CONTROL) => {
                self.jump(self.prev_word())
            }
            (KeyCode::Right, m) if m.intersects(KeyModifiers::ALT | KeyModifiers::CONTROL) => {
                self.jump(self.next_word())
            }
            // Only a plain or shifted key types: ctrl belongs to the app (exit, the leader) and alt
            // to the terminal.
            (KeyCode::Char(ch), m) if m.difference(KeyModifiers::SHIFT).is_empty() => {
                // Some terminals report a control key as a character (`\x01` for ctrl+a). Those are
                // never text, so they are dropped rather than drawn as a box.
                if ch.is_control() {
                    return false;
                }
                let mut buf = [0u8; 4];
                self.insert_text(ch.encode_utf8(&mut buf))
            }
            (KeyCode::Backspace, _) => match self.prev_char() {
                Some(prev) => self.remove_range(prev..self.caret),
                None => false,
            },
            (KeyCode::Delete, _) => match self.next_char() {
                Some(next) => self.remove_range(self.caret..next),
                None => false,
            },
            (KeyCode::Left, _) => match self.prev_char() {
                Some(prev) => self.jump(prev),
                None => false,
            },
            (KeyCode::Right, _) => match self.next_char() {
                Some(next) => self.jump(next),
                None => false,
            },
            _ => false,
        }
    }

    /// Insert text at the caret, as a paste arrives.
    ///
    /// Line breaks and tabs are turned into spaces so pasted lines do not run together, and any
    /// other control characters are dropped.
    pub fn insert_text(&mut self, text: &str) -> bool {
        let mut clean = String::with_capacity(text.len());
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    clean.push(' ');
                }
                '\n' | '\t' => clean.push(' '),
                ch if !ch.is_control() => clean.push(ch),
                _ => {}
            }
        }
        if clean.is_empty() {
            return false;
        }
        self.text.insert_str(self.caret, &clean);
        self.caret += clean.len();
        true
    }

    fn remove_range(&mut self, range: Range<usize>) -> bool {
        if range.is_empty() {
            return false;
        }
        let start = range.start;
        self.text.replace_range(range, "");
        self.caret = start;
        true
    }

    fn jump(&mut self, caret: usize) -> bool {
        if caret == self.caret {
            return false;
        }
        self.caret = caret;
        true
    }

    fn prev_char(&self) -> Option<usize> {
        self.text[..self.caret]
            .char_indices()
            .next_back()
            .map(|(idx, _)| idx)
    }

    fn next_char(&self) -> Option<usize> {
        self.text[self.caret..]
            .chars()
            .next()
            .map(|ch| self.caret + ch.len_utf8())
    }

    fn prev_word(&self) -> usize {
        let before = &self.text[..self.caret];
        let trimmed = before.trim_end_matches(char::is_whitespace);
        trimmed
            .char_indices()
            .rev()
            .find(|(_, ch)| ch.is_whitespace())
            .map_or(0, |(idx, ch)| idx + ch.len_utf8())
    }

    fn next_word(&self) -> usize {
        let after = &self.text[self.caret..];
        let mut chars = after.char_indices().peekable();
        while chars.next_if(|(_, ch)| ch.is_whitespace()).is_some() {}
        while chars.next_if(|(_, ch)| !ch.is_whitespace()).is_some() {}
        chars
            .peek()
            .map_or(self.text.len(), |(idx, _)| self.caret + idx)
    }
}
