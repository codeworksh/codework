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
