use std::sync::atomic::{AtomicUsize, Ordering};

use ratatui::style::Color;

/// One full palette. Every palette fills the same role set, so any palette can
/// be swapped in at runtime without touching call sites. Add a palette to
/// [`PALETTES`] and it shows up in the `/theme` picker automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    pub id: &'static str,
    pub label: &'static str,
    pub dark: bool,
    pub bg_app: Color,
    pub bg_surface: Color,
    pub bg_card: Color,
    pub bg_user_msg: Color,
    pub border: Color,
    pub border_box: Color,
    pub border_active: Color,
    pub border_user_msg: Color,
    pub primary: Color,
    pub model: Color,
    pub accent: Color,
    pub secondary: Color,
    pub text_secondary: Color,
    pub sky: Color,
    pub hint: Color,
    pub pink: Color,
    pub error: Color,
    pub success: Color,
    pub code_accent: Color,
    pub warning: Color,
    pub activity: Color,
    pub bold_accent: Color,
    pub text_primary: Color,
    pub text_muted: Color,
    pub diff_add_bg: Color,
    pub diff_del_bg: Color,
    pub diff_hunk: Color,
    pub diff_meta: Color,
}

/// Catppuccin Mocha — the original CodeWork look.
const CATPPUCCIN_MOCHA: Palette = Palette {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    dark: true,
    bg_app: Color::Rgb(30, 30, 46),
    bg_surface: Color::Rgb(37, 37, 56),
    bg_card: Color::Rgb(37, 37, 56),
    bg_user_msg: Color::Rgb(49, 50, 68),
    border: Color::Rgb(108, 112, 134),
    border_box: Color::Rgb(108, 112, 134),
    border_active: Color::Rgb(180, 190, 254),
    border_user_msg: Color::Rgb(180, 190, 254),
    primary: Color::Rgb(180, 190, 254),
    model: Color::Rgb(180, 190, 254),
    accent: Color::Rgb(137, 180, 250),
    secondary: Color::Rgb(137, 180, 250),
    text_secondary: Color::Rgb(137, 180, 250),
    sky: Color::Rgb(115, 199, 236),
    hint: Color::Rgb(115, 199, 236),
    pink: Color::Rgb(243, 139, 168),
    error: Color::Rgb(243, 139, 168),
    success: Color::Rgb(166, 227, 161),
    code_accent: Color::Rgb(166, 227, 161),
    warning: Color::Rgb(235, 160, 172),
    activity: Color::Rgb(235, 160, 172),
    bold_accent: Color::Rgb(235, 160, 172),
    text_primary: Color::Rgb(166, 173, 200),
    text_muted: Color::Rgb(108, 112, 134),
    diff_add_bg: Color::Rgb(30, 46, 36),
    diff_del_bg: Color::Rgb(52, 31, 40),
    diff_hunk: Color::Rgb(115, 199, 236),
    diff_meta: Color::Rgb(108, 112, 134),
};

/// Tokyo Night — deep blue-black with violet accents.
const TOKYO_NIGHT: Palette = Palette {
    id: "tokyo-night",
    label: "Tokyo Night",
    dark: true,
    bg_app: Color::Rgb(26, 27, 38),
    bg_surface: Color::Rgb(31, 33, 46),
    bg_card: Color::Rgb(31, 33, 46),
    bg_user_msg: Color::Rgb(41, 46, 66),
    border: Color::Rgb(41, 46, 66),
    border_box: Color::Rgb(41, 46, 66),
    border_active: Color::Rgb(125, 207, 255),
    border_user_msg: Color::Rgb(125, 207, 255),
    primary: Color::Rgb(187, 154, 247),
    model: Color::Rgb(125, 207, 255),
    accent: Color::Rgb(125, 207, 255),
    secondary: Color::Rgb(125, 207, 255),
    text_secondary: Color::Rgb(125, 207, 255),
    sky: Color::Rgb(125, 207, 255),
    hint: Color::Rgb(125, 207, 255),
    pink: Color::Rgb(247, 118, 142),
    error: Color::Rgb(247, 118, 142),
    success: Color::Rgb(158, 206, 106),
    code_accent: Color::Rgb(158, 206, 106),
    warning: Color::Rgb(224, 175, 104),
    activity: Color::Rgb(224, 175, 104),
    bold_accent: Color::Rgb(224, 175, 104),
    text_primary: Color::Rgb(192, 202, 245),
    text_muted: Color::Rgb(86, 95, 137),
    diff_add_bg: Color::Rgb(32, 44, 33),
    diff_del_bg: Color::Rgb(51, 34, 46),
    diff_hunk: Color::Rgb(125, 207, 255),
    diff_meta: Color::Rgb(86, 95, 137),
};

