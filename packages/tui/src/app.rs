//! Application state, and the only place that mutates it.
//!
//! `update` is the single entry point for change: it takes an event and reports
//! whether the screen needs redrawing. That report is the whole redraw policy —
//! there is no tick, so an idle TUI does no work and no repaint.

use std::cell::Cell;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::Color;
use tokio::sync::mpsc;

use crate::action::{Action, Keymap, Resolution};
use crate::event::{AppEvent, RpcEvent};
use crate::menu::{Entry, Menu, Preview};
use crate::prompt::Prompt;
use crate::rpc::{RpcClient, StreamEvent};
use crate::theme::{self, Palette};
use crate::tool::ToolCall;
use crate::types::{HistoryEntry, Part, SessionInfo, ToolResultContent, UsageReport};

/// What a leading slash offers. Only commands the app can actually perform are listed, and an
/// entry's name is what choosing it matches on.
const COMMANDS: &[Entry] = &[
    Entry::item("model", "pick a model"),
    Entry::item("thinking", "set thinking effort"),
    Entry::item("session", "switch or resume a session"),
    Entry::item("new", "start a new session"),
    Entry::item("reload", "reload server plugins"),
    Entry::item("theme", "pick a palette"),
    Entry::item("exit", "close the app"),
];

/// Thinking effort options, matching `packages/codework/src/acp/config.ts`.
const THINKING_LEVELS: &[Entry] = &[
    Entry::item("off", "Off"),
    Entry::item("minimal", "Minimal"),
    Entry::item("low", "Low"),
    Entry::item("medium", "Medium"),
    Entry::item("high", "High"),
    Entry::item("xhigh", "Extra High"),
    Entry::item("max", "Max"),
];

/// Common `provider/model` presets across supported providers; typing any custom `provider/model`
/// in the search box also offers that exact identifier.
const MODELS: &[Entry] = &[
    Entry::item("google/gemini-4-argon", "Google · Gemini 4 Argon"),
    Entry::item("google/gemini-3.8-flash", "Google · Gemini 3.8 Flash"),
    Entry::item("google/gemini-3.7-flash", "Google · Gemini 3.7 Flash"),
    Entry::item("google/gemini-3.6-flash", "Google · Gemini 3.6 Flash"),
    Entry::item("google/gemini-3.5-flash", "Google · Gemini 3.5 Flash"),
    Entry::item(
        "google/gemini-3.5-flash-lite",
        "Google · Gemini 3.5 Flash Lite",
    ),
    Entry::item(
        "google/gemini-3.1-pro-preview",
        "Google · Gemini 3.1 Pro Preview",
    ),
    Entry::item(
        "google/gemini-3.1-flash-lite",
        "Google · Gemini 3.1 Flash Lite",
    ),
    Entry::item(
        "google/gemini-3-flash-preview",
        "Google · Gemini 3 Flash Preview",
    ),
    Entry::item("google/gemini-flash-latest", "Google · Gemini Flash Latest"),
    Entry::item(
        "google/gemini-flash-lite-latest",
        "Google · Gemini Flash-Lite Latest",
    ),
    Entry::item("google/gemini-2.5-pro", "Google · Gemini 2.5 Pro"),
    Entry::item("google/gemini-2.5-flash", "Google · Gemini 2.5 Flash"),
    Entry::item(
        "google/gemini-2.5-flash-lite",
        "Google · Gemini 2.5 Flash-Lite",
    ),
    Entry::item("google/gemma-4-31b-it", "Google · Gemma 4 31B IT"),
    Entry::item("google/gemma-4-26b-a4b-it", "Google · Gemma 4 26B A4B IT"),
    Entry::item(
        "anthropic/claude-sonnet-4-5",
        "Anthropic · Claude Sonnet 4.5",
    ),
    Entry::item("anthropic/claude-opus-4-5", "Anthropic · Claude Opus 4.5"),
    Entry::item("anthropic/claude-haiku-4-5", "Anthropic · Claude Haiku 4.5"),
    Entry::item("openai/gpt-5", "OpenAI · GPT-5"),
    Entry::item("openai/gpt-4.1", "OpenAI · GPT-4.1"),
    Entry::item("openai/o3", "OpenAI · o3"),
    Entry::item(
        "openai-codex/codex-mini-latest",
        "OpenAI Codex · Codex Mini",
    ),
    Entry::item(
        "github-copilot/claude-sonnet-4",
        "GitHub Copilot · Claude Sonnet 4",
    ),
    Entry::item("xai/grok-4", "xAI · Grok 4"),
    Entry::item("deepseek/deepseek-reasoner", "DeepSeek · Reasoner"),
    Entry::item("openrouter/auto", "OpenRouter · Auto"),
];

/// The screens the TUI can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Welcome,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnState {
    Running,
    Succeeded,
    Failed(String),
    Interrupted(String),
}

#[derive(Debug, Clone)]
pub struct Turn {
    pub prompt: String,
    pub thinking: String,
    pub text: String,
    pub tools: Vec<ToolCall>,
    pub notices: Vec<String>,
    pub state: TurnState,
}

/// A menu open over the active screen, taking navigation keys while it is there.
pub enum Popup {
    /// What a leading slash asks for.
    Commands(Menu),
    /// Selectable `provider/model` identifiers.
    Models { search: Prompt, menu: Menu },
    /// Selectable thinking effort levels.
    Thinking(Menu),
    /// Sessions on the server (`session.list`).
    Sessions {
        search: Prompt,
        menu: Menu,
        sessions: Vec<SessionInfo>,
    },
    /// The palettes the site ships, filtered by `search`, and the one that was on screen before
    /// the picker opened so Escape can put it back.
    Themes {
        search: Prompt,
        menu: Menu,
        initial: &'static Palette,
    },
}

