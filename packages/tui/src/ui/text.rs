//! Width-aware text helpers shared by the transcript renderers.

use unicode_width::UnicodeWidthStr;

/// Truncates `text` to at most `max_width` display columns, appending `…` when
/// it does not fit.
///
/// Width is measured in Unicode columns rather than bytes or characters, so a
/// line of CJK text or emoji stays inside the pane instead of overflowing it.
pub fn elide(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(text) <= max_width {
        return text.to_string();
    }
    let mut out = String::new();
    let mut width = 0usize;
    for ch in text.chars() {
        let ch_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        // +1 reserves the column the ellipsis itself needs.
        if width + ch_width + 1 > max_width {
            break;
        }
        out.push(ch);
        width += ch_width;
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_text_that_fits() {
        assert_eq!(elide("src/app.ts", 40), "src/app.ts");
        assert_eq!(elide("src/app.ts", 10), "src/app.ts");
    }

    #[test]
    fn adds_an_ellipsis_when_it_cannot_fit() {
        assert_eq!(elide("abcdefghij", 5), "abcd…");
    }

    #[test]
    fn zero_width_yields_nothing() {
        assert_eq!(elide("anything", 0), "");
    }

    #[test]
    fn measures_display_columns_not_characters() {
        // Each glyph is two columns, so five of them plus the ellipsis fill exactly
        // eleven — a byte- or char-based cut would have overflowed the pane.
        let elided = elide("你好你好你好", 11);
        assert_eq!(elided, "你好你好你…");
        assert_eq!(UnicodeWidthStr::width(elided.as_str()), 11);
    }
}
