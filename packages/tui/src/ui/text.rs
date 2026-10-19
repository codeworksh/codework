//! Text measured and cut the way a terminal shows it: columns, not bytes or characters.
//!
//! A buffer write is clipped by the buffer, not by the box it was aimed at, so anything that must
//! not run into a border has to be cut before it is written. The prompt line and the menus both
//! need that, which is why it lives here rather than in either of them.

use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

/// The longest prefix of `text` that fits `width` columns, cut on a character boundary. A character
/// wider than the room left is dropped rather than half-drawn.
pub fn fitted(text: &str, width: usize) -> &str {
    let mut used = 0;
    for (offset, ch) in text.char_indices() {
        let char_width = ch.width().unwrap_or(0);
        if used + char_width > width {
            return &text[..offset];
        }
        used += char_width;
    }
    text
}

/// A slice of `text` scrolled so the caret at the end of `before_caret` stays inside `width`
/// columns, and the column offset of the caret within that slice.
pub fn scrolled<'a>(text: &'a str, before_caret: &str, width: usize) -> (&'a str, u16) {
    let (mut used, mut start) = (0, before_caret.len());
    for (offset, ch) in before_caret.char_indices().rev() {
        let char_width = ch.width().unwrap_or(0);
        if used + char_width > width {
            break;
        }
        used += char_width;
        start = offset;
    }
    (fitted(&text[start..], width), used as u16)
}

/// The columns `text` takes, which is what a layout has to reserve for it.
pub fn width(text: &str) -> usize {
    text.width()
}

/// Fit `text` into `max_width` columns, replacing any cut tail with `…`.
pub fn elide(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if text.width() <= max_width {
        return text.to_string();
    }
    if max_width == 1 {
        return "…".to_string();
    }
    format!("{}…", fitted(text, max_width - 1))
}

/// Wrap `text` into lines that fit within `max_width` terminal columns.
pub fn wrap(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for raw_line in text.split('\n') {
        if raw_line.is_empty() {
            out.push(String::new());
            continue;
        }
        let mut current = String::new();
        let mut current_width = 0usize;
        for word in raw_line.split_whitespace() {
            let word_width = width(word);
            if current.is_empty() {
                if word_width <= max_width {
                    current.push_str(word);
                    current_width = word_width;
                } else {
                    let mut rest = word;
                    while !rest.is_empty() {
                        let part = fitted(rest, max_width);
                        if part.is_empty() {
                            break;
                        }
                        out.push(part.to_string());
                        rest = &rest[part.len()..];
                    }
                }
            } else if current_width + 1 + word_width <= max_width {
                current.push(' ');
                current.push_str(word);
                current_width += 1 + word_width;
            } else {
                out.push(current);
                current = word.to_string();
                current_width = word_width;
            }
        }
        if !current.is_empty() {
            out.push(current);
        }
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}
