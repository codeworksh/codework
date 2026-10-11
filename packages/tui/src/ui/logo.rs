use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::ui::spinner::SPINNER_FRAMES;

pub const LOGO_LINES: [&str; 5] = [
    "▄██████▄  ▄██   ▄██▄",
    "██▀       ███   ████",
    "██        ███ █ ████",
    "██▄       ██████████",
    "▀██████▀   ▀█▀   ▀█▀",
];

pub const LOGO_GRADIENT: [Color; 9] = [
    Color::Rgb(243, 139, 168), // Pink #F38BA8
    Color::Rgb(235, 160, 172), // Yellow-ish #EBA0AC
    Color::Rgb(215, 175, 215), // Mid Flamingo-Lavender
    Color::Rgb(180, 190, 254), // Active Lavender #B4BEFE
    Color::Rgb(158, 185, 252), // Mid Lavender-Blue
    Color::Rgb(137, 180, 250), // Blue accent #89B4FA
    Color::Rgb(126, 189, 243), // Mid Blue-Cyan
    Color::Rgb(115, 199, 236), // Cyan #73C7EC
    Color::Rgb(166, 227, 161), // Green #A6E3A1
];

pub const LOGO_SPARKLE_FRAMES: &[&str] = &["✦", "✧", "✶", "✷", "✸", "✶", "✧", "✦"];

#[allow(dead_code)]
pub fn render_logo_lines(pad_left: usize) -> Vec<Line<'static>> {
    render_animated_logo_lines(pad_left, 0)
}

pub fn render_animated_logo_lines(pad_left: usize, tick: usize) -> Vec<Line<'static>> {
    let mut result = Vec::new();
    let prefix = " ".repeat(pad_left);
    for line in LOGO_LINES {
        let chars: Vec<char> = line.chars().collect();
        let mut spans = Vec::new();
        if !prefix.is_empty() {
            spans.push(Span::raw(prefix.clone()));
        }
        for (col_idx, &ch) in chars.iter().enumerate() {
            let base_idx = ((col_idx as f32 / chars.len() as f32) * LOGO_GRADIENT.len() as f32) as usize;
            let color_idx = (base_idx + tick) % LOGO_GRADIENT.len();
            let color = LOGO_GRADIENT[color_idx];
            spans.push(Span::styled(ch.to_string(), Style::default().fg(color)));
        }
        result.push(Line::from(spans));
    }
    result
}

pub fn render_header_logo(tick: usize, is_streaming: bool) -> Vec<Span<'static>> {
    let mut spans = Vec::new();

    // 1. Animated Logo Icon
    let icon_frame = if is_streaming {
        SPINNER_FRAMES[tick % SPINNER_FRAMES.len()]
    } else {
        LOGO_SPARKLE_FRAMES[(tick / 2) % LOGO_SPARKLE_FRAMES.len()]
    };

    let icon_color = LOGO_GRADIENT[tick % LOGO_GRADIENT.len()];
    spans.push(Span::styled(
        format!("{} ", icon_frame),
        Style::default().fg(icon_color).add_modifier(Modifier::BOLD),
    ));

    // 2. Animated Wordmark "codework" with flowing gradient wave
    let word = "codework";
    for (i, ch) in word.chars().enumerate() {
        let color_idx = (i + tick) % LOGO_GRADIENT.len();
        let color = LOGO_GRADIENT[color_idx];
        spans.push(Span::styled(
            ch.to_string(),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ));
    }
    spans.push(Span::raw(" "));

    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_logo_dimensions() {
        assert_eq!(LOGO_LINES.len(), 5);
        for line in LOGO_LINES {
            assert_eq!(line.chars().count(), 20);
        }
    }

    #[test]
    fn test_render_logo_lines() {
        let rendered = render_logo_lines(2);
        assert_eq!(rendered.len(), 5);
        assert_eq!(rendered[0].spans[0].content, "  ");
    }

    #[test]
    fn test_render_animated_logo_lines() {
        let rendered_tick0 = render_animated_logo_lines(0, 0);
        let rendered_tick1 = render_animated_logo_lines(0, 1);
        assert_eq!(rendered_tick0.len(), 5);
        assert_eq!(rendered_tick1.len(), 5);
        // Colors should shift between ticks
        assert_ne!(rendered_tick0[0].spans[0].style.fg, rendered_tick1[0].spans[0].style.fg);
    }

    #[test]
    fn test_render_header_logo() {
        let spans_idle = render_header_logo(0, false);
        assert!(!spans_idle.is_empty());
        assert_eq!(spans_idle[0].content, "✦ ");
        // Wordmark should spell "codework"
        let word: String = spans_idle[1..=8].iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(word, "codework");

        let spans_streaming = render_header_logo(0, true);
        assert_eq!(spans_streaming[0].content, "⠋ ");
    }
}