/// Gruvbox Dark — warm earth tones.
const GRUVBOX_DARK: Palette = Palette {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    dark: true,
    bg_app: Color::Rgb(40, 40, 40),
    bg_surface: Color::Rgb(50, 50, 50),
    bg_card: Color::Rgb(50, 50, 50),
    bg_user_msg: Color::Rgb(60, 56, 54),
    border: Color::Rgb(124, 111, 100),
    border_box: Color::Rgb(124, 111, 100),
    border_active: Color::Rgb(184, 187, 38),
    border_user_msg: Color::Rgb(184, 187, 38),
    primary: Color::Rgb(250, 189, 47),
    model: Color::Rgb(184, 187, 38),
    accent: Color::Rgb(131, 165, 152),
    secondary: Color::Rgb(131, 165, 152),
    text_secondary: Color::Rgb(131, 165, 152),
    sky: Color::Rgb(131, 165, 152),
    hint: Color::Rgb(131, 165, 152),
    pink: Color::Rgb(251, 73, 52),
    error: Color::Rgb(251, 73, 52),
    success: Color::Rgb(184, 187, 38),
    code_accent: Color::Rgb(184, 187, 38),
    warning: Color::Rgb(254, 128, 25),
    activity: Color::Rgb(254, 128, 25),
    bold_accent: Color::Rgb(254, 128, 25),
    text_primary: Color::Rgb(235, 219, 178),
    text_muted: Color::Rgb(146, 131, 116),
    diff_add_bg: Color::Rgb(50, 54, 38),
    diff_del_bg: Color::Rgb(58, 42, 38),
    diff_hunk: Color::Rgb(131, 165, 152),
    diff_meta: Color::Rgb(146, 131, 116),
};

/// Catppuccin Latte — Catppuccin's light variant.
const CATPPUCCIN_LATTE: Palette = Palette {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    dark: false,
    bg_app: Color::Rgb(239, 241, 245),
    bg_surface: Color::Rgb(230, 233, 239),
    bg_card: Color::Rgb(230, 233, 239),
    bg_user_msg: Color::Rgb(204, 208, 216),
    border: Color::Rgb(140, 143, 160),
    border_box: Color::Rgb(140, 143, 160),
    border_active: Color::Rgb(30, 102, 245),
    border_user_msg: Color::Rgb(30, 102, 245),
    primary: Color::Rgb(114, 135, 253),
    model: Color::Rgb(114, 135, 253),
    accent: Color::Rgb(4, 165, 229),
    secondary: Color::Rgb(4, 165, 229),
    text_secondary: Color::Rgb(4, 165, 229),
    sky: Color::Rgb(4, 165, 229),
    hint: Color::Rgb(4, 165, 229),
    pink: Color::Rgb(210, 15, 57),
    error: Color::Rgb(210, 15, 57),
    success: Color::Rgb(64, 160, 43),
    code_accent: Color::Rgb(64, 160, 43),
    warning: Color::Rgb(223, 142, 29),
    activity: Color::Rgb(223, 142, 29),
    bold_accent: Color::Rgb(223, 142, 29),
    text_primary: Color::Rgb(92, 99, 112),
    text_muted: Color::Rgb(140, 143, 160),
    diff_add_bg: Color::Rgb(214, 236, 216),
    diff_del_bg: Color::Rgb(245, 213, 218),
    diff_hunk: Color::Rgb(4, 165, 229),
    diff_meta: Color::Rgb(140, 143, 160),
};

