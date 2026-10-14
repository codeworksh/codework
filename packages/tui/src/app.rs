//! Application state, and the only place that mutates it.
//!
//! `update` is the single entry point for change: it takes an event and reports
//! whether the screen needs redrawing. That report is the whole redraw policy —
//! there is no tick, so an idle TUI does no work and no repaint.

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::Color;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::action::{Action, Keymap, Resolution};
use crate::event::{AppEvent, RpcEvent};
use crate::menu::{Entry, Menu, Preview};
use crate::prompt::Prompt;
use crate::rpc::{RpcClient, StreamEvent};
use crate::theme::{self, Palette};
use crate::types::{SessionInfo, UsageReport};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub summary: String,
    pub output: Option<String>,
    pub status: ToolStatus,
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
            AppEvent::Paste(text) => self.handle_paste(&text),
            AppEvent::Resize => true,
            AppEvent::Rpc(rpc) => self.handle_rpc(rpc),
        }
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
                KeyCode::PageUp => {
                    self.scroll = self.scroll.saturating_add(5);
                    return true;
                }
                KeyCode::PageDown => {
                    self.scroll = self.scroll.saturating_sub(5);
                    return true;
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
            RpcEvent::SessionsLoaded(Ok(sessions)) => {
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
            RpcEvent::SessionConfigured(Ok(info)) => {
                self.session = Some(info);
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
                self.session = Some(info);
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
                    let summary = tool_summary(&name, &arguments, label.as_deref());
                    if let Some(existing) = turn.tools.iter_mut().find(|t| t.call_id == call_id) {
                        existing.name = name;
                        existing.summary = summary;
                    } else {
                        turn.tools.push(ToolCall {
                            call_id,
                            name,
                            summary,
                            output: None,
                            status: ToolStatus::Running,
                        });
                    }
                }
            }
            StreamEvent::ToolSettled {
                call_id,
                name,
                is_error,
                arguments,
                output,
                ..
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    let status = if is_error {
                        ToolStatus::Failed
                    } else {
                        ToolStatus::Completed
                    };
                    if let Some(existing) = turn.tools.iter_mut().find(|t| t.call_id == call_id) {
                        if let Some(name) = name {
                            existing.name = name;
                        }
                        if existing.summary.is_empty() {
                            existing.summary = tool_summary(&existing.name, &arguments, None);
                        }
                        existing.output = output;
                        existing.status = status;
                    } else {
                        let tool_name = name.unwrap_or_else(|| "tool".to_string());
                        let summary = tool_summary(&tool_name, &arguments, None);
                        turn.tools.push(ToolCall {
                            call_id,
                            name: tool_name,
                            summary,
                            output,
                            status,
                        });
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
                    let title = info.title.clone();
                    self.session = Some(info);
                    self.turns.clear();
                    self.usage = UsageReport::default();
                    self.scroll = 0;
                    self.screen = Screen::Session;
                    self.notice = Some(format!("switched to session {title}"));
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

/// Summarise a tool call's primary argument, matching `acp/feed.ts:title`.
fn tool_summary(name: &str, args: &Value, label: Option<&str>) -> String {
    if name == "bash" {
        if let Some(cmd) = args.get("command").and_then(Value::as_str) {
            return cmd.lines().next().unwrap_or(cmd).to_string();
        }
    }
    for key in ["path", "pattern", "query", "url", "command"] {
        if let Some(val) = args.get(key).and_then(Value::as_str) {
            return val.lines().next().unwrap_or(val).to_string();
        }
    }
    label.unwrap_or("").to_string()
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

/// Build the session picker's menu from the server's `session.list` response.
fn filter_sessions(query: &str, sessions: &[SessionInfo], active: Option<&str>) -> Menu {
    let needle = query.trim().to_ascii_lowercase();
    let entries: Vec<Entry> = sessions
        .iter()
        .rev()
        .map(|s| {
            let title = if s.title.is_empty() {
                s.id.clone()
            } else {
                s.title.clone()
            };
            let dir = s.host_dir.as_deref().unwrap_or(&s.directory).to_string();
            Entry::owned(s.id.clone(), title, dir)
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