impl Popup {
    pub fn menu(&self) -> &Menu {
        match self {
            Popup::Commands(menu)
            | Popup::Thinking(menu)
            | Popup::Models { menu, .. }
            | Popup::Sessions { menu, .. }
            | Popup::Themes { menu, .. } => menu,
        }
    }

    fn menu_mut(&mut self) -> &mut Menu {
        match self {
            Popup::Commands(menu)
            | Popup::Thinking(menu)
            | Popup::Models { menu, .. }
            | Popup::Sessions { menu, .. }
            | Popup::Themes { menu, .. } => menu,
        }
    }

    /// The menu's own search prompt, when it has one.
    pub fn search(&self) -> Option<&Prompt> {
        match self {
            Popup::Commands(_) | Popup::Thinking(_) => None,
            Popup::Models { search, .. }
            | Popup::Sessions { search, .. }
            | Popup::Themes { search, .. } => Some(search),
        }
    }

    /// What the menu calls itself, on its border.
    pub fn title(&self) -> &'static str {
        match self {
            Popup::Commands(_) => "commands",
            Popup::Models { .. } => "models",
            Popup::Thinking(_) => "thinking",
            Popup::Sessions { .. } => "sessions",
            Popup::Themes { .. } => "themes",
        }
    }
}

pub struct App {
    pub screen: Screen,
    /// The palette every screen draws with. Held here rather than read from a global, so a frame
    /// is a pure function of the app and can be reproduced from a test backend.
    pub theme: &'static Palette,
    /// The prompt line: its text and where the caret is in it.
    pub prompt: Prompt,
    /// The menu on screen, if there is one.
    pub popup: Option<Popup>,
    /// A line of plain truth about the prompt or RPC status, shown in place of the key hints.
    pub notice: Option<String>,
    /// Active server session, once created or attached.
    pub session: Option<SessionInfo>,
    /// Selected `(provider, model)` override; when `None`, the server uses its configured default.
    pub model: Option<(String, String)>,
    /// Selected thinking effort level.
    pub thinking: Option<String>,
    /// Cumulative token and cost usage for the active session.
    pub usage: UsageReport,
    /// Conversation turns in the active session.
    pub turns: Vec<Turn>,
    /// Whether a prompt turn is currently streaming from the server.
    pub busy: bool,
    /// Whether the stream socket dropped and is reconnecting.
    pub reconnecting: bool,
    /// Scroll offset in lines from the bottom of the session transcript.
    pub scroll: usize,
    /// Maximum scroll offset computed by the last transcript render pass.
    pub max_scroll: Cell<usize>,
    pub should_quit: bool,
    keymap: Keymap,
    tx: mpsc::UnboundedSender<AppEvent>,
}

impl Default for App {
    fn default() -> Self {
        let (tx, _) = mpsc::unbounded_channel();
        Self::new(tx)
    }
}

impl App {
    pub fn new(tx: mpsc::UnboundedSender<AppEvent>) -> Self {
        Self {
            screen: Screen::Welcome,
            theme: theme::default_palette(),
            prompt: Prompt::default(),
            popup: None,
            notice: None,
            session: None,
            model: None,
            thinking: None,
            usage: UsageReport::default(),
            turns: Vec::new(),
            busy: false,
            reconnecting: false,
            scroll: 0,
            max_scroll: Cell::new(0),
            should_quit: false,
            keymap: Keymap::new(),
            tx,
        }
    }

    /// The terminal background colour for the active screen.
    pub fn background(&self) -> Color {
        match self.screen {
            Screen::Welcome => self.theme.field_bg,
            Screen::Session => self.theme.bg,
        }
    }

    fn apply_session(&mut self, info: SessionInfo) {
        self.model = info
            .model
            .as_ref()
            .map(|m| (m.provider.clone(), m.id.clone()));
        self.session = Some(info);
    }

    /// Display label for the active model.
    pub fn model_label(&self) -> String {
        if let Some((provider, id)) = &self.model {
            return format!("{provider}/{id}");
        }
        if let Some(model) = &self.usage.model {
            return model.clone();
        }
        "default model".to_string()
    }

    /// Apply one event. Returns whether the screen needs to be drawn again.
    pub fn update(&mut self, event: AppEvent) -> bool {
        match event {
            AppEvent::Key(key) => self.handle_key(key),
            AppEvent::Scroll(delta) => self.handle_scroll(delta),
            AppEvent::Paste(text) => self.handle_paste(&text),
            AppEvent::Resize => true,
            AppEvent::Rpc(rpc) => self.handle_rpc(rpc),
        }
    }

    fn handle_scroll(&mut self, delta: isize) -> bool {
        if self.popup.is_some() {
            let step = if delta > 0 { -1 } else { 1 };
            return self.step_menu(step);
        }
        if self.screen == Screen::Session {
            return self.scroll_by(delta);
        }
        false
    }

    fn scroll_by(&mut self, delta: isize) -> bool {
        let cap = self.max_scroll.get();
        let current = self.scroll.min(cap);
        let next = if delta >= 0 {
            current.saturating_add(delta as usize).min(cap)
        } else {
            current.saturating_sub((-delta) as usize)
        };
        if next == self.scroll {
            return false;
        }
        self.scroll = next;
        true
    }

