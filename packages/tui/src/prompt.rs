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
#[derive(Default, Clone, PartialEq, Eq)]
pub struct Prompt {
    text: String,
    caret: usize,
    preferred_column: Option<usize>,
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
        self.preferred_column = None;
    }

    /// Apply one key. Reports whether the prompt changed, which is the redraw.
    pub fn edit(&mut self, key: KeyEvent) -> bool {
        match (key.code, key.modifiers) {
            (KeyCode::Enter, KeyModifiers::SHIFT) | (KeyCode::Char('j'), KeyModifiers::CONTROL) => {
                self.insert_text("\n")
            }
            (KeyCode::Home, KeyModifiers::CONTROL) => self.jump(0),
            (KeyCode::End, KeyModifiers::CONTROL) => self.jump(self.text.len()),
            (KeyCode::Char('a'), KeyModifiers::CONTROL) | (KeyCode::Home, _) => {
                self.jump(self.line_start())
            }
            (KeyCode::Char('e'), KeyModifiers::CONTROL) | (KeyCode::End, _) => {
                self.jump(self.line_end())
            }
            (KeyCode::Up, KeyModifiers::NONE) => self.vertical(-1),
            (KeyCode::Down, KeyModifiers::NONE) => self.vertical(1),
            (KeyCode::Char('u'), KeyModifiers::CONTROL) => {
                self.remove_range(self.line_start()..self.caret)
            }
            (KeyCode::Char('k'), KeyModifiers::CONTROL) => {
                self.remove_range(self.caret..self.line_end())
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
    /// Preserve newlines and indentation; normalize CRLF/CR and drop terminal control bytes.
    pub fn insert_text(&mut self, text: &str) -> bool {
        let mut clean = String::with_capacity(text.len());
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    clean.push('\n');
                }
                '\n' | '\t' => clean.push(ch),
                ch if !ch.is_control() => clean.push(ch),
                _ => {}
            }
        }
        if clean.is_empty() {
            return false;
        }
        self.text.insert_str(self.caret, &clean);
        self.caret += clean.len();
        self.preferred_column = None;
        true
    }

    pub fn insert_inline(&mut self, text: &str) -> bool {
        self.insert_text(&text.replace(['\r', '\n', '\t'], " "))
    }

    pub fn caret(&self) -> usize {
        self.caret
    }
    pub fn restore(text: &str, caret: usize) -> Self {
        let mut prompt = Self::default();
        prompt.insert_text(text);
        let mut at = caret.min(prompt.text.len());
        while !prompt.text.is_char_boundary(at) {
            at -= 1;
        }
        prompt.caret = at;
        prompt
    }
    fn line_start(&self) -> usize {
        self.text[..self.caret].rfind('\n').map_or(0, |at| at + 1)
    }
    fn line_end(&self) -> usize {
        self.text[self.caret..]
            .find('\n')
            .map_or(self.text.len(), |at| self.caret + at)
    }
    pub fn current_line(&self) -> (&str, &str) {
        let start = self.line_start();
        (
            &self.text[start..self.line_end()],
            &self.text[start..self.caret],
        )
    }

    fn vertical(&mut self, direction: isize) -> bool {
        let start = self.line_start();
        let end = self.line_end();
        let desired = self
            .preferred_column
            .unwrap_or_else(|| columns(&self.text[start..self.caret]));
        let target = if direction < 0 {
            if start == 0 {
                return false;
            }
            let end = start - 1;
            let start = self.text[..end].rfind('\n').map_or(0, |at| at + 1);
            start..end
        } else {
            if end == self.text.len() {
                return false;
            }
            let start = end + 1;
            let end = self.text[start..]
                .find('\n')
                .map_or(self.text.len(), |at| start + at);
            start..end
        };
        let mut column = 0;
        let mut at = target.start;
        for (offset, ch) in self.text[target.clone()].char_indices() {
            let width = cell_width(ch, column);
            if column + width > desired {
                break;
            }
            column += width;
            at = target.start + offset + ch.len_utf8();
        }
        let changed = self.jump(at);
        self.preferred_column = Some(desired);
        changed
    }

    /// Character wrapping preserves indentation and shares caret geometry with rendering.
    pub fn layout(&self, width: usize) -> PromptLayout {
        let width = width.max(1);
        let mut lines = vec![String::new()];
        let mut column = 0;
        let mut caret = (0, 0);
        for (at, ch) in self.text.char_indices() {
            let cells = cell_width(ch, column);
            if ch != '\n' && (column >= width || (ch != '\t' && column + cells > width)) {
                lines.push(String::new());
                column = 0;
            }
            if at == self.caret {
                caret = (column.min(width - 1), lines.len() - 1);
            }
            if ch == '\n' {
                lines.push(String::new());
                column = 0;
            } else if ch == '\t' {
                for _ in 0..cell_width(ch, column) {
                    if column >= width {
                        lines.push(String::new());
                        column = 0;
                    }
                    lines.last_mut().unwrap().push(' ');
                    column += 1;
                }
            } else {
                lines.last_mut().unwrap().push(ch);
                column += cell_width(ch, column);
            }
        }
        if self.caret == self.text.len() {
            if column >= width {
                lines.push(String::new());
                column = 0;
            }
            caret = (column, lines.len() - 1);
        }
        PromptLayout { lines, caret }
    }

    fn remove_range(&mut self, range: Range<usize>) -> bool {
        if range.is_empty() {
            return false;
        }
        let start = range.start;
        self.text.replace_range(range, "");
        self.caret = start;
        self.preferred_column = None;
        true
    }

    fn jump(&mut self, caret: usize) -> bool {
        if caret == self.caret {
            return false;
        }
        self.caret = caret;
        self.preferred_column = None;
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

pub struct PromptLayout {
    pub lines: Vec<String>,
    pub caret: (usize, usize),
}
fn cell_width(ch: char, column: usize) -> usize {
    if ch == '\t' {
        4 - column % 4
    } else {
        unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0)
    }
}
fn columns(text: &str) -> usize {
    text.chars()
        .fold(0, |column, ch| column + cell_width(ch, column))
}
