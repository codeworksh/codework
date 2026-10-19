//! Application state, and the only place that mutates it.
//!
//! `update` is the single entry point for change: it takes an event and reports
//! whether the screen needs redrawing. That report is the whole redraw policy —
//! there is no tick, so an idle TUI does no work and no repaint.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

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
use crate::types::{
    HistoryEntry, ModelList, Part, PromptDelivery, ServerInfo, SessionInfo, ToolResultContent,
    UsageReport,
};

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

/// Thinking effort levels in ascending order, matching `packages/codework/src/acp/config.ts`.
const THINKING_LEVELS: &[(&str, &str)] = &[
    ("off", "Off"),
    ("minimal", "Minimal"),
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra High"),
    ("max", "Max"),
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryStatus {
    pub attempt: u64,
    pub max_retries: u64,
    pub delay_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedPrompt {
    pub message_id: String,
    pub prompt: String,
    pub delivery: PromptDelivery,
    pub admitted: bool,
    pub dispatched: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssistantDraft {
    pub message_id: String,
    pub thinking_parts: BTreeMap<usize, String>,
    pub text_parts: BTreeMap<usize, String>,
}

#[derive(Debug, Clone)]
pub struct Turn {
    pub prompt_id: Option<String>,
    pub prompt: String,
    pub thinking: String,
    pub text: String,
    pub tools: Vec<ToolCall>,
    pub notices: Vec<String>,
    pub retry: Option<RetryStatus>,
    pub state: TurnState,
    pub drafts: Vec<AssistantDraft>,
}

impl Turn {
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt_id: None,
            prompt: prompt.into(),
            thinking: String::new(),
            text: String::new(),
            tools: Vec::new(),
            notices: Vec::new(),
            retry: None,
            state: TurnState::Running,
            drafts: Vec::new(),
        }
    }

    pub fn with_id(message_id: impl Into<String>, prompt: impl Into<String>) -> Self {
        let mut turn = Self::new(prompt);
        turn.prompt_id = Some(message_id.into());
        turn
    }

    fn draft_mut(&mut self, message_id: &str) -> &mut AssistantDraft {
        if let Some(pos) = self.drafts.iter().position(|d| d.message_id == message_id) {
            return &mut self.drafts[pos];
        }
        self.drafts.push(AssistantDraft {
            message_id: message_id.to_string(),
            thinking_parts: BTreeMap::new(),
            text_parts: BTreeMap::new(),
        });
        self.drafts.last_mut().expect("draft inserted")
    }

    pub fn start_llm(&mut self, message_id: &str) {
        self.retry = None;
        let _ = self.draft_mut(message_id);
        self.sync_thinking();
        self.sync_text();
    }

    pub fn fail_llm(&mut self, message_id: &str) {
        self.drafts.retain(|d| d.message_id != message_id);
        self.sync_thinking();
        self.sync_text();
    }

    pub fn start_text_part(&mut self, message_id: &str, part_index: usize) {
        self.retry = None;
        self.draft_mut(message_id)
            .text_parts
            .entry(part_index)
            .or_default();
    }

    pub fn append_text_delta(
        &mut self,
        message_id: Option<&str>,
        part_index: Option<usize>,
        delta: &str,
    ) {
        self.retry = None;
        let msg_id = message_id
            .map(str::to_string)
            .or_else(|| self.drafts.last().map(|d| d.message_id.clone()))
            .unwrap_or_default();
        let idx = part_index.unwrap_or(0);
        self.draft_mut(&msg_id)
            .text_parts
            .entry(idx)
            .or_default()
            .push_str(delta);
        self.sync_text();
    }

    pub fn end_text_part(&mut self, message_id: &str, part_index: usize, content: String) {
        self.retry = None;
        self.draft_mut(message_id)
            .text_parts
            .insert(part_index, content);
        self.sync_text();
    }

    pub fn start_thinking_part(&mut self, message_id: &str, part_index: usize) {
        self.retry = None;
        self.draft_mut(message_id)
            .thinking_parts
            .entry(part_index)
            .or_default();
    }

    pub fn append_thinking_delta(
        &mut self,
        message_id: Option<&str>,
        part_index: Option<usize>,
        delta: &str,
    ) {
        self.retry = None;
        let msg_id = message_id
            .map(str::to_string)
            .or_else(|| self.drafts.last().map(|d| d.message_id.clone()))
            .unwrap_or_default();
        let idx = part_index.unwrap_or(0);
        self.draft_mut(&msg_id)
            .thinking_parts
            .entry(idx)
            .or_default()
            .push_str(delta);
        self.sync_thinking();
    }

    pub fn end_thinking_part(&mut self, message_id: &str, part_index: usize, content: String) {
        self.retry = None;
        self.draft_mut(message_id)
            .thinking_parts
            .insert(part_index, content);
        self.sync_thinking();
    }

    pub fn sync_text(&mut self) {
        let mut combined = String::new();
        for draft in &self.drafts {
            for part in draft.text_parts.values() {
                if part.is_empty() {
                    continue;
                }
                if !combined.is_empty() && !combined.ends_with('\n') && !part.starts_with('\n') {
                    combined.push_str("\n\n");
                }
                combined.push_str(part);
            }
        }
        self.text = combined;
    }

    pub fn sync_thinking(&mut self) {
        let mut combined = String::new();
        for draft in &self.drafts {
            for part in draft.thinking_parts.values() {
                if part.is_empty() {
                    continue;
                }
                if !combined.is_empty() && !combined.ends_with('\n') && !part.starts_with('\n') {
                    combined.push('\n');
                }
                combined.push_str(part);
            }
        }
        self.thinking = combined;
    }
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
    /// Verified server identity (`pid` and `version`) from `server.info`.
    pub server_info: Option<ServerInfo>,
    /// Active server session, once created or attached.
    pub session: Option<SessionInfo>,
    /// Available models and the resolved settings default from `model.list`.
    pub models: Option<ModelList>,
    /// Selected `(provider, model)` override; when `None`, the server uses its configured default.
    pub model: Option<(String, String)>,
    /// Selected thinking effort level.
    pub thinking: Option<String>,
    /// Cumulative token and cost usage for the active session.
    pub usage: UsageReport,
    /// Conversation turns in the active session.
    pub turns: Vec<Turn>,
    /// Prompts submitted while a turn is running (`steer` or `followUp`), awaiting promotion.
    pub queued_prompts: Vec<QueuedPrompt>,
    /// Whether a prompt turn is currently streaming from the server.
    pub busy: bool,
    /// Whether the stream socket dropped and is reconnecting.
    pub reconnecting: bool,
    /// Durable `session.log` cursor (`max(last durable.seq, last log.synced.seq)`).
    pub log_cursor: Option<u64>,
    /// Scroll offset in lines from the bottom of the session transcript.
    pub scroll: usize,
    /// Maximum scroll offset computed by the last transcript render pass.
    pub max_scroll: Cell<usize>,
    pub should_quit: bool,
    next_prompt_seq: u64,
    prompt_stream: Option<tokio::task::AbortHandle>,
    initial_prompt_id: Option<String>,
    history_request: Cell<u64>,
    history_revision: u64,
    keymap: Keymap,
    tx: mpsc::UnboundedSender<AppEvent>,
}

impl Default for App {
    fn default() -> Self {
        let (tx, _) = mpsc::unbounded_channel();
        Self::new(tx)
    }
}

impl Drop for App {
    fn drop(&mut self) {
        self.stop_prompt_stream();
    }
}

impl App {
    pub fn new(tx: mpsc::UnboundedSender<AppEvent>) -> Self {
        let app = Self {
            screen: Screen::Welcome,
            theme: theme::default_palette(),
            prompt: Prompt::default(),
            popup: None,
            notice: None,
            server_info: None,
            session: None,
            models: None,
            model: None,
            thinking: None,
            usage: UsageReport::default(),
            turns: Vec::new(),
            queued_prompts: Vec::new(),
            busy: false,
            reconnecting: false,
            log_cursor: None,
            scroll: 0,
            max_scroll: Cell::new(0),
            should_quit: false,
            next_prompt_seq: 1,
            prompt_stream: None,
            initial_prompt_id: None,
            history_request: Cell::new(0),
            history_revision: 0,
            keymap: Keymap::new(),
            tx,
        };
        app.spawn_server_info();
        app.spawn_list_models();
        app
    }

    fn next_message_id(&mut self) -> String {
        let seq = self.next_prompt_seq;
        self.next_prompt_seq += 1;
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("msg_{millis}_{seq}")
    }

    /// The terminal background colour for the active screen.
    pub fn background(&self) -> Color {
        match self.screen {
            Screen::Welcome => self.theme.field_bg,
            Screen::Session => self.theme.bg,
        }
    }

    fn active_host_dir(&self) -> Option<String> {
        match &self.session {
            Some(session) => session.host_dir.clone(),
            None => std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string()),
        }
    }

    fn apply_session(&mut self, info: SessionInfo) {
        let same_session = self.session.as_ref().map(|s| &s.id) == Some(&info.id);
        let host_changed = self.session.as_ref().map(|s| &s.host_dir) != Some(&info.host_dir);
        if !same_session {
            self.history_request.set(self.history_request.get() + 1);
            self.log_cursor = None;
        }
        self.model = info
            .model
            .as_ref()
            .map(|m| (m.provider.clone(), m.id.clone()));
        if info.thinking_level.is_some() || !same_session {
            self.thinking = info.thinking_level.clone();
        }
        self.session = Some(info);
        if host_changed || self.models.is_none() {
            self.spawn_list_models();
        }
    }

    /// Active `(provider, id)` pair: the session override when set, otherwise the resolved
    /// default from `model.list`.
    pub fn active_model(&self) -> Option<(&str, &str)> {
        if let Some((provider, id)) = &self.model {
            return Some((provider.as_str(), id.as_str()));
        }
        self.models
            .as_ref()
            .map(|list| (list.default.provider.as_str(), list.default.id.as_str()))
    }

    /// Thinking levels supported by the active model, when present in `model.list`.
    pub fn active_thinking_levels(&self) -> Option<&[String]> {
        let (provider, id) = self.active_model()?;
        let list = self.models.as_ref()?;
        let p = list.providers.iter().find(|p| p.id == provider)?;
        let m = p.models.iter().find(|m| m.id == id)?;
        (!m.thinking_levels.is_empty()).then_some(m.thinking_levels.as_slice())
    }

    /// Display label for the active model.
    pub fn model_label(&self) -> String {
        if let Some((provider, id)) = &self.model {
            return format!("{provider}/{id}");
        }
        if let Some(list) = &self.models {
            return format!("{}/{}", list.default.provider, list.default.id);
        }
        if let Some(model) = &self.usage.model {
            return model.clone();
        }
        "default model".to_string()
    }

    /// Effective thinking effort level for the active model: the session override when set, and
    /// otherwise the resolved default from `model.list` (clamped to the active model's supported
    /// levels).
    pub fn thinking_label(&self) -> Option<String> {
        let requested = self.thinking.as_deref().or_else(|| {
            self.models
                .as_ref()
                .map(|list| list.default.thinking_level.as_str())
                .filter(|level| !level.is_empty())
        })?;
        Some(match self.active_thinking_levels() {
            Some(supported) => clamp_thinking_level(requested, supported),
            None => requested.to_string(),
        })
    }

    fn thinking_entries(&self) -> Vec<Entry> {
        match self.active_thinking_levels() {
            Some(levels) => levels
                .iter()
                .map(|level| {
                    let label = thinking_level_name(level);
                    Entry::owned(level.clone(), level.clone(), label)
                })
                .collect(),
            None => THINKING_LEVELS
                .iter()
                .map(|&(id, label)| Entry::item(id, label))
                .collect(),
        }
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
                    let selected = menu.selected().map(|e| e.id.to_string());
                    *menu = filter_models(search.text(), self.models.as_ref(), selected.as_deref());
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
                    let selected = menu.selected().map(|e| e.id.to_string());
                    *menu = filter_models(search.text(), self.models.as_ref(), selected.as_deref());
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
            let alternate = key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL | KeyModifiers::SUPER);
            let default_busy = if alternate {
                PromptDelivery::FollowUp
            } else {
                PromptDelivery::Steer
            };
            return self.submit_prompt(default_busy);
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
            RpcEvent::ServerInfoLoaded(Ok(info)) => {
                self.server_info = Some(info);
                true
            }
            RpcEvent::ServerInfoLoaded(Err(err)) => {
                self.notice = Some(err);
                true
            }
            RpcEvent::ModelsLoaded(Ok(models)) => {
                self.models = Some(models);
                let active_model = self.model_label();
                let active_thinking = self.thinking_label().unwrap_or_else(|| "off".to_string());
                let thinking_entries = self.thinking_entries();
                match &mut self.popup {
                    Some(Popup::Models { search, menu }) => {
                        let selected = menu
                            .selected()
                            .map(|e| e.id.to_string())
                            .unwrap_or(active_model);
                        *menu = filter_models(search.text(), self.models.as_ref(), Some(&selected));
                    }
                    Some(Popup::Thinking(menu)) => {
                        let selected = menu
                            .selected()
                            .map(|e| e.id.to_string())
                            .unwrap_or(active_thinking);
                        *menu = Menu::at(thinking_entries, &selected);
                    }
                    _ => {}
                }
                true
            }
            RpcEvent::ModelsLoaded(Err(err)) => {
                self.notice = Some(err);
                true
            }
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
            RpcEvent::SessionHistoryRefresh { session_id } => {
                if self.session.as_ref().is_some_and(|s| s.id == session_id) {
                    self.spawn_session_history(&session_id);
                }
                false
            }
            RpcEvent::SessionHistoryLoaded {
                session_id,
                request_id,
                revision,
                result,
            } => {
                if !self.session.as_ref().is_some_and(|s| s.id == session_id)
                    || request_id != self.history_request.get()
                {
                    return false;
                }
                if revision != self.history_revision {
                    self.spawn_session_history(&session_id);
                    return false;
                }
                let entries = match result {
                    Ok(entries) => entries,
                    Err(err) => {
                        self.notice = Some(err);
                        return true;
                    }
                };
                let was_empty = self.turns.is_empty();
                crate::rpc::client::advance_log_cursor(
                    &mut self.log_cursor,
                    crate::rpc::client::history_cursor(&entries),
                );
                self.sync_turns_from_history(&entries);
                self.busy = self
                    .turns
                    .last()
                    .is_some_and(|turn| turn.state == TurnState::Running);
                if was_empty {
                    self.scroll = 0;
                }
                let stream_running = self
                    .prompt_stream
                    .as_ref()
                    .is_some_and(|task| !task.is_finished());
                if !stream_running {
                    if let Some(session_id) = self.session.as_ref().map(|s| s.id.clone()) {
                        self.spawn_follow_session(session_id, self.log_cursor, self.busy);
                    }
                }
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
            RpcEvent::PromptDispatched {
                session_id,
                message_id,
                result,
            } => {
                if self.session.as_ref().is_none_or(|s| s.id != session_id) {
                    return false;
                }
                match result {
                    Ok(()) => {
                        if let Some(queued) = self
                            .queued_prompts
                            .iter_mut()
                            .find(|q| q.message_id == message_id)
                        {
                            queued.admitted = true;
                        }
                    }
                    Err(err) => {
                        self.queued_prompts.retain(|q| q.message_id != message_id);
                        if let Some(turn) = self.turns.last_mut() {
                            if turn.prompt_id.as_deref() == Some(message_id.as_str()) {
                                turn.state = TurnState::Failed(err.clone());
                                self.busy = false;
                            }
                        }
                        self.notice = Some(err);
                    }
                }
                true
            }
            RpcEvent::Stream(stream) => self.handle_stream(stream),
            RpcEvent::SessionStream { session_id, event } => {
                if self.session.as_ref().is_some_and(|s| s.id == session_id) {
                    self.handle_stream(event)
                } else {
                    false
                }
            }
        }
    }

    fn refresh_open_config_popups(&mut self) {
        let active_model = self.model_label();
        let active_thinking = self.thinking_label().unwrap_or_else(|| "off".to_string());
        let thinking_entries = self.thinking_entries();
        match &mut self.popup {
            Some(Popup::Models { search, menu }) => {
                let selected = menu
                    .selected()
                    .map(|e| e.id.to_string())
                    .unwrap_or(active_model);
                *menu = filter_models(search.text(), self.models.as_ref(), Some(&selected));
            }
            Some(Popup::Thinking(menu)) => {
                let selected = menu
                    .selected()
                    .map(|e| e.id.to_string())
                    .unwrap_or(active_thinking);
                *menu = Menu::at(thinking_entries, &selected);
            }
            _ => {}
        }
    }

    fn handle_stream(&mut self, event: StreamEvent) -> bool {
        // A snapshot requested before this event cannot replace the newer UI state.
        self.history_revision += 1;
        match event {
            StreamEvent::SessionCreated(info) => {
                self.apply_session(info);
            }
            StreamEvent::ExecutionStarted => {
                self.busy = true;
            }
            StreamEvent::PromptAdmitted {
                message_id,
                prompt,
                delivery,
            } => {
                let initial_admitted =
                    self.initial_prompt_id.as_deref() == Some(message_id.as_str());
                let already_in_turns = self
                    .turns
                    .iter()
                    .any(|t| t.prompt_id.as_deref() == Some(message_id.as_str()))
                    || self.turns.last().is_some_and(|t| {
                        t.prompt_id.is_none()
                            && t.prompt == prompt
                            && t.state == TurnState::Running
                            && t.text.is_empty()
                            && t.thinking.is_empty()
                            && t.tools.is_empty()
                    });
                if already_in_turns {
                    if let Some(last) = self.turns.last_mut() {
                        if last.prompt_id.is_none() && last.prompt == prompt {
                            last.prompt_id = Some(message_id);
                        }
                    }
                } else if let Some(existing) = self
                    .queued_prompts
                    .iter_mut()
                    .find(|q| q.message_id == message_id)
                {
                    if !prompt.is_empty() {
                        existing.prompt = prompt;
                    }
                    existing.delivery = delivery;
                    existing.admitted = true;
                    existing.dispatched = true;
                } else {
                    self.queued_prompts.push(QueuedPrompt {
                        message_id,
                        prompt,
                        delivery,
                        admitted: true,
                        dispatched: true,
                    });
                }
                if initial_admitted {
                    self.initial_prompt_id = None;
                    if let Some(session_id) = self.session.as_ref().map(|s| s.id.clone()) {
                        self.dispatch_pending_queued_prompts(&session_id);
                    }
                }
            }
            StreamEvent::PromptPromoted {
                message_id,
                prompt,
                delivery: _,
            } => {
                let queued_prompt = self
                    .queued_prompts
                    .iter()
                    .position(|q| q.message_id == message_id)
                    .map(|idx| self.queued_prompts.remove(idx));
                let resolved_prompt = if !prompt.is_empty() {
                    prompt
                } else {
                    queued_prompt.map(|q| q.prompt).unwrap_or_default()
                };

                let already_active = self
                    .turns
                    .iter()
                    .any(|t| t.prompt_id.as_deref() == Some(message_id.as_str()));
                if already_active {
                    return true;
                }

                // If the initial turn was created without a `prompt_id` (e.g. in tests) and matches
                // this prompt before any assistant output arrived, bind `prompt_id` to it in place.
                if let Some(last) = self.turns.last_mut() {
                    if last.prompt_id.is_none()
                        && last.prompt == resolved_prompt
                        && last.state == TurnState::Running
                        && last.text.is_empty()
                        && last.thinking.is_empty()
                        && last.tools.is_empty()
                        && last.drafts.is_empty()
                    {
                        last.prompt_id = Some(message_id);
                        return true;
                    }
                    if last.state == TurnState::Running {
                        last.retry = None;
                        last.state = TurnState::Succeeded;
                    }
                }

                self.busy = true;
                self.screen = Screen::Session;
                self.turns.push(Turn::with_id(message_id, resolved_prompt));
                if self.notice.as_deref() == Some("steering current turn...")
                    || self.notice.as_deref() == Some("queued follow-up prompt")
                {
                    self.notice = None;
                }
            }
            StreamEvent::ConfigChanged {
                model,
                thinking_level,
            } => {
                if let Some(model_ref) = model {
                    self.model = Some((model_ref.provider.clone(), model_ref.id.clone()));
                    if let Some(session) = &mut self.session {
                        session.model = Some(model_ref);
                    }
                    if thinking_level.is_none() {
                        if let (Some(level), Some(supported)) =
                            (self.thinking.clone(), self.active_thinking_levels())
                        {
                            self.thinking = Some(clamp_thinking_level(&level, supported));
                        }
                    }
                }
                if let Some(level) = thinking_level {
                    self.thinking = Some(level.clone());
                    if let Some(session) = &mut self.session {
                        session.thinking_level = Some(level);
                    }
                }
                self.refresh_open_config_popups();
            }
            StreamEvent::SessionForked {
                session_id,
                source_session_id,
                source_entry_id,
                base_seq: _,
            } => {
                let active_id = self.session.as_ref().map(|s| s.id.as_str());
                let msg = if active_id == Some(source_session_id.as_str())
                    && session_id != source_session_id
                {
                    format!("forked session {session_id} from {source_entry_id}")
                } else {
                    format!("session forked from {source_session_id} at {source_entry_id}")
                };
                self.notice = Some(msg.clone());
                if let Some(turn) = self.turns.last_mut() {
                    if !turn.notices.contains(&msg) {
                        turn.notices.push(msg);
                    }
                }
            }
            StreamEvent::TurnStarted => {
                self.busy = true;
                if let Some(turn) = self.turns.last_mut() {
                    turn.retry = None;
                    if turn.state != TurnState::Running {
                        turn.state = TurnState::Running;
                    }
                } else {
                    self.turns.push(Turn::new(String::new()));
                }
            }
            StreamEvent::TurnEnded { message_id: _ } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.retry = None;
                }
            }
            StreamEvent::TurnAborted { reason, message } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.retry = None;
                    if reason == "interrupted" {
                        turn.state = TurnState::Interrupted(
                            message.unwrap_or_else(|| "interrupted".to_string()),
                        );
                    } else {
                        turn.state = TurnState::Failed(message.unwrap_or(reason));
                    }
                }
            }
            StreamEvent::RetryScheduled {
                attempt,
                max_retries,
                delay_ms,
                message,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.retry = Some(RetryStatus {
                        attempt,
                        max_retries,
                        delay_ms,
                        message,
                    });
                }
            }
            StreamEvent::RetryFinished {
                attempt,
                success,
                message,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.retry = None;
                    if !success {
                        if let Some(msg) = message.filter(|m| !m.is_empty()) {
                            turn.notices.push(format!("retry {attempt} failed: {msg}"));
                        }
                    }
                }
            }
            StreamEvent::LlmStarted { message_id, model } => {
                if let Some(model) = model {
                    self.usage.model = Some(model);
                }
                if let Some(turn) = self.turns.last_mut() {
                    turn.start_llm(&message_id);
                }
            }
            StreamEvent::LlmFailed {
                message_id,
                reason: _,
                error: _,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.fail_llm(&message_id);
                }
            }
            StreamEvent::TextStart {
                message_id,
                part_index,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.start_text_part(&message_id, part_index);
                }
            }
            StreamEvent::TextDelta {
                message_id,
                part_index,
                delta,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.append_text_delta(message_id.as_deref(), part_index, &delta);
                }
            }
            StreamEvent::TextEnd {
                message_id,
                part_index,
                content,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.end_text_part(&message_id, part_index, content);
                }
            }
            StreamEvent::ThinkingStart {
                message_id,
                part_index,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.start_thinking_part(&message_id, part_index);
                }
            }
            StreamEvent::ThinkingDelta {
                message_id,
                part_index,
                delta,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.append_thinking_delta(message_id.as_deref(), part_index, &delta);
                }
            }
            StreamEvent::ThinkingEnd {
                message_id,
                part_index,
                content,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.end_thinking_part(&message_id, part_index, content);
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
            StreamEvent::ToolProgress {
                call_id,
                output,
                details,
            } => {
                if let Some(turn) = self.turns.last_mut() {
                    if let Some(existing) = turn.tools.iter_mut().find(|t| t.call_id == call_id) {
                        existing.apply_progress(output, details.as_ref());
                    } else {
                        let mut call = ToolCall::start(
                            call_id,
                            "tool".to_string(),
                            None,
                            &serde_json::Value::Null,
                        );
                        call.apply_progress(output, details.as_ref());
                        turn.tools.push(call);
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
            StreamEvent::LogSynced { seq } => {
                let prev = self.log_cursor;
                crate::rpc::client::advance_log_cursor(&mut self.log_cursor, seq);
                if self.log_cursor != prev {
                    if let Some(session_id) = self.session.as_ref().map(|s| s.id.clone()) {
                        self.spawn_session_history(&session_id);
                    }
                }
            }
            StreamEvent::Disconnected => {
                self.reconnecting = true;
            }
            StreamEvent::Reconnected => {
                self.reconnecting = false;
                if self.initial_prompt_id.is_none() {
                    if let Some(session_id) = self.session.as_ref().map(|s| s.id.clone()) {
                        self.reconcile_queued_prompts(&session_id);
                        self.spawn_session_history(&session_id);
                    }
                }
            }
            StreamEvent::Succeeded => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.retry = None;
                    if turn.state == TurnState::Running {
                        turn.state = TurnState::Succeeded;
                    }
                }
                self.busy = false;
                self.reconnecting = false;
                self.spawn_session_refresh();
            }
            StreamEvent::Failed(err) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.retry = None;
                    turn.state = TurnState::Failed(err);
                }
                self.busy = false;
                self.reconnecting = false;
            }
            StreamEvent::Interrupted(reason) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.retry = None;
                    turn.state = TurnState::Interrupted(reason);
                }
                self.busy = false;
                self.reconnecting = false;
            }
        }
        true
    }

    fn submit_prompt(&mut self, default_busy_delivery: PromptDelivery) -> bool {
        let Some((text, delivery)) =
            parse_prompt_submission(self.prompt.text(), default_busy_delivery, self.busy)
        else {
            return false;
        };

        self.history_revision += 1;
        let message_id = self.next_message_id();
        self.prompt.clear();
        self.screen = Screen::Session;
        self.scroll = 0;

        let stream_running = self
            .prompt_stream
            .as_ref()
            .is_some_and(|task| !task.is_finished());
        let awaiting_subscription = self.initial_prompt_id.is_some() || self.reconnecting;
        if self.busy || (stream_running && awaiting_subscription) {
            let session_id = self
                .session
                .as_ref()
                .filter(|_| self.initial_prompt_id.is_none() && !self.reconnecting)
                .map(|s| s.id.clone());
            let dispatched = session_id.is_some();
            self.queued_prompts.push(QueuedPrompt {
                message_id: message_id.clone(),
                prompt: text.clone(),
                delivery,
                admitted: false,
                dispatched,
            });
            self.notice = Some(match delivery {
                PromptDelivery::Steer => "steering current turn...".to_string(),
                PromptDelivery::FollowUp => "queued follow-up prompt".to_string(),
            });
            if let Some(session_id) = session_id {
                self.spawn_send_prompt(session_id, text, delivery, message_id);
            }
            return true;
        }

        self.notice = None;
        self.busy = true;
        self.reconnecting = false;
        self.turns
            .push(Turn::with_id(message_id.clone(), text.clone()));

        if stream_running {
            if let Some(session_id) = self.session.as_ref().map(|s| s.id.clone()) {
                self.spawn_send_prompt(session_id, text, delivery, message_id);
                return true;
            }
        }
        self.initial_prompt_id = Some(message_id.clone());

        let tx = self.tx.clone();
        let existing_session_id = self.session.as_ref().map(|s| s.id.clone());
        let after = self.log_cursor;
        let model = self.model.clone();
        let thinking = self.thinking.clone();

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let task = handle.spawn(async move {
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
                            let _ =
                                tx.send(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::Failed(err))));
                            return;
                        }
                    },
                };

                let (stream_tx, mut stream_rx) = mpsc::unbounded_channel();
                let stream = client.watch_session_from(
                    session_id.clone(),
                    after,
                    Some((text, delivery, message_id)),
                    true,
                    stream_tx,
                );
                tokio::pin!(stream);
                // Own the stream and forwarding in one task so switching sessions cancels both.
                loop {
                    tokio::select! {
                        biased;
                        Some(event) = stream_rx.recv() => {
                            if tx.send(AppEvent::Rpc(RpcEvent::SessionStream {
                                session_id: session_id.clone(), event,
                            })).is_err() {
                                break;
                            }
                        }
                        _ = &mut stream => break,
                    }
                }
                while let Ok(event) = stream_rx.try_recv() {
                    let _ = tx.send(AppEvent::Rpc(RpcEvent::SessionStream {
                        session_id: session_id.clone(),
                        event,
                    }));
                }
            });
            self.prompt_stream = Some(task.abort_handle());
        }

        true
    }

    fn spawn_follow_session(
        &mut self,
        session_id: String,
        after: Option<u64>,
        initially_busy: bool,
    ) {
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let task = handle.spawn(async move {
                let client = RpcClient::default();
                let (stream_tx, mut stream_rx) = mpsc::unbounded_channel();
                let stream =
                    client.follow_session(session_id.clone(), after, initially_busy, stream_tx);
                tokio::pin!(stream);
                loop {
                    tokio::select! {
                        biased;
                        Some(event) = stream_rx.recv() => {
                            if tx.send(AppEvent::Rpc(RpcEvent::SessionStream {
                                session_id: session_id.clone(), event,
                            })).is_err() {
                                break;
                            }
                        }
                        _ = &mut stream => break,
                    }
                }
                while let Ok(event) = stream_rx.try_recv() {
                    let _ = tx.send(AppEvent::Rpc(RpcEvent::SessionStream {
                        session_id: session_id.clone(),
                        event,
                    }));
                }
            });
            self.prompt_stream = Some(task.abort_handle());
        }
    }

    fn dispatch_pending_queued_prompts(&mut self, session_id: &str) {
        let mut to_send = Vec::new();
        for queued in &mut self.queued_prompts {
            if !queued.dispatched && !queued.admitted {
                queued.dispatched = true;
                to_send.push((
                    queued.prompt.clone(),
                    queued.delivery,
                    queued.message_id.clone(),
                ));
            }
        }
        for (text, delivery, message_id) in to_send {
            self.spawn_send_prompt(session_id.to_string(), text, delivery, message_id);
        }
    }

    fn reconcile_queued_prompts(&mut self, session_id: &str) {
        let mut to_send = Vec::new();
        let mut to_reconcile = Vec::new();
        for queued in &mut self.queued_prompts {
            if !queued.dispatched && !queued.admitted {
                queued.dispatched = true;
                to_send.push((
                    queued.prompt.clone(),
                    queued.delivery,
                    queued.message_id.clone(),
                ));
            } else if queued.dispatched {
                to_reconcile.push((
                    queued.prompt.clone(),
                    queued.delivery,
                    queued.message_id.clone(),
                ));
            }
        }
        for (text, delivery, message_id) in to_send {
            self.spawn_send_prompt(session_id.to_string(), text, delivery, message_id);
        }
        for (text, delivery, message_id) in to_reconcile {
            self.spawn_reconcile_prompt(session_id.to_string(), text, delivery, message_id);
        }
    }

    fn spawn_reconcile_prompt(
        &self,
        session_id: String,
        text: String,
        delivery: PromptDelivery,
        message_id: String,
    ) {
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let client = RpcClient::default();
                match client.session_message(&session_id, &message_id).await {
                    Ok(true) => {
                        let _ = tx.send(AppEvent::Rpc(RpcEvent::SessionHistoryRefresh {
                            session_id,
                        }));
                    }
                    Ok(false) => {
                        let result = client
                            .send_prompt(&session_id, &text, delivery, &message_id)
                            .await;
                        let _ = tx.send(AppEvent::Rpc(RpcEvent::PromptDispatched {
                            session_id,
                            message_id,
                            result,
                        }));
                    }
                    Err(_) => {}
                }
            });
        }
    }

    fn stop_prompt_stream(&mut self) {
        if let Some(task) = self.prompt_stream.take() {
            task.abort();
        }
        self.initial_prompt_id = None;
    }

    fn spawn_session_refresh(&self) {
        let Some(session_id) = self.session.as_ref().map(|s| s.id.clone()) else {
            return;
        };
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if let Ok(info) = RpcClient::default().session_info(&session_id).await {
                    let _ = tx.send(AppEvent::Rpc(RpcEvent::SessionStream {
                        session_id,
                        event: StreamEvent::SessionCreated(info),
                    }));
                }
            });
        }
    }

    fn spawn_send_prompt(
        &self,
        session_id: String,
        text: String,
        delivery: PromptDelivery,
        message_id: String,
    ) {
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let result = RpcClient::default()
                    .send_prompt(&session_id, &text, delivery, &message_id)
                    .await;
                let _ = tx.send(AppEvent::Rpc(RpcEvent::PromptDispatched {
                    session_id,
                    message_id,
                    result,
                }));
            });
        }
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
                            menu: filter_models("", self.models.as_ref(), Some(&current)),
                        });
                        self.spawn_list_models();
                    }
                    "thinking" => {
                        let current = self.thinking_label().unwrap_or_else(|| "off".to_string());
                        self.popup =
                            Some(Popup::Thinking(Menu::at(self.thinking_entries(), &current)));
                        if self.models.is_none() {
                            self.spawn_list_models();
                        }
                    }
                    "session" => {
                        self.notice = Some("loading sessions...".to_string());
                        self.spawn_list_sessions();
                    }
                    "new" => {
                        self.stop_prompt_stream();
                        self.session = None;
                        self.turns.clear();
                        self.queued_prompts.clear();
                        self.usage = UsageReport::default();
                        self.busy = false;
                        self.reconnecting = false;
                        self.log_cursor = None;
                        self.scroll = 0;
                        self.notice = Some("started a new session".to_string());
                        self.spawn_list_models();
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
                    if let (Some(level), Some(supported)) =
                        (self.thinking.clone(), self.active_thinking_levels())
                    {
                        self.thinking = Some(clamp_thinking_level(&level, supported));
                    }
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
                    self.stop_prompt_stream();
                    let session_id = info.id.clone();
                    let title = info.title.clone();
                    self.log_cursor = None;
                    self.apply_session(info);
                    self.turns.clear();
                    self.queued_prompts.clear();
                    self.usage = UsageReport::default();
                    self.busy = false;
                    self.reconnecting = false;
                    self.scroll = 0;
                    self.screen = Screen::Session;
                    self.notice = Some(format!("switched to session {title}"));
                    self.spawn_session_refresh();
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

    fn spawn_server_info(&self) {
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let res = RpcClient::default().verify_server().await;
                let _ = tx.send(AppEvent::Rpc(RpcEvent::ServerInfoLoaded(res)));
            });
        }
    }

    fn spawn_list_models(&self) {
        let host_dir = self.active_host_dir();
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let res = RpcClient::default().list_models(host_dir.as_deref()).await;
                let _ = tx.send(AppEvent::Rpc(RpcEvent::ModelsLoaded(res)));
            });
        }
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
        let request_id = self.history_request.get() + 1;
        self.history_request.set(request_id);
        let revision = self.history_revision;
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let result = RpcClient::default().session_history(&session_id).await;
                let _ = tx.send(AppEvent::Rpc(RpcEvent::SessionHistoryLoaded {
                    session_id,
                    request_id,
                    revision,
                    result,
                }));
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

    fn sync_turns_from_history(&mut self, entries: &[HistoryEntry]) {
        self.queued_prompts
            .retain(|q| !entries.iter().any(|e| e.id == q.message_id));

        let mut next_turns = turns_from_history(entries);
        let last_entry_is_user = entries.last().is_some_and(|e| e.role == "user");
        let total_next = next_turns.len();

        for (idx, turn) in next_turns.iter_mut().enumerate() {
            let Some(prompt_id) = turn.prompt_id.as_deref() else {
                continue;
            };
            let Some(existing) = self
                .turns
                .iter()
                .find(|t| t.prompt_id.as_deref() == Some(prompt_id))
            else {
                continue;
            };

            for notice in &existing.notices {
                if !turn.notices.contains(notice) {
                    turn.notices.push(notice.clone());
                }
            }

            if idx + 1 == total_next
                && last_entry_is_user
                && existing.state == TurnState::Running
                && self.busy
            {
                turn.state = TurnState::Running;
            }

            if turn.state == TurnState::Running {
                if turn.retry.is_none() {
                    turn.retry = existing.retry.clone();
                }
                for draft in &existing.drafts {
                    let target = turn.draft_mut(&draft.message_id);
                    for (&part_idx, thinking) in &draft.thinking_parts {
                        let entry = target.thinking_parts.entry(part_idx).or_default();
                        if entry.len() < thinking.len() {
                            *entry = thinking.clone();
                        }
                    }
                    for (&part_idx, text) in &draft.text_parts {
                        let entry = target.text_parts.entry(part_idx).or_default();
                        if entry.len() < text.len() {
                            *entry = text.clone();
                        }
                    }
                }
                turn.sync_thinking();
                turn.sync_text();
            }

            if matches!(
                existing.state,
                TurnState::Failed(_) | TurnState::Interrupted(_)
            ) || (existing.state == TurnState::Succeeded && turn.state == TurnState::Running)
            {
                turn.state = existing.state.clone();
                turn.retry = None;
            }

            for existing_tool in &existing.tools {
                if let Some(tool) = turn
                    .tools
                    .iter_mut()
                    .find(|t| t.call_id == existing_tool.call_id)
                {
                    if tool.patch.is_none() && existing_tool.patch.is_some() {
                        tool.patch = existing_tool.patch.clone();
                    }
                    if tool.output.is_none() && existing_tool.output.is_some() {
                        tool.output = existing_tool.output.clone();
                    }
                    if tool.summary.is_none() && existing_tool.summary.is_some() {
                        tool.summary = existing_tool.summary.clone();
                    }
                } else if turn.state == TurnState::Running {
                    turn.tools.push(existing_tool.clone());
                }
            }
        }

        if self.busy {
            if let Some(last_local) = self.turns.last() {
                if last_local.state == TurnState::Running {
                    let in_history = last_local.prompt_id.as_deref().is_some_and(|id| {
                        next_turns
                            .iter()
                            .any(|t| t.prompt_id.as_deref() == Some(id))
                    });
                    if !in_history {
                        next_turns.push(last_local.clone());
                    }
                }
            }
        }

        self.turns = next_turns;
    }
}

