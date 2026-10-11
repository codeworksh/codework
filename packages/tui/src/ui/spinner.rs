pub const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Number of 80ms ticks per caret blink phase (~480ms on / ~480ms off).
const BLINK_TICKS: usize = 6;

#[derive(Debug, Clone, Default)]
pub struct Spinner {
    frame: usize,
    tick_count: usize,
    blink_tick: usize,
}

impl Spinner {
    pub fn new() -> Self {
        Self {
            frame: 0,
            tick_count: 0,
            blink_tick: 0,
        }
    }

    pub fn tick(&mut self) {
        self.frame = (self.frame + 1) % SPINNER_FRAMES.len();
        self.tick_count = self.tick_count.wrapping_add(1);
        self.blink_tick = self.blink_tick.wrapping_add(1);
    }

    pub fn current(&self) -> &'static str {
        SPINNER_FRAMES[self.frame]
    }


    pub fn tick_count(&self) -> usize {
        self.tick_count
    }

    /// Whether the text caret should currently be drawn.
    /// Toggles on a fixed cadence driven by the render tick.
    pub fn cursor_visible(&self) -> bool {
        (self.blink_tick / BLINK_TICKS) % 2 == 0
    }

    /// Restart the caret blink cycle. Call on user input so the caret stays
    /// solid while typing instead of vanishing mid-keystroke.
    pub fn reset_blink(&mut self) {
        self.blink_tick = 0;
    }
}

