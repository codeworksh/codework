use ratatui::style::{Modifier, Style};
use ratatui::text::Span;

use crate::ui::Theme;

pub fn parse_inline(text: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut chars = text.chars().peekable();
    let mut buffer = String::new();

    while let Some(&ch) = chars.peek() {
        if ch == '`' {
            if !buffer.is_empty() {
                spans.push(Span::styled(
                    std::mem::take(&mut buffer),
                    Style::default().fg(Theme::text_primary()),
                ));
            }
            chars.next(); // consume `
            let mut code = String::new();
            while let Some(c) = chars.next() {
                if c == '`' {
                    break;
                }
                code.push(c);
            }
            spans.push(Span::styled(
                code,
                Style::default().fg(Theme::success()),
            ));
        } else if ch == '*' {
            chars.next();
            if chars.peek() == Some(&'*') {
                chars.next(); // double * (bold)
                if !buffer.is_empty() {
                    spans.push(Span::styled(
                        std::mem::take(&mut buffer),
                        Style::default().fg(Theme::text_primary()),
                    ));
                }
                let mut bold_text = String::new();
                while let Some(c) = chars.next() {
                    if c == '*' && chars.peek() == Some(&'*') {
                        chars.next();
                        break;
                    }
                    bold_text.push(c);
                }
                spans.push(Span::styled(
                    bold_text,
                    Style::default()
                        .fg(Theme::warning())
                        .add_modifier(Modifier::BOLD),
                ));
            } else {
                // single * (italic)
                if !buffer.is_empty() {
                    spans.push(Span::styled(
                        std::mem::take(&mut buffer),
                        Style::default().fg(Theme::text_primary()),
                    ));
                }
                let mut italic_text = String::new();
                while let Some(c) = chars.next() {
                    if c == '*' {
                        break;
                    }
                    italic_text.push(c);
                }
                spans.push(Span::styled(
                    italic_text,
                    Style::default()
                        .fg(Theme::text_muted())
                        .add_modifier(Modifier::ITALIC),
                ));
            }
        } else if ch == '[' {
            if !buffer.is_empty() {
                spans.push(Span::styled(
                    std::mem::take(&mut buffer),
                    Style::default().fg(Theme::text_primary()),
                ));
            }
            chars.next(); // consume [
            let mut link_text = String::new();
            while let Some(c) = chars.next() {
                if c == ']' {
                    break;
                }
                link_text.push(c);
            }
            if chars.peek() == Some(&'(') {
                chars.next(); // consume (
                let mut _url = String::new();
                while let Some(c) = chars.next() {
                    if c == ')' {
                        break;
                    }
                    _url.push(c);
                }
                spans.push(Span::styled(
                    link_text,
                    Style::default()
                        .fg(Theme::primary())
                        .add_modifier(Modifier::UNDERLINED),
                ));
            } else {
                buffer.push('[');
                buffer.push_str(&link_text);
                buffer.push(']');
            }
        } else {
            buffer.push(ch);
            chars.next();
        }
    }

    if !buffer.is_empty() {
        spans.push(Span::styled(
            buffer,
            Style::default().fg(Theme::text_primary()),
        ));
    }

    spans
}