fn theme_named(name: &str) -> Option<&'static Palette> {
    theme::PALETTES.iter().find(|palette| palette.name == name)
}

fn parse_prompt_submission(
    raw: &str,
    default_busy_delivery: PromptDelivery,
    busy: bool,
) -> Option<(String, PromptDelivery)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('/') {
        let mut parts = rest.splitn(2, char::is_whitespace);
        let cmd = parts.next().unwrap_or("");
        let body = parts.next().map(str::trim).unwrap_or("");
        if cmd.eq_ignore_ascii_case("steer") {
            return (!body.is_empty()).then(|| (body.to_string(), PromptDelivery::Steer));
        }
        if cmd.eq_ignore_ascii_case("followup") || cmd.eq_ignore_ascii_case("follow-up") {
            return (!body.is_empty()).then(|| (body.to_string(), PromptDelivery::FollowUp));
        }
    }
    let delivery = if busy {
        default_busy_delivery
    } else {
        PromptDelivery::FollowUp
    };
    Some((trimmed.to_string(), delivery))
}

/// Splits a `provider/model` identifier on its first slash (matching `acp/config.ts:parseModel`).
fn parse_model(value: &str) -> Option<(String, String)> {
    let slash = value.find('/')?;
    if slash == 0 || slash + 1 >= value.len() {
        return None;
    }
    Some((value[..slash].to_string(), value[slash + 1..].to_string()))
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

fn thinking_level_name(level: &str) -> &'static str {
    THINKING_LEVELS
        .iter()
        .find_map(|&(id, label)| (id == level).then_some(label))
        .unwrap_or("Off")
}