/// GitHub Light — the classic clean light theme.
const GITHUB_LIGHT: Palette = Palette {
    id: "github-light",
    label: "GitHub Light",
    dark: false,
    bg_app: Color::Rgb(255, 255, 255),
    bg_surface: Color::Rgb(246, 248, 250),
    bg_card: Color::Rgb(246, 248, 250),
    bg_user_msg: Color::Rgb(234, 238, 242),
    border: Color::Rgb(208, 215, 222),
    border_box: Color::Rgb(208, 215, 222),
    border_active: Color::Rgb(9, 105, 218),
    border_user_msg: Color::Rgb(9, 105, 218),
    primary: Color::Rgb(135, 86, 228),
    model: Color::Rgb(9, 105, 218),
    accent: Color::Rgb(9, 105, 218),
    secondary: Color::Rgb(9, 105, 218),
    text_secondary: Color::Rgb(9, 105, 218),
    sky: Color::Rgb(9, 105, 218),
    hint: Color::Rgb(9, 105, 218),
    pink: Color::Rgb(207, 34, 46),
    error: Color::Rgb(207, 34, 46),
    success: Color::Rgb(26, 127, 55),
    code_accent: Color::Rgb(26, 127, 55),
    warning: Color::Rgb(154, 103, 0),
    activity: Color::Rgb(154, 103, 0),
    bold_accent: Color::Rgb(154, 103, 0),
    text_primary: Color::Rgb(31, 35, 40),
    text_muted: Color::Rgb(101, 108, 118),
    diff_add_bg: Color::Rgb(218, 244, 224),
    diff_del_bg: Color::Rgb(255, 224, 227),
    diff_hunk: Color::Rgb(9, 105, 218),
    diff_meta: Color::Rgb(101, 108, 118),
};

/// Solarized Light — the timeless warm light theme.
const SOLARIZED_LIGHT: Palette = Palette {
    id: "solarized-light",
    label: "Solarized Light",
    dark: false,
    bg_app: Color::Rgb(253, 246, 227),
    bg_surface: Color::Rgb(238, 232, 213),
    bg_card: Color::Rgb(238, 232, 213),
    bg_user_msg: Color::Rgb(221, 215, 195),
    border: Color::Rgb(147, 161, 161),
    border_box: Color::Rgb(147, 161, 161),
    border_active: Color::Rgb(38, 139, 210),
    border_user_msg: Color::Rgb(38, 139, 210),
    primary: Color::Rgb(133, 153, 0),
    model: Color::Rgb(38, 139, 210),
    accent: Color::Rgb(38, 139, 210),
    secondary: Color::Rgb(38, 139, 210),
    text_secondary: Color::Rgb(38, 139, 210),
    sky: Color::Rgb(38, 139, 210),
    hint: Color::Rgb(38, 139, 210),
    pink: Color::Rgb(220, 50, 47),
    error: Color::Rgb(220, 50, 47),
    success: Color::Rgb(133, 153, 0),
    code_accent: Color::Rgb(133, 153, 0),
    warning: Color::Rgb(203, 75, 22),
    activity: Color::Rgb(203, 75, 22),
    bold_accent: Color::Rgb(203, 75, 22),
    text_primary: Color::Rgb(101, 123, 131),
    text_muted: Color::Rgb(147, 161, 161),
    diff_add_bg: Color::Rgb(230, 240, 213),
    diff_del_bg: Color::Rgb(250, 229, 224),
    diff_hunk: Color::Rgb(38, 139, 210),
    diff_meta: Color::Rgb(147, 161, 161),
};

/// The 6 built-in themes: 3 dark, 3 light.
pub const PALETTES: &[Palette] = &[
    CATPPUCCIN_MOCHA,
    TOKYO_NIGHT,
    GRUVBOX_DARK,
    CATPPUCCIN_LATTE,
    GITHUB_LIGHT,
    SOLARIZED_LIGHT,
];

static ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// Switch the active palette by index; returns `false` when out of range.
pub fn set_active(index: usize) -> bool {
    if index >= PALETTES.len() {
        return false;
    }
    ACTIVE.store(index, Ordering::Relaxed);
    true
}

/// Index of the active palette into [`PALETTES`].
pub fn active_index() -> usize {
    ACTIVE.load(Ordering::Relaxed)
}

pub fn active() -> &'static Palette {
    &PALETTES[ACTIVE.load(Ordering::Relaxed)]
}

/// Look up a palette by id, e.g. to restore a persisted choice.
pub fn by_id(id: &str) -> Option<usize> {
    PALETTES.iter().position(|p| p.id == id)
}

/// Legacy role names used across the codebase, resolved against the active
/// palette. `Theme::bg_app()` etc. read naturally next to the old
/// `Theme::BG_APP` constants they replaced.
pub struct Theme;

#[allow(dead_code)]
impl Theme {
    pub fn bg_app() -> Color {
        active().bg_app
    }
    pub fn bg_surface() -> Color {
        active().bg_surface
    }
    pub fn bg_card() -> Color {
        active().bg_card
    }
    pub fn bg_user_msg() -> Color {
        active().bg_user_msg
    }
    pub fn border() -> Color {
        active().border
    }
    pub fn border_box() -> Color {
        active().border_box
    }
    pub fn border_active() -> Color {
        active().border_active
    }
    pub fn border_user_msg() -> Color {
        active().border_user_msg
    }
    pub fn primary() -> Color {
        active().primary
    }
    pub fn model() -> Color {
        active().model
    }
    pub fn accent() -> Color {
        active().accent
    }
    pub fn secondary() -> Color {
        active().secondary
    }
    pub fn text_secondary() -> Color {
        active().text_secondary
    }
    pub fn sky() -> Color {
        active().sky
    }
    pub fn hint() -> Color {
        active().hint
    }
    pub fn pink() -> Color {
        active().pink
    }
    pub fn error() -> Color {
        active().error
    }
    pub fn success() -> Color {
        active().success
    }
    pub fn code_accent() -> Color {
        active().code_accent
    }
    pub fn warning() -> Color {
        active().warning
    }
    pub fn activity() -> Color {
        active().activity
    }
    pub fn bold_accent() -> Color {
        active().bold_accent
    }
    pub fn text_primary() -> Color {
        active().text_primary
    }
    pub fn text_muted() -> Color {
        active().text_muted
    }
    pub fn diff_add_bg() -> Color {
        active().diff_add_bg
    }
    pub fn diff_del_bg() -> Color {
        active().diff_del_bg
    }
    pub fn diff_hunk() -> Color {
        active().diff_hunk
    }
    pub fn diff_meta() -> Color {
        active().diff_meta
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_palettes_split_dark_light() {
        assert_eq!(PALETTES.len(), 6);
        assert_eq!(PALETTES.iter().filter(|p| p.dark).count(), 3);
        assert_eq!(PALETTES.iter().filter(|p| !p.dark).count(), 3);
    }

    #[test]
    fn ids_are_unique_and_lookup_works() {
        for (i, p) in PALETTES.iter().enumerate() {
            assert_eq!(by_id(p.id), Some(i));
        }
        assert_eq!(by_id("nope"), None);
    }

    /// One sequential test: the active palette is process-global, so parallel
    /// tests touching it would race.
    #[test]
    fn set_active_switches_roles_and_rejects_out_of_range() {
        let original = active_index();
        assert!(set_active(2));
        assert_eq!(active_index(), 2);
        assert_eq!(Theme::bg_app(), GRUVBOX_DARK.bg_app);
        assert!(!set_active(6));
        assert_eq!(active_index(), 2);

        assert!(set_active(by_id("solarized-light").unwrap()));
        assert_eq!(Theme::text_primary(), SOLARIZED_LIGHT.text_primary);

        assert!(set_active(original));
    }
}
