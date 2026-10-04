use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

pub fn parse_inline(text: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut chars = text.chars().peekable();
    let mut buffer = String::new();

    while let Some(&ch) = chars.peek() {
        if ch == '`' {
            if !buffer.is_empty() {
                spans.push(Span::styled(
                    std::mem::take(&mut buffer),
                    Style::default().fg(Color::Rgb(244, 244, 245)),
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
                Style::default().fg(Color::Rgb(74, 222, 128)),
            ));
        } else if ch == '*' {
            chars.next();
            if chars.peek() == Some(&'*') {
                chars.next(); // double * (bold)
                if !buffer.is_empty() {
                    spans.push(Span::styled(
                        std::mem::take(&mut buffer),
                        Style::default().fg(Color::Rgb(244, 244, 245)),
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
                        .fg(Color::Rgb(251, 146, 60))
                        .add_modifier(Modifier::BOLD),
                ));
            } else {
                // single * (italic)
                if !buffer.is_empty() {
                    spans.push(Span::styled(
                        std::mem::take(&mut buffer),
                        Style::default().fg(Color::Rgb(244, 244, 245)),
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
                        .fg(Color::Rgb(161, 161, 170))
                        .add_modifier(Modifier::ITALIC),
                ));
            }
        } else if ch == '[' {
            if !buffer.is_empty() {
                spans.push(Span::styled(
                    std::mem::take(&mut buffer),
                    Style::default().fg(Color::Rgb(244, 244, 245)),
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
                        .fg(Color::Rgb(6, 182, 212))
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
            Style::default().fg(Color::Rgb(244, 244, 245)),
        ));
    }

    spans
}
