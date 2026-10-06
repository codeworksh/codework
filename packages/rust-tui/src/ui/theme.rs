use ratatui::style::Color;

pub struct Theme;

#[allow(dead_code)]
impl Theme {
    // ------------------------------------------------------------------------
    // User Color Palette (Catppuccin Mocha / Superfile)
    // ------------------------------------------------------------------------
    /// Background: #1E1E2E
    pub const BG_APP: Color = Color::Rgb(30, 30, 46);

    /// Surface / Cards: #252538 (Elevated Base)
    pub const BG_SURFACE: Color = Color::Rgb(37, 37, 56);
    pub const BG_CARD: Color = Color::Rgb(37, 37, 56);

    /// User Message Bubble Surface: #313244 (Surface0)
    pub const BG_USER_MSG: Color = Color::Rgb(49, 50, 68);

    /// Muted border: #6C7086
    pub const BORDER: Color = Color::Rgb(108, 112, 134);
    pub const BORDER_BOX: Color = Color::Rgb(108, 112, 134);

    /// Active border: #B4BEFE
    pub const BORDER_ACTIVE: Color = Color::Rgb(180, 190, 254);
    pub const BORDER_USER_MSG: Color = Color::Rgb(180, 190, 254);

    /// Active / Lavender: #B4BEFE
    pub const PRIMARY: Color = Color::Rgb(180, 190, 254);
    pub const MODEL: Color = Color::Rgb(180, 190, 254);

    /// Blue accent: #89B4FA
    pub const ACCENT: Color = Color::Rgb(137, 180, 250);
    pub const SECONDARY: Color = Color::Rgb(137, 180, 250);
    pub const TEXT_SECONDARY: Color = Color::Rgb(137, 180, 250);

    /// Cyan / hint: #73C7EC
    pub const SKY: Color = Color::Rgb(115, 199, 236);
    pub const HINT: Color = Color::Rgb(115, 199, 236);

    /// Pink / important / error: #F38BA8
    pub const PINK: Color = Color::Rgb(243, 139, 168);
    pub const ERROR: Color = Color::Rgb(243, 139, 168);

    /// Green / success: #A6E3A1
    pub const SUCCESS: Color = Color::Rgb(166, 227, 161);
    pub const CODE_ACCENT: Color = Color::Rgb(166, 227, 161);

    /// Yellow-ish: #EBA0AC
    pub const WARNING: Color = Color::Rgb(235, 160, 172);
    pub const ACTIVITY: Color = Color::Rgb(235, 160, 172);
    pub const BOLD_ACCENT: Color = Color::Rgb(235, 160, 172);

    /// Primary text: #A6ADC8
    pub const TEXT_PRIMARY: Color = Color::Rgb(166, 173, 200);

    /// Muted border / text: #6C7086
    pub const TEXT_MUTED: Color = Color::Rgb(108, 112, 134);
}