/// Clamp `level` to the active model's `supported` thinking levels: exact match, else next level
/// up on the ladder, else next level down, else the first supported level (matching the harness).
fn clamp_thinking_level(level: &str, supported: &[String]) -> String {
    if supported.is_empty() || supported.iter().any(|s| s == level) {
        return level.to_string();
    }
    if let Some(at) = THINKING_LEVELS.iter().position(|&(id, _)| id == level) {
        if let Some(&(next_up, _)) = THINKING_LEVELS[at + 1..]
            .iter()
            .find(|&&(id, _)| supported.iter().any(|s| s == id))
        {
            return next_up.to_string();
        }
        if let Some(&(next_down, _)) = THINKING_LEVELS[..at]
            .iter()
            .rev()
            .find(|&&(id, _)| supported.iter().any(|s| s == id))
        {
            return next_down.to_string();
        }
    }
    supported[0].clone()
}

fn model_entries(models: Option<&ModelList>) -> Vec<Entry> {
    let Some(list) = models else {
        return Vec::new();
    };
    let default_key = format!("{}/{}", list.default.provider, list.default.id);
    let default_provider_available = list.providers.iter().any(|p| p.id == list.default.provider);

    let mut entries: Vec<Entry> = Vec::new();
    for provider in &list.providers {
        for model in &provider.models {
            let id = format!("{}/{}", provider.id, model.id);
            let is_default = provider.id == list.default.provider && model.id == list.default.id;
            let detail = if is_default {
                format!("{} · {} · default", provider.name, model.name)
            } else {
                format!("{} · {}", provider.name, model.name)
            };
            entries.push(Entry::owned(id.clone(), id, detail));
        }
    }

    if !entries.iter().any(|e| e.id.as_ref() == default_key) {
        let provider_name = list
            .default
            .provider_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                list.providers
                    .iter()
                    .find(|p| p.id == list.default.provider)
                    .map(|p| p.name.as_str())
            })
            .unwrap_or(&list.default.provider);
        let model_name = list
            .default
            .name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&list.default.id);
        let detail = if default_provider_available {
            format!("{provider_name} · {model_name} · default")
        } else {
            format!("{provider_name} · {model_name} · default (no credentials)")
        };
        entries.insert(0, Entry::owned(default_key.clone(), default_key, detail));
    }

    entries
}

