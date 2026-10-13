use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// The whole UI today: one screen that says hello, and one piece of state — whether
/// the user has asked to leave. Prompt entry, model selection and the session view
/// are deliberately not built yet.
pub struct App {
    pub should_quit: bool,
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

impl App {
    pub fn new() -> Self {
        Self { should_quit: false }
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => self.should_quit = true,
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.should_quit = true;
            }
            _ => {}
        }
    }
}
