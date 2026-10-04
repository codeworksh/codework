use ratatui::style::Color;

pub struct Theme;

impl Theme {
    pub const ACCENT: Color = Color::Rgb(6, 182, 212); // Cyan #06b6d4
    pub const SKY: Color = Color::Rgb(56, 189, 248); // Sky #38bdf8
    pub const PINK: Color = Color::Rgb(236, 72, 153); // Pink #ec4899
    pub const MODEL: Color = Color::Rgb(192, 132, 252); // Purple #c084fc
    pub const SUCCESS: Color = Color::Rgb(16, 185, 129); // Green #10b981
    pub const ACTIVITY: Color = Color::Rgb(250, 204, 21); // Yellow #facc15
    pub const ERROR: Color = Color::Rgb(248, 113, 113); // Red #f87171
    pub const BORDER: Color = Color::Rgb(39, 39, 42); // Dark zinc #27272a
    pub const BORDER_BOX: Color = Color::Rgb(63, 63, 70); // Zinc 700 #3f3f46
    #[allow(dead_code)]
    pub const BG_CARD: Color = Color::Rgb(18, 18, 20); // Very dark card
    pub const TEXT_PRIMARY: Color = Color::Rgb(244, 244, 245); // Zinc 100
    pub const TEXT_MUTED: Color = Color::Rgb(113, 113, 122); // Zinc 500 #71717a
    pub const TEXT_SECONDARY: Color = Color::Rgb(161, 161, 170); // Zinc 400
    #[allow(dead_code)]
    pub const CODE_ACCENT: Color = Color::Rgb(74, 222, 128); // Green #4ade80
    #[allow(dead_code)]
    pub const BOLD_ACCENT: Color = Color::Rgb(251, 146, 60); // Orange #fb923c
}