/// Build the model picker's menu from `model.list`, including any custom `provider/model` typed in
/// the search box.
fn filter_models(query: &str, models: Option<&ModelList>, active: Option<&str>) -> Menu {
    let trimmed = query.trim();
    let needle = trimmed.to_ascii_lowercase();
    let mut entries = model_entries(models);
    if parse_model(trimmed).is_some() && !entries.iter().any(|e| e.id.eq_ignore_ascii_case(trimmed))
    {
        entries.insert(0, Entry::owned(trimmed, trimmed, "custom"));
    }
    let mut menu = Menu::at(entries, active.unwrap_or(""));
    menu.filter(|entry| {
        needle.is_empty()
            || entry.name.to_ascii_lowercase().contains(&needle)
            || entry.detail.to_ascii_lowercase().contains(&needle)
            || entry.id.to_ascii_lowercase().contains(&needle)
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
            let mut turn = Turn::with_id(entry.id.clone(), prompt);
            turn.state = entry_turn_state(&entry.state);
            turns.push(turn);
            continue;
        }

        if turns.is_empty() {
            let mut turn = Turn::new(String::new());
            turn.state = TurnState::Succeeded;
            turns.push(turn);
        }

        let Some(turn) = turns.last_mut() else {
            continue;
        };
        turn.state = entry_turn_state(&entry.state);

        for (part_idx, part) in entry.parts.iter().enumerate() {
            match part {
                Part::Text { text } if !text.is_empty() => {
                    turn.end_text_part(&entry.id, part_idx, text.clone());
                }
                Part::Thinking { thinking, redacted }
                    if redacted != &Some(true) && !thinking.is_empty() =>
                {
                    turn.end_thinking_part(&entry.id, part_idx, thinking.clone());
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
    use crate::types::{
        DefaultModel, ModelOption, ModelProvider, ModelRef, ProjectInfo, ToolResult, ToolTime,
    };
    use serde_json::json;

    #[test]
    fn history_cannot_resurrect_completed_turns_or_cross_sessions() {
        let mut app = App::default();
        app.session = Some(
            serde_json::from_value(json!({
                "id": "ses", "title": "Session", "directory": "/workspace", "updatedAt": 0
            }))
            .unwrap(),
        );
        app.turns.push(Turn::with_id("prompt", "Question"));
        app.busy = true;
        let entries = vec![
            HistoryEntry {
                id: "prompt".into(),
                seq: 1,
                role: "user".into(),
                state: "committed".into(),
                created_at: 0,
                parts: vec![],
            },
            HistoryEntry {
                id: "answer".into(),
                seq: 2,
                role: "assistant".into(),
                state: "draft".into(),
                created_at: 0,
                parts: vec![],
            },
        ];
        let stale = history_event(&app, entries.clone());
        app.handle_stream(StreamEvent::TextEnd {
            message_id: "answer".into(),
            part_index: 0,
            content: "Finished".into(),
        });
        app.handle_stream(StreamEvent::Succeeded);
        app.update(stale);
        assert!(!app.busy);
        assert_eq!(app.turns[0].state, TurnState::Succeeded);
        assert_eq!(app.turns[0].text, "Finished");

        let wrong_session = history_event(&app, entries.clone());
        app.session.as_mut().unwrap().id = "other".into();
        app.turns.clear();
        app.log_cursor = None;
        app.update(wrong_session);
        assert!(app.turns.is_empty());
        assert_eq!(app.log_cursor, None);

        // A newer request wins even when there were no intervening stream events.
        let outdated = history_event(&app, entries);
        app.history_request.set(app.history_request.get() + 1);
        app.update(outdated);
        assert!(app.turns.is_empty());
    }

    fn history_event(app: &App, entries: Vec<HistoryEntry>) -> AppEvent {
        AppEvent::Rpc(RpcEvent::SessionHistoryLoaded {
            session_id: app.session.as_ref().unwrap().id.clone(),
            request_id: app.history_request.get(),
            revision: app.history_revision,
            result: Ok(entries),
        })
    }

    #[test]
    fn waits_for_initial_admission_before_dispatching_pending_prompts() {
        let mut app = App::default();
        app.prompt.insert_text("initial");
        app.submit_prompt(PromptDelivery::FollowUp);
        let initial_id = app.turns[0].prompt_id.clone().unwrap();
        app.prompt.insert_text("second");
        app.submit_prompt(PromptDelivery::Steer);
        let info = serde_json::from_value(json!({
            "id": "ses_startup", "title": "Startup", "directory": "/workspace", "updatedAt": 0
        }))
        .unwrap();
        app.handle_stream(StreamEvent::SessionCreated(info));
        assert!(!app.queued_prompts[0].dispatched);
        app.handle_stream(StreamEvent::PromptAdmitted {
            message_id: initial_id,
            prompt: "initial".to_string(),
            delivery: PromptDelivery::FollowUp,
        });
        assert!(app.queued_prompts[0].dispatched);
    }

    #[test]
    fn retains_pending_prompts_across_execution_terminals() {
        for terminal in [
            StreamEvent::Succeeded,
            StreamEvent::Failed("provider failed".to_string()),
            StreamEvent::Interrupted("user".to_string()),
        ] {
            let mut app = App::default();
            app.turns.push(Turn::with_id("initial", "initial"));
            app.busy = true;
            app.queued_prompts.push(QueuedPrompt {
                message_id: "pending".to_string(),
                prompt: "next".to_string(),
                delivery: PromptDelivery::FollowUp,
                admitted: false,
                dispatched: true,
            });
            app.handle_stream(terminal);
            assert_eq!(app.queued_prompts.len(), 1);
            app.handle_stream(StreamEvent::PromptPromoted {
                message_id: "pending".to_string(),
                prompt: "next".to_string(),
                delivery: PromptDelivery::FollowUp,
            });
            assert!(app.queued_prompts.is_empty());
            assert!(app.busy);
            assert_eq!(
                app.turns.last().unwrap().prompt_id.as_deref(),
                Some("pending")
            );
        }
    }

    #[test]
    fn correlates_identical_queued_prompts_by_id() {
        let mut app = App::default();
        for (id, delivery) in [
            ("follow", PromptDelivery::FollowUp),
            ("steer", PromptDelivery::Steer),
        ] {
            app.queued_prompts.push(QueuedPrompt {
                message_id: id.to_string(),
                prompt: "same text".to_string(),
                delivery,
                admitted: false,
                dispatched: true,
            });
        }
        // A different client can submit the same text and delivery.
        app.handle_stream(StreamEvent::PromptAdmitted {
            message_id: "external".to_string(),
            prompt: "same text".to_string(),
            delivery: PromptDelivery::FollowUp,
        });
        assert_eq!(app.queued_prompts.len(), 3);
        app.handle_stream(StreamEvent::PromptPromoted {
            message_id: "steer".to_string(),
            prompt: "same text".to_string(),
            delivery: PromptDelivery::Steer,
        });
        let ids: Vec<_> = app
            .queued_prompts
            .iter()
            .map(|q| q.message_id.as_str())
            .collect();
        assert_eq!(ids, ["follow", "external"]);
    }

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
                thinking_level: None,
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
                thinking_level: None,
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
                thinking_level: None,
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
            thinking_level: None,
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
            thinking_level: None,
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
        app.update(history_event(
            &app,
            vec![
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
            ],
        ));
        assert_eq!(app.turns.len(), 1);
        assert_eq!(app.turns[0].prompt, "Resume me");
        assert_eq!(app.turns[0].text, "Resumed!");
        assert_eq!(app.turns[0].state, TurnState::Succeeded);
        assert!(!app.busy);
    }

    #[test]
    fn populates_model_picker_and_flags_unavailable_default() {
        let mut app = App::default();
        assert_eq!(app.model_label(), "default model");
        assert_eq!(app.thinking_label(), None);

        let list = ModelList {
            providers: vec![ModelProvider {
                id: "anthropic".to_string(),
                name: "Anthropic".to_string(),
                models: vec![ModelOption {
                    id: "claude-sonnet-4-5".to_string(),
                    name: "Claude Sonnet 4.5".to_string(),
                    thinking_levels: vec![
                        "off".to_string(),
                        "low".to_string(),
                        "medium".to_string(),
                        "high".to_string(),
                    ],
                }],
            }],
            default: DefaultModel {
                provider: "openai".to_string(),
                id: "gpt-5.6-luna".to_string(),
                thinking_level: "medium".to_string(),
                name: Some("GPT-5.6 Luna".to_string()),
                provider_name: Some("OpenAI".to_string()),
            },
        };

        app.update(AppEvent::Rpc(RpcEvent::ModelsLoaded(Ok(list))));
        assert_eq!(app.model_label(), "openai/gpt-5.6-luna");
        assert_eq!(app.thinking_label().as_deref(), Some("medium"));

        // Open `/model` via command menu.
        app.update(AppEvent::Paste("/model".to_string()));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Enter)));

        let Some(Popup::Models { menu, .. }) = &app.popup else {
            panic!("expected Models popup");
        };
        let entries = menu.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id.as_ref(), "openai/gpt-5.6-luna");
        assert_eq!(
            entries[0].detail.as_ref(),
            "OpenAI · GPT-5.6 Luna · default (no credentials)"
        );
        assert_eq!(entries[1].id.as_ref(), "anthropic/claude-sonnet-4-5");
        assert_eq!(entries[1].detail.as_ref(), "Anthropic · Claude Sonnet 4.5");
        assert_eq!(menu.cursor(), 0);
    }

    #[test]
    fn filters_thinking_options_to_active_model_and_clamps_default() {
        let mut app = App::default();
        let list = ModelList {
            providers: vec![
                ModelProvider {
                    id: "anthropic".to_string(),
                    name: "Anthropic".to_string(),
                    models: vec![ModelOption {
                        id: "claude-sonnet-4-5".to_string(),
                        name: "Claude Sonnet 4.5".to_string(),
                        thinking_levels: vec![
                            "off".to_string(),
                            "low".to_string(),
                            "medium".to_string(),
                            "high".to_string(),
                        ],
                    }],
                },
                ModelProvider {
                    id: "local".to_string(),
                    name: "Local".to_string(),
                    models: vec![ModelOption {
                        id: "qwen3-coder:30b".to_string(),
                        name: "Qwen3 Coder 30B".to_string(),
                        thinking_levels: vec!["off".to_string()],
                    }],
                },
            ],
            default: DefaultModel {
                provider: "local".to_string(),
                id: "qwen3-coder:30b".to_string(),
                thinking_level: "medium".to_string(),
                name: Some("Qwen3 Coder 30B".to_string()),
                provider_name: Some("Local".to_string()),
            },
        };

        app.update(AppEvent::Rpc(RpcEvent::ModelsLoaded(Ok(list))));
        assert_eq!(app.model_label(), "local/qwen3-coder:30b");
        // Default thinkingLevel is "medium", clamped to the default model's only supported level ("off").
        assert_eq!(app.thinking_label().as_deref(), Some("off"));

        // `/thinking` for the non-reasoning default model offers only `["off"]`.
        app.update(AppEvent::Paste("/thinking".to_string()));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Enter)));
        let Some(Popup::Thinking(menu)) = &app.popup else {
            panic!("expected Thinking popup");
        };
        let ids: Vec<&str> = menu.entries().iter().map(|e| e.id.as_ref()).collect();
        assert_eq!(ids, vec!["off"]);
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Esc)));

        // Switch to `anthropic/claude-sonnet-4-5` via `/model`.
        app.thinking = Some("max".to_string());
        app.update(AppEvent::Paste("/model".to_string()));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Enter)));
        let Some(Popup::Models { menu, .. }) = &app.popup else {
            panic!("expected Models popup");
        };
        // Default `local/qwen3-coder:30b` is in `providers`, so it is marked `default` without
        // `(no credentials)` and the cursor starts on it.
        assert_eq!(menu.entries().len(), 2);
        assert_eq!(
            menu.entries()[1].detail.as_ref(),
            "Local · Qwen3 Coder 30B · default"
        );
        assert_eq!(menu.cursor(), 1);

        // Move up to `anthropic/claude-sonnet-4-5` and choose it.
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Up)));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Enter)));
        assert_eq!(
            app.model,
            Some(("anthropic".to_string(), "claude-sonnet-4-5".to_string()))
        );
        // `app.thinking` ("max") is clamped to the highest level `claude-sonnet-4-5` supports ("high").
        assert_eq!(app.thinking.as_deref(), Some("high"));

        // `/thinking` now offers only `claude-sonnet-4-5`'s supported levels, with cursor on "high".
        app.update(AppEvent::Paste("/thinking".to_string()));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Enter)));
        let Some(Popup::Thinking(menu)) = &app.popup else {
            panic!("expected Thinking popup");
        };
        let ids: Vec<&str> = menu.entries().iter().map(|e| e.id.as_ref()).collect();
        assert_eq!(ids, vec!["off", "low", "medium", "high"]);
        assert_eq!(menu.selected().map(|e| e.id.as_ref()), Some("high"));
    }

    #[test]
    fn records_server_info_and_surfaces_mismatch_notice() {
        let mut app = App::default();
        assert!(app.server_info.is_none());
        assert!(app.notice.is_none());

        app.update(AppEvent::Rpc(RpcEvent::ServerInfoLoaded(Ok(ServerInfo {
            pid: 4242,
            version: "0.3.0".to_string(),
        }))));
        assert_eq!(
            app.server_info,
            Some(ServerInfo {
                pid: 4242,
                version: "0.3.0".to_string(),
            })
        );
        assert!(app.notice.is_none());

        let mismatch = "Server at ws://127.0.0.1:7533/rpc/v1 runs version 0.2.0, expected 0.3.0 from service.json".to_string();
        app.update(AppEvent::Rpc(RpcEvent::ServerInfoLoaded(Err(
            mismatch.clone()
        ))));
        assert_eq!(app.notice.as_deref(), Some(mismatch.as_str()));
    }

    #[test]
    fn submits_steer_and_follow_up_prompts_while_busy_and_promotes_them_into_turns() {
        let mut app = App::default();
        app.session = Some(SessionInfo {
            id: "ses_live".to_string(),
            title: "Live".to_string(),
            directory: "/workspace".to_string(),
            host_dir: None,
            sandbox: None,
            project: None,
            updated_at: 1_000,
            model: None,
            thinking_level: None,
        });

        // 1. Submit initial prompt while idle.
        app.update(AppEvent::Paste("Build the feature".to_string()));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Enter)));
        assert!(app.busy);
        assert_eq!(app.turns.len(), 1);
        assert_eq!(app.turns[0].prompt, "Build the feature");
        assert!(app.queued_prompts.is_empty());

        let initial_id = app.turns[0].prompt_id.clone().expect("initial prompt_id");
        // Admitting & promoting the initial prompt does not duplicate it into queued_prompts or turns.
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::PromptAdmitted {
                message_id: initial_id.clone(),
                prompt: "Build the feature".to_string(),
                delivery: PromptDelivery::FollowUp,
            },
        )));
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::PromptPromoted {
                message_id: initial_id,
                prompt: "Build the feature".to_string(),
                delivery: PromptDelivery::FollowUp,
            },
        )));
        assert!(app.queued_prompts.is_empty());
        assert_eq!(app.turns.len(), 1);

        // 2. While busy, plain Enter submits a `steer` prompt.
        app.update(AppEvent::Paste("Keep the public API unchanged".to_string()));
        app.update(AppEvent::Key(KeyEvent::from(KeyCode::Enter)));
        assert_eq!(app.prompt.text(), "");
        assert_eq!(app.queued_prompts.len(), 1);
        assert_eq!(
            app.queued_prompts[0].prompt,
            "Keep the public API unchanged"
        );
        assert_eq!(app.queued_prompts[0].delivery, PromptDelivery::Steer);
        assert!(!app.queued_prompts[0].admitted);
        assert_eq!(app.notice.as_deref(), Some("steering current turn..."));
        let steer_id = app.queued_prompts[0].message_id.clone();

        // 3. While busy, Alt+Enter submits a `followUp` prompt.
        app.update(AppEvent::Paste("Run cargo test afterwards".to_string()));
        app.update(AppEvent::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::ALT,
        )));
        assert_eq!(app.queued_prompts.len(), 2);
        assert_eq!(app.queued_prompts[1].prompt, "Run cargo test afterwards");
        assert_eq!(app.queued_prompts[1].delivery, PromptDelivery::FollowUp);
        assert_eq!(app.notice.as_deref(), Some("queued follow-up prompt"));
        let follow_id = app.queued_prompts[1].message_id.clone();

        // 4. `session.prompt.admitted` marks the steer as admitted.
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::PromptAdmitted {
                message_id: steer_id.clone(),
                prompt: "Keep the public API unchanged".to_string(),
                delivery: PromptDelivery::Steer,
            },
        )));
        assert!(app.queued_prompts[0].admitted);

        // 5. `session.prompt.promoted` removes the steer from `queued_prompts` and promotes it
        //    into `app.turns`, settling the previous running step.
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::PromptPromoted {
                message_id: steer_id,
                prompt: "Keep the public API unchanged".to_string(),
                delivery: PromptDelivery::Steer,
            },
        )));
        assert_eq!(app.queued_prompts.len(), 1);
        assert_eq!(app.queued_prompts[0].message_id, follow_id);
        assert_eq!(app.turns.len(), 2);
        assert_eq!(app.turns[0].state, TurnState::Succeeded);
        assert_eq!(app.turns[1].prompt, "Keep the public API unchanged");
        assert_eq!(app.turns[1].state, TurnState::Running);

        // 6. Promoting the follow-up moves it from `queued_prompts` into `app.turns`.
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::PromptPromoted {
                message_id: follow_id,
                prompt: "Run cargo test afterwards".to_string(),
                delivery: PromptDelivery::FollowUp,
            },
        )));
        assert!(app.queued_prompts.is_empty());
        assert_eq!(app.turns.len(), 3);
        assert_eq!(app.turns[1].state, TurnState::Succeeded);
        assert_eq!(app.turns[2].prompt, "Run cargo test afterwards");
        assert_eq!(app.turns[2].state, TurnState::Running);
    }

    #[test]
    fn handles_retries_tool_progress_config_changes_fork_and_part_correlation() {
        let mut app = App::default();
        app.session = Some(SessionInfo {
            id: "ses_1".to_string(),
            title: "Session 1".to_string(),
            directory: "/workspace".to_string(),
            host_dir: None,
            sandbox: None,
            project: None,
            updated_at: 1_000,
            model: None,
            thinking_level: None,
        });
        app.busy = true;
        app.turns.push(Turn::with_id("msg_u1", "Check and test"));

        // 1. First LLM attempt streams partial thinking + text, then fails and schedules a retry.
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::TurnStarted)));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::LlmStarted {
            message_id: "assistant_1".to_string(),
            model: Some("openai/gpt-5.6-luna".to_string()),
        })));
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::ThinkingStart {
                message_id: "assistant_1".to_string(),
                part_index: 0,
            },
        )));
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::ThinkingDelta {
                message_id: Some("assistant_1".to_string()),
                part_index: Some(0),
                delta: "aborted thought".to_string(),
            },
        )));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::TextStart {
            message_id: "assistant_1".to_string(),
            part_index: 1,
        })));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::TextDelta {
            message_id: Some("assistant_1".to_string()),
            part_index: Some(1),
            delta: "broken partial output".to_string(),
        })));
        assert_eq!(app.turns[0].thinking, "aborted thought");
        assert_eq!(app.turns[0].text, "broken partial output");

        // `session.llm.failed` discards the failed draft's parts.
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::LlmFailed {
            message_id: "assistant_1".to_string(),
            reason: "error".to_string(),
            error: Some("503 Service Unavailable".to_string()),
        })));
        assert_eq!(app.turns[0].thinking, "");
        assert_eq!(app.turns[0].text, "");

        // `session.retry.scheduled` records the backoff status on the turn.
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::RetryScheduled {
                attempt: 1,
                max_retries: 3,
                delay_ms: 2_000,
                message: "openai/gpt-5.6-luna: Unavailable".to_string(),
            },
        )));
        assert_eq!(
            app.turns[0].retry,
            Some(RetryStatus {
                attempt: 1,
                max_retries: 3,
                delay_ms: 2_000,
                message: "openai/gpt-5.6-luna: Unavailable".to_string(),
            })
        );

        // 2. Second LLM attempt succeeds with multi-part correlation (`partIndex` 0 thinking,
        //    `partIndex` 1 & 2 text) and `TextEnd` replaces rather than duplicates deltas.
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::LlmStarted {
            message_id: "assistant_2".to_string(),
            model: Some("openai/gpt-5.6-luna".to_string()),
        })));
        assert!(app.turns[0].retry.is_none());

        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::ThinkingDelta {
                message_id: Some("assistant_2".to_string()),
                part_index: Some(0),
                delta: "First thought".to_string(),
            },
        )));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::ThinkingEnd {
            message_id: "assistant_2".to_string(),
            part_index: 0,
            content: "First thought, refined.".to_string(),
        })));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::TextDelta {
            message_id: Some("assistant_2".to_string()),
            part_index: Some(1),
            delta: "Hello ".to_string(),
        })));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::TextDelta {
            message_id: Some("assistant_2".to_string()),
            part_index: Some(1),
            delta: "world!".to_string(),
        })));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::TextEnd {
            message_id: "assistant_2".to_string(),
            part_index: 1,
            content: "Hello world!".to_string(),
        })));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::TextEnd {
            message_id: "assistant_2".to_string(),
            part_index: 2,
            content: "Second paragraph.".to_string(),
        })));
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::RetryFinished {
                attempt: 1,
                success: true,
                message: None,
            },
        )));

        assert_eq!(app.turns[0].thinking, "First thought, refined.");
        assert_eq!(app.turns[0].text, "Hello world!\n\nSecond paragraph.");

        // 3. Tool starts and streams live `session.tool.progress` before settling.
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::ToolStarted {
            call_id: "call_1".to_string(),
            name: "bash".to_string(),
            label: Some("bash".to_string()),
            arguments: json!({ "command": "cargo test" }),
        })));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::ToolProgress {
            call_id: "call_1".to_string(),
            output: Some("running 5 tests\ntest a ... ok\ntest b ... ok".to_string()),
            details: None,
        })));
        assert_eq!(app.turns[0].tools[0].status, ToolStatus::Running);
        assert_eq!(app.turns[0].tools[0].summary.as_deref(), Some("3 lines"));
        assert_eq!(
            app.turns[0].tools[0].output.as_deref(),
            Some("running 5 tests\ntest a ... ok\ntest b ... ok")
        );

        // 4. `session.config.changed` merges model and thinking level independently.
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::ConfigChanged {
                model: Some(ModelRef {
                    provider: "anthropic".to_string(),
                    id: "claude-sonnet-4-5".to_string(),
                }),
                thinking_level: None,
            },
        )));
        assert_eq!(
            app.model,
            Some(("anthropic".to_string(), "claude-sonnet-4-5".to_string()))
        );
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::ConfigChanged {
                model: None,
                thinking_level: Some("high".to_string()),
            },
        )));
        assert_eq!(
            app.model,
            Some(("anthropic".to_string(), "claude-sonnet-4-5".to_string()))
        );
        assert_eq!(app.thinking.as_deref(), Some("high"));

        // 5. `session.next.forked` surfaces a fork notification.
        app.update(AppEvent::Rpc(RpcEvent::Stream(
            StreamEvent::SessionForked {
                session_id: "ses_2".to_string(),
                source_session_id: "ses_1".to_string(),
                source_entry_id: "entry_4".to_string(),
                base_seq: 9,
            },
        )));
        assert_eq!(
            app.notice.as_deref(),
            Some("forked session ses_2 from entry_4")
        );
        assert!(app.turns[0]
            .notices
            .contains(&"forked session ses_2 from entry_4".to_string()));
    }

    #[test]
    fn tracks_log_cursor_and_merges_history_snapshots_with_live_drafts() {
        let mut app = App::default();
        app.session = Some(SessionInfo {
            id: "ses_sync".to_string(),
            title: "Sync".to_string(),
            directory: "/workspace".to_string(),
            host_dir: None,
            sandbox: None,
            project: None,
            updated_at: 1_000,
            model: None,
            thinking_level: None,
        });
        app.busy = true;

        // Turn 1 is actively streaming live deltas in memory; a queued prompt is waiting.
        let mut live_turn = Turn::with_id("u1", "Explain the bug");
        live_turn.append_thinking_delta(Some("a1"), Some(0), "Inspecting client.rs...");
        live_turn.append_text_delta(Some("a1"), Some(1), "The socket drops before ");
        app.turns.push(live_turn);
        app.queued_prompts.push(QueuedPrompt {
            message_id: "u2".to_string(),
            prompt: "Also add a test".to_string(),
            delivery: PromptDelivery::FollowUp,
            admitted: true,
            dispatched: true,
        });

        // 1. Mid-turn history snapshot arrives while `a1` is still `state: "draft"` (empty in DB):
        //    live draft deltas are preserved and `log_cursor` advances to 2.
        app.update(history_event(
            &app,
            vec![
                HistoryEntry {
                    id: "u1".to_string(),
                    seq: 1,
                    role: "user".to_string(),
                    state: "committed".to_string(),
                    created_at: 1_000,
                    parts: vec![Part::Text {
                        text: "Explain the bug".to_string(),
                    }],
                },
                HistoryEntry {
                    id: "a1".to_string(),
                    seq: 2,
                    role: "assistant".to_string(),
                    state: "draft".to_string(),
                    created_at: 1_050,
                    parts: vec![],
                },
            ],
        ));
        assert_eq!(app.log_cursor, Some(2));
        assert!(app.busy);
        assert_eq!(app.turns.len(), 1);
        assert_eq!(app.turns[0].thinking, "Inspecting client.rs...");
        assert_eq!(app.turns[0].text, "The socket drops before ");
        assert_eq!(app.queued_prompts.len(), 1);

        // 2. `LogSynced` with `seq: 5` advances `log_cursor` to `max(2, 5) = 5`; a smaller seq
        //    never moves it backwards.
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::LogSynced {
            seq: Some(5),
        })));
        assert_eq!(app.log_cursor, Some(5));
        app.update(AppEvent::Rpc(RpcEvent::Stream(StreamEvent::LogSynced {
            seq: Some(3),
        })));
        assert_eq!(app.log_cursor, Some(5));

        // 3. Reconnect history snapshot arrives after both turns settled during a disconnect:
        //    `u2` is removed from `queued_prompts`, both turns are `Succeeded`, and `busy` is false.
        app.update(history_event(
            &app,
            vec![
                HistoryEntry {
                    id: "u1".to_string(),
                    seq: 1,
                    role: "user".to_string(),
                    state: "committed".to_string(),
                    created_at: 1_000,
                    parts: vec![Part::Text {
                        text: "Explain the bug".to_string(),
                    }],
                },
                HistoryEntry {
                    id: "a1".to_string(),
                    seq: 2,
                    role: "assistant".to_string(),
                    state: "committed".to_string(),
                    created_at: 1_100,
                    parts: vec![Part::Text {
                        text: "The socket drops before reconciliation.".to_string(),
                    }],
                },
                HistoryEntry {
                    id: "u2".to_string(),
                    seq: 6,
                    role: "user".to_string(),
                    state: "committed".to_string(),
                    created_at: 1_200,
                    parts: vec![Part::Text {
                        text: "Also add a test".to_string(),
                    }],
                },
                HistoryEntry {
                    id: "a2".to_string(),
                    seq: 7,
                    role: "assistant".to_string(),
                    state: "committed".to_string(),
                    created_at: 1_300,
                    parts: vec![Part::Text {
                        text: "Added reconnect tests.".to_string(),
                    }],
                },
            ],
        ));
        assert_eq!(app.log_cursor, Some(7));
        assert!(!app.busy);
        assert!(app.queued_prompts.is_empty());
        assert_eq!(app.turns.len(), 2);
        assert_eq!(app.turns[0].state, TurnState::Succeeded);
        assert_eq!(app.turns[0].text, "The socket drops before reconciliation.");
        assert_eq!(app.turns[1].prompt, "Also add a test");
        assert_eq!(app.turns[1].state, TurnState::Succeeded);
        assert_eq!(app.turns[1].text, "Added reconnect tests.");
    }
}
