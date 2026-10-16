//! The active palette.
//!
//! The landing site owns the colours. It ships 22 palettes that each fill the same 16 tokens, and
//! its canvas derives one more ink from two of them; `scripts/themes.mjs` turns both into
//! [`palettes`] so the two surfaces cannot drift. Widgets read
//! roles off these tokens; the semantic layer — feedback colours, diff colours, syntax hues — needs
//! colours the site does not have, and arrives with the widgets that draw them.

mod palettes;

pub use palettes::{DEFAULT, PALETTES};

use ratatui::style::Color;

/// Whether a palette is drawn for a light or a dark terminal. The landing canvas leans on this to
/// decide how it is lit, and the TUI will need it the first time a role has to be nudged for
/// contrast.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Dark,
    Light,
}

impl Scheme {
    /// What the scheme is called, as the theme picker's note beside a palette's name.
    pub fn name(self) -> &'static str {
        match self {
            Scheme::Dark => "dark",
            Scheme::Light => "light",
        }
    }
}

/// One palette: the site's 16 tokens plus the ink its canvas derives, and how it is named.
///
/// The tokens are the whole contract, so a palette carries all of them even while the UI draws
/// with a few — that is what keeps a new widget from having to re-pull every theme. Every id here
/// is generated from the site and cross-checked against its registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    pub id: &'static str,
    pub name: &'static str,
    pub scheme: Scheme,
    /// The page background: the app's own ground.
    pub bg: Color,
    /// Cards, popovers, prose blocks.
    pub surface: Color,
    /// A muted or secondary surface; also the hover and accent fill.
    pub surface_2: Color,
    /// Hairlines, card borders, dividers.
    pub border_subtle: Color,
    /// Emphasised borders.
    pub border_strong: Color,
    /// Primary text.
    pub text: Color,
    /// Secondary text.
    pub text_secondary: Color,
    /// Muted text and captions.
    pub text_muted: Color,
    /// The accent: links, the primary action, the focus ring.
    pub brand: Color,
    /// Ink drawn on top of a `brand` fill.
    pub brand_ink: Color,
    /// The accent ramp: five steps through `brand`, plus the ground they sit on. The landing
    /// canvas reads these at runtime, and they are the natural source for a banner or a spinner.
    pub field_bg: Color,
    /// The landing canvas's hairline lattice, mixed 22% from `field_bg` toward `field_dim`. The
    /// site derives it at runtime rather than storing it; the generator bakes the same mix in.
    pub field_grid: Color,
    pub field_dim: Color,
    pub field_mid: Color,
    pub field_lit: Color,
    pub field_hover: Color,
    pub field_crest: Color,
}

/// The palette the TUI opens on, which is the site's own default.
pub fn default_palette() -> &'static Palette {
    // `DEFAULT` is generated from the site and checked against `PALETTES` by `scripts/themes.mjs`,
    // so a miss here means the generated file is out of date.
    by_id(DEFAULT).expect("DEFAULT is a generated palette id")
}

/// The palette with this id, if it is one of the site's.
pub fn by_id(id: &str) -> Option<&'static Palette> {
    PALETTES.iter().find(|palette| palette.id == id)
}

impl Palette {
    /// Positive feedback / added diff lines.
    pub fn success(&self) -> Color {
        match self.scheme {
            Scheme::Dark => Color::Rgb(158, 206, 106),
            Scheme::Light => Color::Rgb(30, 127, 62),
        }
    }

    /// Negative feedback / removed diff lines / errors.
    pub fn error(&self) -> Color {
        match self.scheme {
            Scheme::Dark => Color::Rgb(247, 118, 142),
            Scheme::Light => Color::Rgb(209, 36, 47),
        }
    }

    /// Warning / notice indicator.
    pub fn warning(&self) -> Color {
        match self.scheme {
            Scheme::Dark => Color::Rgb(224, 175, 104),
            Scheme::Light => Color::Rgb(176, 109, 15),
        }
    }

    /// Subtle background fill for added diff lines, blended onto `self.bg`.
    pub fn diff_add_bg(&self) -> Color {
        mix(self.bg, self.success(), 14)
    }

    /// Subtle background fill for removed diff lines, blended onto `self.bg`.
    pub fn diff_del_bg(&self) -> Color {
        mix(self.bg, self.error(), 14)
    }

    /// Gutter (line-number column) background for added diff lines.
    pub fn diff_add_gutter_bg(&self) -> Color {
        mix(self.bg, self.success(), 26)
    }

    /// Gutter (line-number column) background for removed diff lines.
    pub fn diff_del_gutter_bg(&self) -> Color {
        mix(self.bg, self.error(), 26)
    }
}

fn mix(base: Color, tint: Color, pct: u16) -> Color {
    match (base, tint) {
        (Color::Rgb(br, bg, bb), Color::Rgb(tr, tg, tb)) => {
            let keep = 100u16.saturating_sub(pct);
            Color::Rgb(
                ((br as u16 * keep + tr as u16 * pct) / 100) as u8,
                ((bg as u16 * keep + tg as u16 * pct) / 100) as u8,
                ((bb as u16 * keep + tb as u16 * pct) / 100) as u8,
            )
        }
        _ => base,
    }
}
