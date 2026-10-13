//! Terminal lifecycle.
//!
//! Everything that takes over the user's terminal — raw mode, the alternate
//! screen, the input modes we switch on, the background colour — is turned on
//! here and turned off in exactly one place. `restore` is idempotent and is
//! reached from three directions: the guard's `Drop`, the panic hook, and normal
//! shutdown, so a panic or an early return cannot leave a shell with no echo.

use std::io::{self, Stdout, Write};
use std::panic;
use std::sync::Once;

use crossterm::cursor::Show;
use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, BeginSynchronizedUpdate, EndSynchronizedUpdate,
    EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::style::Color;
use ratatui::{Frame, Terminal};

pub type Tui = Terminal<CrosstermBackend<Stdout>>;

/// Escape hatch for a terminal that garbles the keyboard protocol (VS Code over
/// WSL is the known one, where it breaks dead-key composition).
const NO_KEYBOARD_ENHANCEMENT: &str = "CODEWORK_TUI_NO_KEYBOARD_ENHANCEMENT";

/// The terminal, owned for as long as the UI runs. Dropping it hands the
/// terminal back.
pub struct TerminalGuard {
    terminal: Tui,
    background: Color,
}

impl TerminalGuard {
    /// Take over the terminal.
    pub fn init(background: Color) -> io::Result<Self> {
        install_panic_hook();
        enable_raw_mode()?;

        let mut stdout = io::stdout();
        // Bracketed paste and focus events are declared here rather than when a
        // widget first needs them: a terminal that is not told about bracketed
        // paste cannot be un-told, and by the time a paste arrives it is already
        // indistinguishable from typing.
        execute!(
            stdout,
            EnterAlternateScreen,
            EnableBracketedPaste,
            EnableFocusChange
        )?;
        set_background(&mut stdout, background)?;

        // Kitty's keyboard protocol is what makes modified keys (ctrl+enter,
        // shift+tab) distinguishable from their unmodified forms. Push it
        // without asking first: `supports_keyboard_enhancement` writes a query
        // and reads the reply off stdin, which blocks for its full timeout on
        // unix and would stall startup by seconds. A terminal that does not
        // speak the protocol ignores the push, so the request is harmless.
        if std::env::var_os(NO_KEYBOARD_ENHANCEMENT).is_none() {
            let _ = execute!(
                stdout,
                PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
            );
        }

        let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        terminal.clear()?;
        Ok(Self {
            terminal,
            background,
        })
    }

    /// Draw one frame inside a synchronized update.
    ///
    /// The terminal holds the previous screen until the update ends, so a slow
    /// repaint shows one whole frame instead of a half-written one.
    pub fn draw(&mut self, background: Color, render: impl FnOnce(&mut Frame)) -> io::Result<()> {
        execute!(self.terminal.backend_mut(), BeginSynchronizedUpdate)?;
        let drawn = (|| {
            if background != self.background {
                set_background(self.terminal.backend_mut(), background)?;
                self.background = background;
            }
            self.terminal.draw(render).map(|_| ())
        })();
        let _ = execute!(self.terminal.backend_mut(), EndSynchronizedUpdate);
        drawn
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

/// Give the terminal back. Safe to call more than once, and safe to call before
/// init has finished — every step is best-effort, because the alternative to a
/// failed restore is a unusable shell.
pub fn restore() {
    let mut stdout = io::stdout();
    // End any synchronized update first: a panic can land between begin and end,
    // and a terminal left in that mode stops repainting. Popping a keyboard
    // enhancement level that was never pushed is a no-op.
    let _ = execute!(
        stdout,
        EndSynchronizedUpdate,
        PopKeyboardEnhancementFlags,
        DisableBracketedPaste,
        DisableFocusChange,
        LeaveAlternateScreen
    );
    let _ = execute!(stdout, Show);
    // Hand back the background we claimed, then reset the pen.
    let _ = stdout.write_all(b"\x1b]111\x07\x1b[0m");
    let _ = stdout.flush();
    let _ = disable_raw_mode();
}

/// Restore the terminal *before* any other panic hook prints, so the message
/// lands on a normal screen rather than inside a raw-mode alternate buffer.
fn install_panic_hook() {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            restore();
            previous(info);
        }));
    });
}

/// Point the terminal's own background at the app's colour (OSC 11), so no
/// lighter gutter shows through while the screen is painted.
fn set_background(stdout: &mut impl Write, color: Color) -> io::Result<()> {
    let Color::Rgb(red, green, blue) = color else {
        return Ok(());
    };
    write!(stdout, "\x1b]11;#{red:02X}{green:02X}{blue:02X}\x07")?;
    write!(stdout, "\x1b[48;2;{red};{green};{blue}m")?;
    stdout.flush()
}
