//! The active palette.
//!
//! The landing site owns the colours. It ships 22 palettes that each fill the same 16 tokens, and
//! `scripts/themes.mjs` turns them into [`palettes`] so the two surfaces cannot drift. Widgets read
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

/// One palette: the site's 16 tokens, and how it is named.
///
/// The tokens are the whole contract, so a palette carries all 16 even while the UI draws with a
/// few of them — that is what keeps a new widget from having to re-pull every theme. Every id here
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