    fn handle_paste(&mut self, text: &str) -> bool {
        if let Some(popup) = &mut self.popup {
            match popup {
                Popup::Themes {
                    search,
                    menu,
                    initial,
                } => {
                    if !search.insert_text(text) {
                        return false;
                    }
                    self.theme = filter_themes(search.text(), menu, *initial);
                    return true;
                }
                Popup::Models { search, menu } => {
                    if !search.insert_text(text) {
                        return false;
                    }
                    *menu = filter_models(search.text(), menu.selected().map(|e| e.id.as_ref()));
                    return true;
                }
                Popup::Sessions {
                    search,
                    menu,
                    sessions,
                } => {
                    if !search.insert_text(text) {
                        return false;
                    }
                    *menu = filter_sessions(
                        search.text(),
                        sessions,
                        menu.selected().map(|e| e.id.as_ref()),
                    );
                    return true;
                }
                Popup::Thinking(_) => return false,
                Popup::Commands(_) => {}
            }
        }
        let changed = self.prompt.insert_text(text);
        if changed {
            self.notice = None;
            self.sync_commands();
        }
        changed
    }

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        // Named actions first, so a key bound to the app is never typed into the prompt.
        match self.keymap.resolve(key) {
            Resolution::Action(Action::Exit) => {
                self.should_quit = true;
                return false;
            }
            Resolution::Consumed => return false,
            Resolution::Unbound => {}
        }

        if key.code == KeyCode::Esc {
            return self.escape();
        }

        if self.popup.is_some() {
            if self.menu_key(key) {
                return true;
            }
            match &mut self.popup {
                Some(Popup::Themes {
                    search,
                    menu,
                    initial,
                }) => {
                    if !search.edit(key) {
                        return false;
                    }
                    self.theme = filter_themes(search.text(), menu, *initial);
                    return true;
                }
                Some(Popup::Models { search, menu }) => {
                    if !search.edit(key) {
                        return false;
                    }
                    *menu = filter_models(search.text(), menu.selected().map(|e| e.id.as_ref()));
                    return true;
                }
                Some(Popup::Sessions {
                    search,
                    menu,
                    sessions,
                }) => {
                    if !search.edit(key) {
                        return false;
                    }
                    *menu = filter_sessions(
                        search.text(),
                        sessions,
                        menu.selected().map(|e| e.id.as_ref()),
                    );
                    return true;
                }
                Some(Popup::Thinking(_)) => return false,
                Some(Popup::Commands(_)) | None => {}
            }
        }

        if self.screen == Screen::Session {
            match key.code {
                KeyCode::PageUp => return self.scroll_by(10),
                KeyCode::PageDown => return self.scroll_by(-10),
                KeyCode::Up
                    if key.modifiers.contains(KeyModifiers::SHIFT)
                        || self.prompt.text().is_empty() =>
                {
                    return self.scroll_by(1);
                }
                KeyCode::Down
                    if key.modifiers.contains(KeyModifiers::SHIFT)
                        || self.prompt.text().is_empty() =>
                {
                    return self.scroll_by(-1);
                }
                _ => {}
            }
        }

        if key.code == KeyCode::Enter {
            return self.submit_prompt();
        }

