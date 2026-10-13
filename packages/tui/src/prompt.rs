//! The prompt line's text and caret.
//!
//! State, not drawing: `ui::input` reads this and reports the cell the caret lands in. The app
//! resolves named actions first, so an exit key never reaches here — every key that does either
//! moves the caret, changes the text, or is not ours.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// The prompt's text and caret.
///
/// The caret counts characters rather than bytes: a byte index would have to be kept on a
/// boundary by hand every time the text changes, and a prompt line is short.
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
        &self.text[..self.byte(self.caret)]
    }

    /// Empty the line. Escape does this when it takes back the slash that asked for the command
    /// menu, so the line is what it was before the command started.
    pub fn clear(&mut self) {
        self.text.clear();
        self.caret = 0;
    }

    /// Apply one key. Reports whether the prompt changed, which is the redraw.
    pub fn edit(&mut self, key: KeyEvent) -> bool {
        match key.code {
            // Only a plain or shifted key types: ctrl belongs to the app (exit, the leader) and alt
            // to the terminal.
            KeyCode::Char(ch) if key.modifiers.difference(KeyModifiers::SHIFT).is_empty() => {
                // Some terminals report a control key as a character (`\x01` for ctrl+a). Those are
                // never text, so they are dropped rather than drawn as a box.
                if ch.is_control() {
                    return false;
                }
                self.insert_text(&ch.to_string())
            }
            KeyCode::Backspace => self.remove(self.caret.checked_sub(1)),
            KeyCode::Delete => self.remove(Some(self.caret)),
            KeyCode::Left => self.move_caret(-1),
            KeyCode::Right => self.move_caret(1),
            KeyCode::Home => self.jump(0),
            KeyCode::End => self.jump(self.len()),
            _ => false,
        }
    }

    /// Insert text at the caret, as a paste arrives.
    ///
    /// Control characters are dropped: the line holds one line, and a paste can carry newlines and
    /// tabs that a terminal would otherwise act on.
    pub fn insert_text(&mut self, text: &str) -> bool {
        let text: String = text.chars().filter(|ch| !ch.is_control()).collect();
        if text.is_empty() {
            return false;
        }
        let at = self.byte(self.caret);
        self.text.insert_str(at, &text);
        self.caret += text.chars().count();
        true
    }

    /// Delete the character at `index`, when there is one.
    fn remove(&mut self, index: Option<usize>) -> bool {
        let Some(index) = index else {
            return false;
        };
        let (start, end) = (self.byte(index), self.byte(index + 1));
        if start == end {
            return false;
        }
        self.text.replace_range(start..end, "");
        self.caret = index;
        true
    }

    fn move_caret(&mut self, step: isize) -> bool {
        let at = self.caret as isize + step;
        self.jump(at.clamp(0, self.len() as isize) as usize)
    }

    fn jump(&mut self, caret: usize) -> bool {
        if caret == self.caret {
            return false;
        }
        self.caret = caret;
        true
    }

    fn len(&self) -> usize {
        self.text.chars().count()
    }

    /// The byte offset of a char index, clamped to the end of the text.
    fn byte(&self, index: usize) -> usize {
        self.text
            .char_indices()
            .nth(index)
            .map_or(self.text.len(), |(byte, _)| byte)
    }
}