        let edited = self.prompt.edit(key);
        if edited {
            self.notice = None;
            self.sync_commands();
        }
        edited
    }

    fn handle_rpc(&mut self, event: RpcEvent) -> bool {
        match event {
            RpcEvent::SessionsLoaded(Ok(mut sessions)) => {
                sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                let current_id = self.session.as_ref().map(|s| s.id.as_str());
                let menu = filter_sessions("", &sessions, current_id);
                self.popup = Some(Popup::Sessions {
                    search: Prompt::default(),
                    menu,
                    sessions,
                });
                true
            }
            RpcEvent::SessionsLoaded(Err(err)) => {
                self.notice = Some(err);
                true
            }
            RpcEvent::SessionHistoryLoaded(Ok(entries)) => {
                self.turns = turns_from_history(&entries);
                self.busy = self
                    .turns
                    .last()
                    .is_some_and(|turn| turn.state == TurnState::Running);
                self.scroll = 0;
                true
            }
            RpcEvent::SessionHistoryLoaded(Err(err)) => {
                self.notice = Some(err);
                true
            }
            RpcEvent::SessionConfigured(Ok(info)) => {
                self.apply_session(info);
                true
            }
            RpcEvent::SessionConfigured(Err(err)) => {
                self.notice = Some(err);
                true
            }
            RpcEvent::PluginsReloaded(Ok((count, failure))) => {
                self.notice = Some(match failure {
                    Some(err) => format!("plugin reload failed: {err}"),
                    None => format!("reloaded {count} plugin(s)"),
                });
                true
            }
            RpcEvent::PluginsReloaded(Err(err)) => {
                self.notice = Some(err);
                true
            }
            RpcEvent::Stream(stream) => self.handle_stream(stream),
        }
    }

    fn handle_stream(&mut self, event: StreamEvent) -> bool {
        match event {
            StreamEvent::SessionCreated(info) => {
                self.apply_session(info);
            }
            StreamEvent::TextDelta(delta) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.text.push_str(&delta);
                }
            }
            StreamEvent::ThinkingDelta(delta) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.thinking.push_str(&delta);
                }
            }
            StreamEvent::ToolStarted {
                call_id,
                name,
                label,
                arguments,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    let started = ToolCall::start(call_id.clone(), name, label, &arguments);
                    if let Some(existing) = turn.tools.iter_mut().find(|t| t.call_id == call_id) {
                        existing.name = started.name;
                        existing.target = started.target;
                        existing.label = started.label;
                    } else {
                        turn.tools.push(started);
                    }
                }
            }
            StreamEvent::ToolSettled {
                call_id,
                name,
                is_error,
                arguments,
                output,
                details,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    if let Some(existing) = turn.tools.iter_mut().find(|t| t.call_id == call_id) {
                        existing.apply_settlement(
                            name,
                            &arguments,
                            output,
                            details.as_ref(),
                            is_error,
                        );
                    } else {
                        turn.tools.push(ToolCall::settled(
                            call_id,
                            name,
                            &arguments,
                            output,
                            details.as_ref(),
                            is_error,
                        ));
                    }
                }
            }
            StreamEvent::Notice(notice) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.notices.push(notice);
                }
            }
            StreamEvent::Usage(usage) => {
                self.usage.total_tokens += usage.total_tokens;
                self.usage.input_tokens += usage.input_tokens;
                self.usage.output_tokens += usage.output_tokens;
                self.usage.cost += usage.cost;
                if usage.model.is_some() {
                    self.usage.model = usage.model;
                }
            }
            StreamEvent::Disconnected => {
                self.reconnecting = true;
            }
            StreamEvent::Reconnected => {
                self.reconnecting = false;
            }
            StreamEvent::Succeeded => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.state = TurnState::Succeeded;
                }
                self.busy = false;
                self.reconnecting = false;
            }
            StreamEvent::Failed(err) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.state = TurnState::Failed(err);
                }
                self.busy = false;
                self.reconnecting = false;
            }
            StreamEvent::Interrupted(reason) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.state = TurnState::Interrupted(reason);
                }
                self.busy = false;
                self.reconnecting = false;
            }
        }
        true
    }

    fn submit_prompt(&mut self) -> bool {
        let text = self.prompt.text().trim().to_string();
        if text.is_empty() {
            return false;
        }
        if self.busy {
            self.notice = Some("a turn is already running · press esc to interrupt".to_string());
            return true;
        }

        self.prompt.clear();
        self.notice = None;
        self.screen = Screen::Session;
        self.scroll = 0;
        self.busy = true;
        self.reconnecting = false;
        self.turns.push(Turn {
            prompt: text.clone(),
            thinking: String::new(),
            text: String::new(),
            tools: Vec::new(),
            notices: Vec::new(),
            state: TurnState::Running,
        });

        let tx = self.tx.clone();
        let existing_session_id = self.session.as_ref().map(|s| s.id.clone());
        let model = self.model.clone();
        let thinking = self.thinking.clone();

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let client = RpcClient::default();
                let session_id = match existing_session_id {
                    Some(id) => id,
                    None => match client.create_session(None, model, thinking).await {
                        Ok(info) => {
                            let id = info.id.clone();
                            let _ = tx.send(AppEvent::Rpc(RpcEvent::Stream(
                                StreamEvent::SessionCreated(info),
                            )));
                            id
                        }
                        Err(err) => {
                            let _ = tx
                                .send(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::Failed(err))));
                            return;
                        }
                    },
                };

                let (stream_tx, mut stream_rx) = mpsc::unbounded_channel();
                let forward_tx = tx.clone();
                let forward = tokio::spawn(async move {
                    while let Some(evt) = stream_rx.recv().await {
                        if forward_tx
                            .send(AppEvent::Rpc(RpcEvent::Stream(evt)))
                            .is_err()
                        {
                            break;
                        }
                    }
                });

                let _ = client.prompt_session(session_id, text, stream_tx).await;
                let _ = forward.await;
            });
        }

        true
    }

    /// Open, filter, or close the command menu to match a leading slash on the prompt line.
    fn sync_commands(&mut self) {
        let Some(query) = self.prompt.text().strip_prefix('/') else {
            if matches!(self.popup, Some(Popup::Commands(_))) {
                self.popup = None;
            }
            return;
        };
        let query = query.to_ascii_lowercase();
        let mut menu = match self.popup.take() {
            Some(Popup::Commands(menu)) => menu,
            _ => Menu::new(COMMANDS.to_vec()),
        };
        menu.filter(|entry| entry.name.starts_with(&query));
        if !menu.entries().is_empty() {
            self.popup = Some(Popup::Commands(menu));
        }
    }

    /// A key for the menu on screen: the arrows walk it and Enter takes what it is on.
    fn menu_key(&mut self, key: KeyEvent) -> bool {
        let step = match key.code {
            KeyCode::Up => -1,
            KeyCode::Down => 1,
            KeyCode::Enter => return self.choose(),
            _ => return false,
        };
        self.step_menu(step)
    }

    fn step_menu(&mut self, step: isize) -> bool {
        let Some(popup) = &mut self.popup else {
            return false;
        };
        if !popup.menu_mut().step(step) {
            return false;
        }
        // Walking the theme picker previews each palette on the whole screen as the cursor lands
        // on it; Enter keeps it and Escape puts the initial one back.
        if let Popup::Themes { menu, .. } = popup {
            if let Some(palette) = menu.selected().and_then(|entry| theme_named(&entry.name)) {
                self.theme = palette;
            }
        }
        true
    }

    /// Take the entry the cursor is on.
    fn choose(&mut self) -> bool {
        let Some(chosen) = self
            .popup
            .as_ref()
            .and_then(|popup| popup.menu().selected())
            .cloned()
        else {
            return false;
        };
        let Some(popup) = self.popup.take() else {
            return false;
        };
        match popup {
            Popup::Commands(_) => {
                self.prompt.clear();
                match chosen.id.as_ref() {
                    "model" => {
                        let current = self.model_label();
                        self.popup = Some(Popup::Models {
                            search: Prompt::default(),
                            menu: filter_models("", Some(&current)),
                        });
                    }
                    "thinking" => {
                        let current = self.thinking.as_deref().unwrap_or("off");
                        self.popup = Some(Popup::Thinking(Menu::at(
                            THINKING_LEVELS.to_vec(),
                            current,
                        )));
                    }
                    "session" => {
                        self.notice = Some("loading sessions...".to_string());
                        self.spawn_list_sessions();
                    }
                    "new" => {
                        self.session = None;
                        self.turns.clear();
                        self.usage = UsageReport::default();
                        self.busy = false;
                        self.reconnecting = false;
                        self.scroll = 0;
                        self.notice = Some("started a new session".to_string());
                    }
                    "reload" => {
                        self.notice = Some("reloading plugins...".to_string());
                        self.spawn_reload_plugins();
                    }
                    "theme" => {
                        self.popup = Some(Popup::Themes {
                            search: Prompt::default(),
                            menu: themes(self.theme.name),
                            initial: self.theme,
                        });
                    }
                    "exit" => self.should_quit = true,
                    _ => {}
                }
            }
            Popup::Models { .. } => {
                if let Some((provider, id)) = parse_model(&chosen.id) {
                    self.model = Some((provider.clone(), id.clone()));
                    self.notice = Some(format!("model set to {provider}/{id}"));
                    self.spawn_configure_session();
                }
            }
            Popup::Thinking(_) => {
                let level = chosen.id.to_string();
                self.thinking = Some(level.clone());
                self.notice = Some(format!("thinking effort set to {level}"));
                self.spawn_configure_session();
            }
            Popup::Sessions { sessions, .. } => {
                if let Some(info) = sessions.into_iter().find(|s| s.id == chosen.id.as_ref()) {
                    let session_id = info.id.clone();
                    let title = info.title.clone();
                    self.apply_session(info);
                    self.turns.clear();
                    self.usage = UsageReport::default();
                    self.busy = false;
                    self.reconnecting = false;
                    self.scroll = 0;
                    self.screen = Screen::Session;
                    self.notice = Some(format!("switched to session {title}"));
                    self.spawn_session_history(&session_id);
                }
            }
            Popup::Themes { .. } => {
                if let Some(palette) = theme_named(&chosen.name) {
                    self.theme = palette;
                }
            }
        }
        true
    }

    /// Close what is open, interrupt a running turn, or leave when idle.
    fn escape(&mut self) -> bool {
        if let Some(popup) = self.popup.take() {
            match popup {
                Popup::Commands(_) => self.prompt.clear(),
                Popup::Themes { initial, .. } => self.theme = initial,
                Popup::Models { .. } | Popup::Thinking(_) | Popup::Sessions { .. } => {}
            }
            return true;
        }
        if self.busy {
            self.spawn_interrupt();
            self.notice = Some("interrupting turn...".to_string());
            return true;
        }
        if !self.prompt.text().is_empty() {
            self.prompt.clear();
            return true;
        }
        self.should_quit = true;
        false
    }

    fn spawn_list_sessions(&self) {
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let res = RpcClient::default().list_sessions().await;
                let _ = tx.send(AppEvent::Rpc(RpcEvent::SessionsLoaded(res)));
            });
        }
    }

    fn spawn_session_history(&self, session_id: &str) {
        let session_id = session_id.to_string();
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let res = RpcClient::default().session_history(&session_id).await;
                let _ = tx.send(AppEvent::Rpc(RpcEvent::SessionHistoryLoaded(res)));
            });
        }
    }

    fn spawn_configure_session(&self) {
        let Some(session) = &self.session else {
            return;
        };
        let session_id = session.id.clone();
        let model = self.model.clone();
        let thinking = self.thinking.clone();
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let res = RpcClient::default()
                    .configure_session(&session_id, model, thinking)
                    .await;
                let _ = tx.send(AppEvent::Rpc(RpcEvent::SessionConfigured(res)));
            });
        }
    }

    fn spawn_reload_plugins(&self) {
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let res = RpcClient::default().reload_plugins().await;
                let _ = tx.send(AppEvent::Rpc(RpcEvent::PluginsReloaded(res)));
            });
        }
    }

    fn spawn_interrupt(&self) {
        let Some(session) = &self.session else {
            return;
        };
        let session_id = session.id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = RpcClient::default().interrupt_session(&session_id).await;
            });
        }
    }
}

fn theme_named(name: &str) -> Option<&'static Palette> {
    theme::PALETTES.iter().find(|palette| palette.name == name)
}

/// Splits a `provider/model` identifier on its first slash (matching `acp/config.ts:parseModel`).
fn parse_model(value: &str) -> Option<(String, String)> {
    let slash = value.find('/')?;
    if slash == 0 || slash + 1 >= value.len() {
        return None;
    }
    Some((
        value[..slash].to_string(),
        value[slash + 1..].to_string(),
    ))
}

/// Filter the theme picker's entries by `query` (matching palette name or scheme) and return the
/// palette to preview on screen — the selected match when there is one, else `initial`.
fn filter_themes(query: &str, menu: &mut Menu, initial: &'static Palette) -> &'static Palette {
    let query = query.trim().to_ascii_lowercase();
    menu.filter(|entry| {
        query.is_empty()
            || entry.name.to_ascii_lowercase().contains(&query)
            || entry.detail.to_ascii_lowercase().contains(&query)
    });
    menu.selected()
        .and_then(|entry| theme_named(&entry.name))
        .unwrap_or(initial)
}

/// Build the model picker's menu, including any custom `provider/model` typed in the search box.
fn filter_models(query: &str, active: Option<&str>) -> Menu {
    let trimmed = query.trim();
    let needle = trimmed.to_ascii_lowercase();
    let mut entries = MODELS.to_vec();
    if parse_model(trimmed).is_some() && !entries.iter().any(|e| e.id.eq_ignore_ascii_case(trimmed))
    {
        entries.insert(0, Entry::owned(trimmed, trimmed, "custom"));
    }
    let mut menu = Menu::at(entries, active.unwrap_or(""));
    menu.filter(|entry| {
        needle.is_empty()
            || entry.name.to_ascii_lowercase().contains(&needle)
            || entry.detail.to_ascii_lowercase().contains(&needle)
    });
    menu
}

/// Reconstruct conversation turns from the server's `session.history` entries.
pub fn turns_from_history(entries: &[HistoryEntry]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();

    for entry in entries {
        if entry.role == "user" {
            let prompt = entry
                .parts
                .iter()
                .filter_map(|part| match part {
                    Part::Text { text } if !text.is_empty() => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            turns.push(Turn {
                prompt,
                thinking: String::new(),
                text: String::new(),
                tools: Vec::new(),
                notices: Vec::new(),
                state: entry_turn_state(&entry.state),
            });
            continue;
        }

        if turns.is_empty() {
            turns.push(Turn {
                prompt: String::new(),
                thinking: String::new(),
                text: String::new(),
                tools: Vec::new(),
                notices: Vec::new(),
                state: TurnState::Succeeded,
            });
        }

        let Some(turn) = turns.last_mut() else {
            continue;
        };
        turn.state = entry_turn_state(&entry.state);

        for part in &entry.parts {
            match part {
                Part::Text { text } if !text.is_empty() => {
                    if !turn.text.is_empty()
                        && !turn.text.ends_with('\n')
                        && !text.starts_with('\n')
                    {
                        turn.text.push_str("\n\n");
                    }
                    turn.text.push_str(text);
                }
                Part::Thinking { thinking, redacted }
                    if redacted != &Some(true) && !thinking.is_empty() =>
                {
                    if !turn.thinking.is_empty()
                        && !turn.thinking.ends_with('\n')
                        && !thinking.starts_with('\n')
                    {
                        turn.thinking.push('\n');
                    }
                    turn.thinking.push_str(thinking);
                }
                Part::ToolCall {
                    call_id,
                    name,
                    arguments,
                    status,
                    result,
                    ..
                } => {
                    let tool_call =
                        if matches!(status.as_str(), "pending" | "running") && result.is_none() {
                            ToolCall::start(call_id.clone(), name.clone(), None, arguments)
                        } else {
                            let is_error = status != "completed"
                                || result.as_ref().is_some_and(|r| r.is_error);
                            let output = result.as_ref().and_then(|r| {
                                let text = r
                                    .content
                                    .iter()
                                    .filter_map(|block| match block {
                                        ToolResultContent::Text { text } => Some(text.as_str()),
                                        ToolResultContent::Image { .. } => None,
                                    })
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                (!text.is_empty()).then_some(text)
                            });
                            let details = result.as_ref().and_then(|r| r.details.as_ref());
                            ToolCall::settled(
                                call_id.clone(),
                                Some(name.clone()),
                                arguments,
                                output,
                                details,
                                is_error,
                            )
                        };

                    if let Some(existing) = turn.tools.iter_mut().find(|t| t.call_id == *call_id) {
                        *existing = tool_call;
                    } else {
                        turn.tools.push(tool_call);
                    }
                }
                Part::Text { .. } | Part::Thinking { .. } | Part::Image { .. } => {}
            }
        }
    }

    turns
}

fn entry_turn_state(state: &str) -> TurnState {
    match state {
        "draft" => TurnState::Running,
        "aborted" => TurnState::Interrupted("aborted".to_string()),
        _ => TurnState::Succeeded,
    }
}

/// Build the session picker's menu from the server's `session.list` response, sorted by
/// `updated_at` (newest first).
fn filter_sessions(query: &str, sessions: &[SessionInfo], active: Option<&str>) -> Menu {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    filter_sessions_at(query, sessions, active, now_ms)
}

fn filter_sessions_at(
    query: &str,
    sessions: &[SessionInfo],
    active: Option<&str>,
    now_ms: u64,
) -> Menu {
    let needle = query.trim().to_ascii_lowercase();
    let mut ordered: Vec<&SessionInfo> = sessions.iter().collect();
    ordered.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let entries: Vec<Entry> = ordered
        .into_iter()
        .map(|s| {
            let title = if s.title.is_empty() {
                s.id.clone()
            } else {
                s.title.clone()
            };
            Entry::owned(s.id.clone(), title, session_detail(s, now_ms))
        })
        .collect();
    let mut menu = Menu::at(entries, active.unwrap_or(""));
    menu.filter(|entry| {
        needle.is_empty()
            || entry.name.to_ascii_lowercase().contains(&needle)
            || entry.detail.to_ascii_lowercase().contains(&needle)
            || entry.id.to_ascii_lowercase().contains(&needle)
    });
    menu
}

fn session_detail(session: &SessionInfo, now_ms: u64) -> String {
    let location = session
        .project
        .as_ref()
        .map(|p| p.name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| session.host_dir.as_deref().unwrap_or(&session.directory));
    match format_ago(session.updated_at, now_ms) {
        Some(age) if !location.is_empty() => format!("{location} · {age}"),
        Some(age) => age,
        None => location.to_string(),
    }
}

fn format_ago(updated_at: u64, now_ms: u64) -> Option<String> {
    if updated_at == 0 {
        return None;
    }
    let elapsed = now_ms.saturating_sub(updated_at);
    const MINUTE: u64 = 60_000;
    const HOUR: u64 = 60 * MINUTE;
    const DAY: u64 = 24 * HOUR;
    Some(if elapsed >= DAY {
        format!("{}d", elapsed / DAY)
    } else if elapsed >= HOUR {
        format!("{}h", elapsed / HOUR)
    } else if elapsed >= MINUTE {
        format!("{}m", elapsed / MINUTE)
    } else {
        "now".to_string()
    })
}

/// The theme picker: one entry per palette the site ships, its cursor on `active`.
fn themes(active: &str) -> Menu {
    Menu::at(
        theme::PALETTES
            .iter()
            .map(|palette| {
                Entry::with_preview(
                    palette.name,
                    palette.scheme.name(),
                    Preview {
                        bg: palette.field_bg,
                        fg: palette.text,
                    },
                )
            })
            .collect(),
        active,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::ToolStatus;
    use crate::types::{ModelRef, ProjectInfo, ToolResult, ToolTime};
    use serde_json::json;

    #[test]
    fn reconstructs_turns_from_history_entries() {
        let entries = vec![
            HistoryEntry {
                id: "u1".to_string(),
                seq: 1,
                role: "user".to_string(),
                state: "committed".to_string(),
                created_at: 1_000,
                parts: vec![Part::Text {
                    text: "Read Cargo.toml and run cargo check".to_string(),
                }],
            },
            HistoryEntry {
                id: "a1".to_string(),
                seq: 2,
                role: "assistant".to_string(),
                state: "committed".to_string(),
                created_at: 1_100,
                parts: vec![
                    Part::Thinking {
                        thinking: "Checking Cargo.toml first.".to_string(),
                        redacted: None,
                    },
                    Part::Thinking {
                        thinking: "secret".to_string(),
                        redacted: Some(true),
                    },
                    Part::ToolCall {
                        call_id: "call_1".to_string(),
                        name: "read".to_string(),
                        arguments: json!({ "path": "Cargo.toml" }),
                        status: "completed".to_string(),
                        result: Some(ToolResult {
                            content: vec![ToolResultContent::Text {
                                text: "[package]\nname = \"codework-tui\"".to_string(),
                            }],
                            is_error: false,
                            details: None,
                        }),
                        time: Some(ToolTime { start: 10, end: 20 }),
                    },
                ],
            },
            HistoryEntry {
                id: "a2".to_string(),
                seq: 3,
                role: "assistant".to_string(),
                state: "committed".to_string(),
                created_at: 1_200,
                parts: vec![
                    Part::ToolCall {
                        call_id: "call_2".to_string(),
                        name: "bash".to_string(),
                        arguments: json!({ "command": "cargo check" }),
                        status: "error".to_string(),
                        result: Some(ToolResult {
                            content: vec![ToolResultContent::Text {
                                text: "compile error".to_string(),
                            }],
                            is_error: true,
                            details: None,
                        }),
                        time: None,
                    },
                    Part::Text {
                        text: "The check failed.".to_string(),
                    },
                ],
            },
            HistoryEntry {
                id: "u2".to_string(),
                seq: 4,
                role: "user".to_string(),
                state: "committed".to_string(),
                created_at: 2_000,
                parts: vec![Part::Text {
                    text: "Fix it".to_string(),
                }],
            },
            HistoryEntry {
                id: "a3".to_string(),
                seq: 5,
                role: "assistant".to_string(),
                state: "draft".to_string(),
                created_at: 2_100,
                parts: vec![Part::ToolCall {
                    call_id: "call_3".to_string(),
                    name: "edit".to_string(),
                    arguments: json!({ "path": "src/app.rs" }),
                    status: "running".to_string(),
                    result: None,
                    time: None,
                }],
            },
            HistoryEntry {
                id: "u3".to_string(),
                seq: 6,
                role: "user".to_string(),
                state: "committed".to_string(),
                created_at: 3_000,
                parts: vec![Part::Text {
                    text: "Stop".to_string(),
                }],
            },
            HistoryEntry {
                id: "a4".to_string(),
                seq: 7,
                role: "assistant".to_string(),
                state: "aborted".to_string(),
                created_at: 3_100,
                parts: vec![Part::Text {
                    text: "Partial reply".to_string(),
                }],
            },
        ];

        let turns = turns_from_history(&entries);
        assert_eq!(turns.len(), 3);

        assert_eq!(turns[0].prompt, "Read Cargo.toml and run cargo check");
        assert_eq!(turns[0].thinking, "Checking Cargo.toml first.");
        assert_eq!(turns[0].text, "The check failed.");
        assert_eq!(turns[0].state, TurnState::Succeeded);
        assert_eq!(turns[0].tools.len(), 2);
        assert_eq!(turns[0].tools[0].call_id, "call_1");
        assert_eq!(turns[0].tools[0].target.as_deref(), Some("Cargo.toml"));
        assert_eq!(turns[0].tools[0].status, ToolStatus::Completed);
        assert_eq!(turns[0].tools[1].call_id, "call_2");
        assert_eq!(turns[0].tools[1].target.as_deref(), Some("cargo check"));
        assert_eq!(turns[0].tools[1].status, ToolStatus::Failed);
        assert_eq!(turns[0].tools[1].output.as_deref(), Some("compile error"));

        assert_eq!(turns[1].prompt, "Fix it");
        assert_eq!(turns[1].state, TurnState::Running);
        assert_eq!(turns[1].tools.len(), 1);
        assert_eq!(turns[1].tools[0].status, ToolStatus::Running);
        assert_eq!(turns[1].tools[0].target.as_deref(), Some("src/app.rs"));

        assert_eq!(turns[2].prompt, "Stop");
        assert_eq!(turns[2].text, "Partial reply");
        assert_eq!(
            turns[2].state,
            TurnState::Interrupted("aborted".to_string())
        );
    }

    #[test]
    fn sorts_sessions_by_updated_at_and_formats_project_activity() {
        let now_ms = 1_000_000_000u64;
        let sessions = vec![
            SessionInfo {
                id: "ses_older".to_string(),
                title: "Older session".to_string(),
                directory: "/workspace/alpha".to_string(),
                host_dir: Some("/Users/prem/alpha".to_string()),
                sandbox: None,
                project: None,
                updated_at: now_ms - 2 * 3_600_000,
                model: None,
            },
            SessionInfo {
                id: "ses_newest".to_string(),
                title: "Newest session".to_string(),
                directory: "/workspace/codework".to_string(),
                host_dir: Some("/Users/prem/codework".to_string()),
                sandbox: None,
                project: Some(ProjectInfo {
                    id: "prj_1".to_string(),
                    name: "codework".to_string(),
                }),
                updated_at: now_ms - 5 * 60_000,
                model: None,
            },
            SessionInfo {
                id: "ses_oldest".to_string(),
                title: "Oldest session".to_string(),
                directory: "/workspace/notes".to_string(),
                host_dir: None,
                sandbox: None,
                project: Some(ProjectInfo {
                    id: "prj_2".to_string(),
                    name: "notes".to_string(),
                }),
                updated_at: now_ms - 3 * 86_400_000,
                model: None,
            },
        ];

        let menu = filter_sessions_at("", &sessions, None, now_ms);
        let entries = menu.entries();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].id.as_ref(), "ses_newest");
        assert_eq!(entries[0].detail.as_ref(), "codework · 5m");
        assert_eq!(entries[1].id.as_ref(), "ses_older");
        assert_eq!(entries[1].detail.as_ref(), "/Users/prem/alpha · 2h");
        assert_eq!(entries[2].id.as_ref(), "ses_oldest");
        assert_eq!(entries[2].detail.as_ref(), "notes · 3d");
    }

    #[test]
    fn syncs_model_and_loads_history_on_session_switch() {
        let mut app = App::default();

        let first = SessionInfo {
            id: "ses_1".to_string(),
            title: "First".to_string(),
            directory: "/workspace/one".to_string(),
            host_dir: None,
            sandbox: None,
            project: None,
            updated_at: 1_000,
            model: Some(ModelRef {
                provider: "anthropic".to_string(),
                id: "claude-sonnet-4-5".to_string(),
            }),
        };
        let second = SessionInfo {
            id: "ses_2".to_string(),
            title: "Second".to_string(),
            directory: "/workspace/two".to_string(),
            host_dir: None,
            sandbox: None,
            project: None,
            updated_at: 2_000,
            model: None,
        };

        // Creating a session syncs `app.model` from `info.model`.
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::SessionCreated(first.clone()),
        )));
        assert_eq!(
            app.model,
            Some(("anthropic".to_string(), "claude-sonnet-4-5".to_string()))
        );

        // Opening `/session` sorts newest (`ses_2`) first, places the cursor on the active
        // session (`ses_1`), and choosing `ses_2` clears `app.model` back to `None`.
        app.update(AppEvent::Rpc(RpcEvent::SessionsLoaded(Ok(vec![
            first, second,
        ]))));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Up)));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Enter)));
        assert_eq!(app.session.as_ref().map(|s| s.id.as_str()), Some("ses_2"));
        assert_eq!(app.model, None);
        assert_eq!(app.screen, Screen::Session);

        // Delivering `SessionHistoryLoaded` populates `app.turns`.
        app.update(AppEvent::Rpc(RpcEvent::SessionHistoryLoaded(Ok(vec![
            HistoryEntry {
                id: "m1".to_string(),
                seq: 1,
                role: "user".to_string(),
                state: "committed".to_string(),
                created_at: 2_000,
                parts: vec![Part::Text {
                    text: "Resume me".to_string(),
                }],
            },
            HistoryEntry {
                id: "m2".to_string(),
                seq: 2,
                role: "assistant".to_string(),
                state: "committed".to_string(),
                created_at: 2_100,
                parts: vec![Part::Text {
                    text: "Resumed!".to_string(),
                }],
            },
        ]))));
        assert_eq!(app.turns.len(), 1);
        assert_eq!(app.turns[0].prompt, "Resume me");
        assert_eq!(app.turns[0].text, "Resumed!");
        assert_eq!(app.turns[0].state, TurnState::Succeeded);
        assert!(!app.busy);
    }
}
