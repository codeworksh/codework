//! The thread projection and keyboard interactions. Network tasks return scoped events;
//! only this module mutates conversation state.
use crate::action::{Action, Keymap, Resolution};
use crate::draft::DraftStore;
use crate::event::{AppEvent, RpcEvent};
use crate::menu::{Entry, Menu, Preview};
use crate::prompt::Prompt;
use crate::rpc::protocol::{ForkMode, ForkResponse, ThreadRefPayload};
use crate::rpc::{RpcClient, StreamEvent};
use crate::theme::{self, Palette};
use crate::tool::{ToolCall, ToolStatus};
use crate::types::{
    DeltaKind, HistoryEntry, InboxState, LiveDelta, ModelList, Part, PromptDelivery, ServerInfo,
    ThreadInfo, ThreadItem, ToolResultContent,
};
use base64::Engine;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::Color;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

const COMMANDS: &[Entry] = &[
    Entry::item("model", "pick a model"),
    Entry::item("thinking", "set thinking effort"),
    Entry::item("session", "switch threads"),
    Entry::item("new", "start a session"),
    Entry::item("queue", "manage queued prompts"),
    Entry::item("fork", "pick a committed message; b to re-edit"),
    Entry::item("copy", "copy last assistant answer"),
    Entry::item("reload", "reload plugins"),
    Entry::item("theme", "pick a palette"),
    Entry::item("exit", "close the app"),
];
const THINKING_LEVELS: &[(&str, &str)] = &[
    ("off", "Off"),
    ("minimal", "Minimal"),
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra High"),
    ("max", "Max"),
];

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
pub struct RetryStatus {
    pub attempt: u64,
    pub max_retries: u64,
    pub delay_ms: u64,
    pub message: String,
}
#[derive(Debug, Clone)]
pub struct QueuedPrompt {
    pub message_id: String,
    pub prompt: String,
    pub delivery: PromptDelivery,
    pub admitted: bool,
}
#[derive(Debug, Clone)]
pub struct Turn {
    pub prompt_id: Option<String>,
    pub prompt: String,
    pub thinking: String,
    pub notes: String,
    pub text: String,
    pub tools: Vec<ToolCall>,
    pub notices: Vec<String>,
    pub retry: Option<RetryStatus>,
    pub state: TurnState,
    pub created_at: u64,
    pub updated_at: u64,
    pub work_open: Option<bool>,
    pub answer_present: bool,
    pub last_draft: bool,
}
impl Turn {
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt_id: None,
            prompt: prompt.into(),
            thinking: String::new(),
            notes: String::new(),
            text: String::new(),
            tools: Vec::new(),
            notices: Vec::new(),
            retry: None,
            state: TurnState::Running,
            created_at: 0,
            updated_at: 0,
            work_open: None,
            answer_present: false,
            last_draft: false,
        }
    }
    pub fn with_id(id: impl Into<String>, prompt: impl Into<String>) -> Self {
        let mut turn = Self::new(prompt);
        turn.prompt_id = Some(id.into());
        turn
    }
    pub fn working(&self) -> bool {
        self.state == TurnState::Running
            && (!self.last_draft
                || !self.answer_present
                || self.tools.iter().any(|t| t.status == ToolStatus::Running))
    }
    pub fn work_expanded(&self) -> bool {
        self.work_open.unwrap_or_else(|| self.working())
    }
    pub fn duration(&self) -> String {
        format_elapsed(self.updated_at.saturating_sub(self.created_at))
    }
    pub fn has_work(&self) -> bool {
        !self.thinking.is_empty() || !self.notes.is_empty() || !self.tools.is_empty()
    }
}

pub fn format_elapsed(ms: u64) -> String {
    let seconds = ((ms.saturating_add(500)) / 1000).max(1);
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        if seconds.is_multiple_of(60) {
            format!("{}m", seconds / 60)
        } else {
            format!("{}m {}s", seconds / 60, seconds % 60)
        }
    } else {
        format!("{}h {}m", seconds / 3600, (seconds / 60) % 60)
    }
}
pub fn osc52(text: &str) -> String {
    format!(
        "\x1b]52;c;{}\x07",
        base64::engine::general_purpose::STANDARD.encode(text)
    )
}

pub enum Popup {
    Commands(Menu),
    Models {
        search: Prompt,
        menu: Menu,
    },
    Thinking(Menu),
    Sessions {
        search: Prompt,
        menu: Menu,
        sessions: Vec<ThreadInfo>,
    },
    Themes {
        search: Prompt,
        menu: Menu,
        initial: &'static Palette,
    },
    Fork(Menu),
}
impl Popup {
    pub fn menu(&self) -> &Menu {
        match self {
            Self::Commands(menu)
            | Self::Thinking(menu)
            | Self::Fork(menu)
            | Self::Models { menu, .. }
            | Self::Sessions { menu, .. }
            | Self::Themes { menu, .. } => menu,
        }
    }
    fn menu_mut(&mut self) -> &mut Menu {
        match self {
            Self::Commands(menu)
            | Self::Thinking(menu)
            | Self::Fork(menu)
            | Self::Models { menu, .. }
            | Self::Sessions { menu, .. }
            | Self::Themes { menu, .. } => menu,
        }
    }
    pub fn search(&self) -> Option<&Prompt> {
        match self {
            Self::Models { search, .. }
            | Self::Sessions { search, .. }
            | Self::Themes { search, .. } => Some(search),
            _ => None,
        }
    }
    pub fn title(&self) -> &'static str {
        match self {
            Self::Commands(_) => "commands",
            Self::Models { .. } => "models",
            Self::Thinking(_) => "thinking",
            Self::Sessions { .. } => "threads",
            Self::Themes { .. } => "themes",
            Self::Fork(_) => "fork · enter at · b before user · esc close",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum OperationResult {
    Cancel {
        id: String,
        restore: Option<String>,
        cancelled: bool,
    },
    Update {
        id: String,
        delivery: Option<PromptDelivery>,
        text: Option<String>,
        updated: bool,
    },
    QueueFailed {
        id: String,
        error: String,
    },
    PageFailed(String),
    Fork(ForkResponse),
    Page {
        before: u64,
        entries: Vec<HistoryEntry>,
    },
    Info(ThreadInfo),
    Sent {
        id: String,
    },
    SendFailed {
        id: String,
        error: String,
    },
    Notice(String),
}

pub struct QueueEdit {
    pub id: String,
    pub text: Prompt,
}
struct Remembered {
    prompt: Prompt,
    scroll: usize,
    work: BTreeMap<String, bool>,
}
pub struct App {
    pub screen: Screen,
    pub theme: &'static Palette,
    pub prompt: Prompt,
    pub popup: Option<Popup>,
    pub notice: Option<String>,
    pub server_info: Option<ServerInfo>,
    pub session: Option<ThreadInfo>,
    pub models: Option<ModelList>,
    pub model: Option<(String, String)>,
    pub thinking: Option<String>,
    pub turns: Vec<Turn>,
    pub queued_prompts: Vec<QueuedPrompt>,
    pub busy: bool,
    pub reconnecting: bool,
    pub entries: Vec<HistoryEntry>,
    pub floor: Option<u64>,
    pub scroll: usize,
    pub max_scroll: Cell<usize>,
    pub should_quit: bool,
    pub queue_focus: Option<String>,
    pub queue_edit: Option<QueueEdit>,
    pub focused_turn: Option<usize>,
    pub queue_pending: BTreeSet<String>,
    drafts: DraftStore,
    remembered: BTreeMap<String, Remembered>,
    work_restore: BTreeMap<String, bool>,
    draft_revision: u64,
    draft_timer: Option<tokio::task::AbortHandle>,
    browser_generation: u64,
    browser_stream: Option<tokio::task::AbortHandle>,
    info_revision: u64,
    paging: bool,
    creating: bool,
    generation: u64,
    next_prompt_seq: u64,
    early: BTreeMap<String, Vec<Part>>,
    revisions: BTreeMap<String, u64>,
    prompt_stream: Option<tokio::task::AbortHandle>,
    keymap: Keymap,
    client: Arc<RpcClient>,
    tx: mpsc::UnboundedSender<AppEvent>,
}
impl Default for App {
    fn default() -> Self {
        let (tx, _) = mpsc::unbounded_channel();
        Self::with_client(tx, RpcClient::default())
    }
}
impl Drop for App {
    fn drop(&mut self) {
        self.stop_stream();
        self.stop_browser();
        if let Some(timer) = self.draft_timer.take() {
            timer.abort();
        }
        let _ = self.drafts.save(&self.draft_key(), &self.prompt);
    }
}
impl App {
    pub fn with_client(tx: mpsc::UnboundedSender<AppEvent>, client: RpcClient) -> Self {
        Self::with_storage(tx, client, DraftStore::default())
    }
    pub fn with_storage(
        tx: mpsc::UnboundedSender<AppEvent>,
        client: RpcClient,
        drafts: DraftStore,
    ) -> Self {
        let mut app = Self {
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
            turns: Vec::new(),
            queued_prompts: Vec::new(),
            busy: false,
            reconnecting: false,
            entries: Vec::new(),
            floor: None,
            scroll: 0,
            max_scroll: Cell::new(0),
            should_quit: false,
            queue_focus: None,
            queue_edit: None,
            focused_turn: None,
            queue_pending: BTreeSet::new(),
            drafts,
            remembered: BTreeMap::new(),
            work_restore: BTreeMap::new(),
            draft_revision: 0,
            draft_timer: None,
            browser_generation: 0,
            browser_stream: None,
            info_revision: 0,
            paging: false,
            creating: false,
            generation: 0,
            next_prompt_seq: 1,
            early: BTreeMap::new(),
            revisions: BTreeMap::new(),
            prompt_stream: None,
            keymap: Keymap::new(),
            client: Arc::new(client),
            tx,
        };
        app.restore_draft();
        app
    }
    pub fn new(tx: mpsc::UnboundedSender<AppEvent>) -> Self {
        let client = RpcClient::default();
        let drafts = crate::rpc::client::codework_home_dir()
            .map(|home| DraftStore::at(&home, client.url()))
            .unwrap_or_default();
        let app = Self::with_storage(tx, client, drafts);
        let tx = app.tx.clone();
        let client = app.client.clone();
        tokio::spawn(async move {
            let _ = tx.send(AppEvent::rpc(RpcEvent::ServerInfoLoaded(
                client.verify_server().await,
            )));
        });
        app.spawn_list_models();
        app
    }
    pub fn background(&self) -> Color {
        if self.screen == Screen::Welcome {
            self.theme.field_bg
        } else {
            self.theme.bg
        }
    }
    fn address(&self) -> Option<ThreadRefPayload> {
        self.session.as_ref().map(|t| ThreadRefPayload {
            session_id: t.session.id.clone(),
            thread_id: t.id.clone(),
        })
    }
    pub fn active_model(&self) -> Option<(&str, &str)> {
        self.model
            .as_ref()
            .map(|(p, m)| (p.as_str(), m.as_str()))
            .or_else(|| {
                self.models
                    .as_ref()?
                    .default
                    .as_ref()
                    .map(|m| (m.provider.as_str(), m.id.as_str()))
            })
    }
    pub fn model_label(&self) -> String {
        self.active_model()
            .map(|(p, m)| format!("{p}/{m}"))
            .unwrap_or_else(|| "default model".into())
    }
    pub fn active_thinking_levels(&self) -> Option<&[String]> {
        let (provider, id) = self.active_model()?;
        let model = self
            .models
            .as_ref()?
            .providers
            .iter()
            .find(|p| p.id == provider)?
            .models
            .iter()
            .find(|m| m.id == id)?;
        (!model.thinking_levels.is_empty()).then_some(model.thinking_levels.as_slice())
    }
    pub fn thinking_label(&self) -> Option<String> {
        let level = self.thinking.as_deref().or_else(|| {
            self.models
                .as_ref()?
                .default
                .as_ref()
                .map(|d| d.thinking_level.as_str())
        })?;
        Some(match self.active_thinking_levels() {
            Some(supported) => clamp_thinking_level(level, supported),
            None => level.to_string(),
        })
    }
    fn thinking_entries(&self) -> Vec<Entry> {
        match self.active_thinking_levels() {
            Some(levels) => levels
                .iter()
                .map(|l| Entry::owned(l.clone(), l.clone(), thinking_level_name(l)))
                .collect(),
            None => THINKING_LEVELS
                .iter()
                .map(|&(l, name)| Entry::item(l, name))
                .collect(),
        }
    }
    fn spawn_list_models(&self) {
        let tx = self.tx.clone();
        let client = self.client.clone();
        let host = self
            .session
            .as_ref()
            .and_then(|t| t.session.host_dir.clone())
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string())
            });
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = tx.send(AppEvent::rpc(RpcEvent::ModelsLoaded(
                    client.list_models(host.as_deref()).await,
                )));
            });
        }
    }
    fn stop_stream(&mut self) {
        if let Some(task) = self.prompt_stream.take() {
            task.abort();
        }
    }
    fn follow(&mut self) {
        self.stop_stream();
        let Some(address) = self.address() else {
            return;
        };
        let tx = self.tx.clone();
        let client = self.client.clone();
        let generation = self.generation;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            self.prompt_stream = Some(
                handle
                    .spawn(async move {
                        client.follow_thread(address, tx, generation).await;
                    })
                    .abort_handle(),
            );
        }
    }
    fn apply_info(&mut self, info: ThreadInfo) {
        self.busy = info.run_state.is_busy();
        self.model = info
            .model
            .as_ref()
            .map(|m| (m.provider.clone(), m.id.clone()));
        self.thinking = info.thinking_level.clone();
        self.session = Some(info);
        self.rebuild();
    }
    pub fn switch_thread(&mut self, info: ThreadInfo) {
        self.remember();
        self.stop_browser();
        self.popup = None;
        self.stop_stream();
        self.generation += 1;
        self.entries.clear();
        self.turns.clear();
        self.queued_prompts.clear();
        self.early.clear();
        self.revisions.clear();
        self.floor = None;
        self.info_revision = 0;
        self.scroll = 0;
        self.max_scroll.set(0);
        self.paging = false;
        self.queue_focus = None;
        self.queue_edit = None;
        self.queue_pending.clear();
        self.focused_turn = None;
        self.screen = Screen::Session;
        self.reconnecting = false;
        self.apply_info(info);
        self.restore_draft();
        self.follow();
        self.spawn_list_models();
    }
    fn spawn_operation<F, Fut>(&self, operation: F)
    where
        F: FnOnce(Arc<RpcClient>, ThreadRefPayload) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<OperationResult, String>> + Send + 'static,
    {
        let Some(address) = self.address() else {
            return;
        };
        let client = self.client.clone();
        let tx = self.tx.clone();
        let generation = self.generation;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let result = operation(client, address.clone()).await;
                let _ = tx.send(AppEvent::rpc(RpcEvent::Operation {
                    address,
                    generation,
                    result,
                }));
            });
        }
    }

    pub fn update(&mut self, event: AppEvent) -> bool {
        let before = self.prompt.clone();
        let redraw = match event {
            AppEvent::Key(key) => self.handle_key(key),
            AppEvent::Scroll(delta) => {
                if self.popup.is_some() {
                    self.step_menu(if delta > 0 { -1 } else { 1 })
                } else {
                    self.scroll_by(delta)
                }
            }
            AppEvent::Paste(text) => self.paste(&text),
            AppEvent::Resize => true,
            AppEvent::SaveDraft { revision } => {
                if revision == self.draft_revision {
                    self.save_draft();
                    return self.notice.is_some();
                }
                false
            }
            AppEvent::Rpc(event) => self.handle_rpc(*event),
        };
        if self.prompt != before {
            self.schedule_draft();
        }
        redraw
    }
    fn draft_key(&self) -> String {
        self.address()
            .map(|a| format!("{}/{}", a.session_id, a.thread_id))
            .unwrap_or_else(|| {
                format!(
                    "new:{}",
                    std::env::current_dir().unwrap_or_default().display()
                )
            })
    }
    fn save_draft(&mut self) {
        if let Err(error) = self.drafts.save(&self.draft_key(), &self.prompt) {
            self.notice = Some(error);
        }
    }
    fn schedule_draft(&mut self) {
        self.draft_revision += 1;
        if let Some(timer) = self.draft_timer.take() {
            timer.abort();
        }
        let revision = self.draft_revision;
        let tx = self.tx.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            self.draft_timer = Some(
                handle
                    .spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                        let _ = tx.send(AppEvent::SaveDraft { revision });
                    })
                    .abort_handle(),
            );
        }
    }
    fn remember(&mut self) {
        self.save_draft();
        let work = self
            .turns
            .iter()
            .filter_map(|turn| Some((turn.prompt_id.clone()?, turn.work_open?)))
            .collect();
        self.remembered.insert(
            self.draft_key(),
            Remembered {
                prompt: self.prompt.clone(),
                scroll: self.scroll,
                work,
            },
        );
    }
    fn restore_draft(&mut self) {
        self.prompt = Prompt::default();
        self.scroll = 0;
        self.work_restore.clear();
        let key = self.draft_key();
        if let Some(saved) = self.remembered.remove(&key) {
            self.prompt = saved.prompt;
            self.scroll = saved.scroll;
            self.work_restore = saved.work;
        } else {
            match self.drafts.load(&key) {
                Ok(Some(prompt)) => self.prompt = prompt,
                Ok(None) => {}
                Err(error) => self.notice = Some(error),
            }
        }
        self.draft_revision += 1;
    }
    fn stop_browser(&mut self) {
        self.browser_generation += 1;
        if let Some(task) = self.browser_stream.take() {
            task.abort();
        }
    }
    fn open_browser(&mut self) {
        self.stop_browser();
        let generation = self.browser_generation;
        self.popup = Some(Popup::Sessions {
            search: Prompt::default(),
            menu: Menu::new(Vec::new()),
            sessions: Vec::new(),
        });
        self.notice = None;
        let tx = self.tx.clone();
        let client = self.client.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            self.browser_stream = Some(
                handle
                    .spawn(async move {
                        client.watch_threads(tx, generation).await;
                    })
                    .abort_handle(),
            );
        }
    }
    fn scroll_by(&mut self, delta: isize) -> bool {
        let cap = self.max_scroll.get();
        let current = self.scroll.min(cap);
        self.scroll = if delta >= 0 {
            current.saturating_add(delta as usize).min(cap)
        } else {
            current.saturating_sub(delta.unsigned_abs())
        };
        if delta > 0 && self.scroll == cap && self.floor.is_some_and(|f| f > 1) && !self.paging {
            if let Some(before) = self.entries.first().map(|e| e.seq) {
                self.paging = true;
                self.spawn_operation(move |client, address| async move {
                    Ok(match client.page_thread(address, before, 60).await {
                        Ok(entries) => OperationResult::Page { before, entries },
                        Err(error) => OperationResult::PageFailed(error),
                    })
                });
            }
        }
        true
    }
    fn paste(&mut self, text: &str) -> bool {
        if let Some(edit) = &mut self.queue_edit {
            return edit.text.insert_text(text);
        }
        match &mut self.popup {
            Some(
                Popup::Models { search, .. }
                | Popup::Sessions { search, .. }
                | Popup::Themes { search, .. },
            ) => {
                search.insert_inline(text);
                self.filter_popup();
            }
            Some(Popup::Thinking(_) | Popup::Fork(_)) => return false,
            _ => {
                self.prompt.insert_text(text);
                self.sync_commands();
            }
        }
        true
    }
    fn handle_key(&mut self, key: KeyEvent) -> bool {
        match self.keymap.resolve(key) {
            Resolution::Action(Action::Exit) => {
                self.should_quit = true;
                return true;
            }
            Resolution::Consumed => return false,
            Resolution::Unbound => {}
        }
        if key.code == KeyCode::Char('p') && key.modifiers == KeyModifiers::CONTROL {
            self.open_browser();
            return true;
        }
        let newline = (key.code == KeyCode::Enter && key.modifiers == KeyModifiers::SHIFT)
            || (key.code == KeyCode::Char('j') && key.modifiers == KeyModifiers::CONTROL);
        if newline && self.popup.is_none() {
            if let Some(edit) = &mut self.queue_edit {
                edit.text.insert_text("\n");
            } else {
                self.prompt.insert_text("\n");
            }
            return true;
        }
        if self.queue_edit.is_some() {
            if key.code == KeyCode::Esc {
                self.queue_edit = None;
                return true;
            }
            if key.code == KeyCode::Enter {
                let edit = self.queue_edit.take().unwrap();
                let text = edit.text.text().trim().to_string();
                if !text.is_empty() {
                    self.queue_update(edit.id, None, Some(text));
                }
                return true;
            }
            return self.queue_edit.as_mut().unwrap().text.edit(key);
        }
        if key.code == KeyCode::Esc {
            if let Some(popup) = self.popup.take() {
                if matches!(popup, Popup::Sessions { .. }) {
                    self.stop_browser();
                }
                match popup {
                    Popup::Themes { initial, .. } => self.theme = initial,
                    Popup::Commands(_) => self.prompt.clear(),
                    _ => {}
                }
                return true;
            }
            if self.queue_focus.take().is_some() || self.focused_turn.take().is_some() {
                return true;
            }
            if self.busy {
                self.spawn_operation(|client, address| async move {
                    client.interrupt_thread(address).await?;
                    Ok(OperationResult::Notice("interrupt requested".into()))
                });
            } else if !self.prompt.text().is_empty() {
                self.prompt.clear();
            } else {
                self.should_quit = true;
            }
            return true;
        }
        if self.popup.is_some() {
            if key.code == KeyCode::Char('b') && matches!(self.popup, Some(Popup::Fork(_))) {
                return self.fork_selected(ForkMode::Before);
            }
            match key.code {
                KeyCode::Up => return self.step_menu(-1),
                KeyCode::Down => return self.step_menu(1),
                KeyCode::Enter => return self.choose(),
                _ => {}
            }
            match &mut self.popup {
                Some(
                    Popup::Models { search, .. }
                    | Popup::Sessions { search, .. }
                    | Popup::Themes { search, .. },
                ) => {
                    search.edit(key);
                    self.filter_popup();
                    return true;
                }
                Some(Popup::Thinking(_) | Popup::Fork(_)) => return false,
                _ => {}
            }
        }
        if key.modifiers == KeyModifiers::ALT && matches!(key.code, KeyCode::Up | KeyCode::Down) {
            self.focus_queue(if key.code == KeyCode::Up { -1 } else { 1 });
            return true;
        }
        if self.queue_focus.is_some() {
            return self.queue_key(key);
        }
        if key.modifiers == KeyModifiers::CONTROL {
            match key.code {
                KeyCode::Char('o') => {
                    let at = self
                        .focused_turn
                        .or_else(|| self.turns.len().checked_sub(1));
                    if let Some(turn) = at.and_then(|at| self.turns.get_mut(at)) {
                        turn.work_open = Some(!turn.work_expanded());
                    }
                    return true;
                }
                KeyCode::Up | KeyCode::Down => {
                    if !self.turns.is_empty() {
                        let at = self.focused_turn.unwrap_or(self.turns.len() - 1);
                        self.focused_turn = Some(if key.code == KeyCode::Up {
                            at.saturating_sub(1)
                        } else {
                            (at + 1).min(self.turns.len() - 1)
                        });
                    }
                    return true;
                }
                KeyCode::Char('y') => {
                    self.copy_reply();
                    return true;
                }
                _ => {}
            }
        }
        if let Some(at) = self.focused_turn {
            if matches!(key.code, KeyCode::Char(' ') | KeyCode::Enter) {
                if let Some(turn) = self.turns.get_mut(at) {
                    turn.work_open = Some(!turn.work_expanded());
                }
                return true;
            }
        }
        match key.code {
            KeyCode::PageUp => return self.scroll_by(10),
            KeyCode::PageDown => return self.scroll_by(-10),
            KeyCode::Up
                if self.prompt.text().is_empty() || key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                return self.scroll_by(1)
            }
            KeyCode::Down
                if self.prompt.text().is_empty() || key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                return self.scroll_by(-1)
            }
            KeyCode::Enter => {
                self.submit_prompt(
                    if key
                        .modifiers
                        .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL)
                    {
                        PromptDelivery::FollowUp
                    } else {
                        PromptDelivery::Steer
                    },
                );
                return true;
            }
            _ => {}
        }
        if self.prompt.edit(key) {
            self.notice = None;
            self.sync_commands();
            return true;
        }
        false
    }
    fn sync_commands(&mut self) {
        let Some(query) = self.prompt.text().strip_prefix('/') else {
            if matches!(self.popup, Some(Popup::Commands(_))) {
                self.popup = None;
            }
            return;
        };
        let query = query.to_ascii_lowercase();
        let mut menu = Menu::new(COMMANDS.to_vec());
        menu.filter(|e| e.name.starts_with(&query));
        self.popup = if menu.entries().is_empty() {
            None
        } else {
            Some(Popup::Commands(menu))
        };
    }
    fn filter_popup(&mut self) {
        match &mut self.popup {
            Some(Popup::Models { search, menu }) => {
                *menu = filter_models(search.text(), self.models.as_ref(), None)
            }
            Some(Popup::Themes {
                search,
                menu,
                initial,
            }) => self.theme = filter_themes(search.text(), menu, initial),
            Some(Popup::Sessions {
                search,
                menu,
                sessions,
            }) => {
                *menu = crate::browser::menu(
                    sessions,
                    search.text(),
                    menu.selected().map(|e| e.id.as_ref()),
                );
            }
            _ => {}
        }
    }
    fn step_menu(&mut self, step: isize) -> bool {
        if let Some(popup) = &mut self.popup {
            popup.menu_mut().step(step);
            if let Popup::Themes { menu, .. } = popup {
                if let Some(p) = menu.selected().and_then(|e| theme_named(&e.name)) {
                    self.theme = p;
                }
            }
        }
        true
    }
    fn choose(&mut self) -> bool {
        if matches!(self.popup, Some(Popup::Fork(_))) {
            return self.fork_selected(ForkMode::At);
        }
        let Some(chosen) = self
            .popup
            .as_ref()
            .and_then(|p| p.menu().selected())
            .cloned()
        else {
            return false;
        };
        match self.popup.take().unwrap() {
            Popup::Commands(_) => {
                self.prompt.clear();
                self.command(&chosen.id);
            }
            Popup::Models { .. } => {
                if let Some(model) = parse_model(&chosen.id) {
                    self.model = Some(model);
                    self.configure();
                }
            }
            Popup::Thinking(_) => {
                self.thinking = Some(chosen.id.to_string());
                self.configure();
            }
            Popup::Themes { .. } => {
                if let Some(theme) = theme_named(&chosen.name) {
                    self.theme = theme;
                }
            }
            Popup::Sessions { sessions, .. } => {
                if let Some(info) = sessions.into_iter().find(|t| t.id == chosen.id.as_ref()) {
                    self.switch_thread(info);
                }
            }
            Popup::Fork(_) => {}
        }
        true
    }
    fn command(&mut self, name: &str) {
        match name {
            "model" => {
                self.popup = Some(Popup::Models {
                    search: Prompt::default(),
                    menu: filter_models("", self.models.as_ref(), Some(&self.model_label())),
                })
            }
            "thinking" => {
                self.popup = Some(Popup::Thinking(Menu::at(
                    self.thinking_entries(),
                    &self.thinking_label().unwrap_or_default(),
                )))
            }
            "theme" => {
                self.popup = Some(Popup::Themes {
                    search: Prompt::default(),
                    menu: themes(self.theme.name),
                    initial: self.theme,
                })
            }
            "queue" => self.focus_queue(-1),
            "fork" => self.open_fork(),
            "copy" => self.copy_reply(),
            "session" => self.open_browser(),
            "new" => {
                self.remember();
                self.stop_browser();
                self.stop_stream();
                self.generation += 1;
                self.session = None;
                self.entries.clear();
                self.turns.clear();
                self.queued_prompts.clear();
                self.queue_focus = None;
                self.queue_edit = None;
                self.queue_pending.clear();
                self.early.clear();
                self.revisions.clear();
                self.floor = None;
                self.paging = false;
                self.scroll = 0;
                self.busy = false;
                self.screen = Screen::Welcome;
                self.restore_draft();
            }
            "reload" => self.spawn_operation(|client, _| async move {
                let (count, error) = client.reload_plugins().await?;
                Ok(OperationResult::Notice(
                    error.unwrap_or_else(|| format!("reloaded {count} plugins")),
                ))
            }),
            "exit" => self.should_quit = true,
            _ => {}
        }
    }
    fn configure(&self) {
        let model = self.model.clone();
        let thinking = self.thinking_label();
        self.spawn_operation(move |client, address| async move {
            Ok(OperationResult::Info(
                client.configure_thread(address, model, thinking).await?,
            ))
        });
    }
    fn submit_prompt(&mut self, delivery: PromptDelivery) {
        let Some((text, delivery)) =
            parse_prompt_submission(self.prompt.text(), delivery, self.busy)
        else {
            return;
        };
        if self.creating {
            self.notice = Some("creating session…".into());
            return;
        }
        self.prompt.clear();
        self.popup = None;
        self.scroll = 0;
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let id = format!("msg_{millis}_{}", self.next_prompt_seq);
        self.next_prompt_seq += 1;
        if self.session.is_none() {
            self.creating = true;
            let tx = self.tx.clone();
            let client = self.client.clone();
            let model = self.model.clone();
            let thinking = self.thinking.clone();
            let host = std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string());
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let result = client.create_session(host, model, thinking).await;
                    let _ = tx.send(AppEvent::rpc(RpcEvent::Created {
                        result,
                        text,
                        delivery,
                        id,
                    }));
                });
            }
        } else {
            self.dispatch(text, delivery, id);
        }
    }
    fn dispatch(&mut self, text: String, delivery: PromptDelivery, id: String) {
        self.queued_prompts.push(QueuedPrompt {
            message_id: id.clone(),
            prompt: text.clone(),
            delivery,
            admitted: false,
        });
        self.spawn_operation(move |client, address| async move {
            Ok(
                match client
                    .send_prompt(address, text, delivery, id.clone())
                    .await
                {
                    Ok(()) => OperationResult::Sent { id },
                    Err(error) => OperationResult::SendFailed { id, error },
                },
            )
        });
    }
    fn focus_queue(&mut self, step: isize) {
        if self.queued_prompts.is_empty() {
            self.queue_focus = None;
            self.notice = Some("queue is empty".into());
            return;
        }
        let at = self
            .queue_focus
            .as_ref()
            .and_then(|id| self.queued_prompts.iter().position(|q| &q.message_id == id));
        let at = at
            .map(|at| (at as isize + step).rem_euclid(self.queued_prompts.len() as isize) as usize)
            .unwrap_or(0);
        self.queue_focus = Some(self.queued_prompts[at].message_id.clone());
        self.focused_turn = None;
        self.notice = None;
    }
    fn queue_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Up => self.focus_queue(-1),
            KeyCode::Down => self.focus_queue(1),
            KeyCode::Char('l') | KeyCode::Enter => {
                if let Some(q) = self.selected_queue().cloned() {
                    let delivery = if self.session.as_ref().is_some_and(|t| t.parked)
                        || !self.busy
                        || q.delivery == PromptDelivery::FollowUp
                    {
                        PromptDelivery::Steer
                    } else {
                        PromptDelivery::FollowUp
                    };
                    self.queue_update(q.message_id, Some(delivery), None);
                }
            }
            KeyCode::Char('e') => {
                if let Some(q) = self
                    .selected_queue()
                    .filter(|q| !self.queue_pending.contains(&q.message_id))
                {
                    let mut text = Prompt::default();
                    text.insert_text(&q.prompt);
                    self.queue_edit = Some(QueueEdit {
                        id: q.message_id.clone(),
                        text,
                    });
                }
            }
            KeyCode::Char('w') => self.queue_cancel(true),
            KeyCode::Delete | KeyCode::Char('d') => self.queue_cancel(false),
            _ => {}
        }
        true
    }
    fn selected_queue(&self) -> Option<&QueuedPrompt> {
        self.queued_prompts
            .iter()
            .find(|q| Some(&q.message_id) == self.queue_focus.as_ref())
    }
    fn queue_cancel(&mut self, restore: bool) {
        let Some(q) = self.selected_queue().cloned() else {
            return;
        };
        if !q.admitted || !self.queue_pending.insert(q.message_id.clone()) {
            return;
        }
        self.spawn_operation(move |client, address| async move {
            let cancelled = match client
                .cancel_queued_prompt(address, q.message_id.clone())
                .await
            {
                Ok(cancelled) => cancelled,
                Err(error) => {
                    return Ok(OperationResult::QueueFailed {
                        id: q.message_id,
                        error,
                    })
                }
            };
            Ok(OperationResult::Cancel {
                id: q.message_id,
                restore: restore.then_some(q.prompt),
                cancelled,
            })
        });
    }
    fn queue_update(&mut self, id: String, delivery: Option<PromptDelivery>, text: Option<String>) {
        if !self
            .queued_prompts
            .iter()
            .any(|q| q.message_id == id && q.admitted)
            || !self.queue_pending.insert(id.clone())
        {
            return;
        }
        self.spawn_operation(move |client, address| async move {
            let updated = match client
                .update_queued_prompt(address, id.clone(), delivery, text.clone())
                .await
            {
                Ok(updated) => updated,
                Err(error) => return Ok(OperationResult::QueueFailed { id, error }),
            };
            Ok(OperationResult::Update {
                id,
                delivery,
                text,
                updated,
            })
        });
    }
    pub fn open_fork(&mut self) {
        let entries = self
            .entries
            .iter()
            .filter(|e| e.state == "committed")
            .map(|e| {
                Entry::owned(
                    e.id.clone(),
                    format!("{} · {}", e.role, text_of(e)),
                    format!("#{}", e.seq),
                )
            })
            .collect();
        self.popup = Some(Popup::Fork(Menu::new(entries)));
    }
    fn fork_selected(&mut self, mode: ForkMode) -> bool {
        let Some(id) = self
            .popup
            .as_ref()
            .and_then(|p| p.menu().selected())
            .map(|e| e.id.to_string())
        else {
            return false;
        };
        if mode == ForkMode::Before && !self.entries.iter().any(|e| e.id == id && e.role == "user")
        {
            self.notice = Some("before is available for user messages".into());
            return true;
        }
        self.popup = None;
        self.spawn_operation(move |client, address| async move {
            Ok(OperationResult::Fork(
                client.fork_thread(address, id, mode).await?,
            ))
        });
        true
    }
    fn copy_reply(&mut self) {
        let text = self
            .focused_turn
            .and_then(|at| self.turns.get(at))
            .or_else(|| self.turns.iter().rev().find(|t| !t.text.is_empty()))
            .map(|t| t.text.as_str())
            .unwrap_or("");
        if text.is_empty() {
            self.notice = Some("no assistant reply to copy".into());
            return;
        }
        let mut out = std::io::stdout().lock();
        self.notice = Some(
            match out
                .write_all(osc52(text).as_bytes())
                .and_then(|_| out.flush())
            {
                Ok(()) => "copy sent to terminal clipboard".into(),
                Err(e) => format!("copy failed: {e}"),
            },
        );
    }

    fn handle_rpc(&mut self, event: RpcEvent) -> bool {
        match event {
            RpcEvent::ServerInfoLoaded(result) => match result {
                Ok(info) => self.server_info = Some(info),
                Err(error) => self.notice = Some(error),
            },
            RpcEvent::ModelsLoaded(result) => match result {
                Ok(models) => self.models = Some(models),
                Err(error) => self.notice = Some(error),
            },
            RpcEvent::ThreadsLoaded { generation, result } => {
                if generation != self.browser_generation
                    || !matches!(self.popup, Some(Popup::Sessions { .. }))
                {
                    return false;
                }
                match result {
                    Ok(threads) => {
                        if let Some(Popup::Sessions {
                            search,
                            menu,
                            sessions,
                        }) = &mut self.popup
                        {
                            let selected = menu
                                .selected()
                                .map(|e| e.id.to_string())
                                .or_else(|| self.session.as_ref().map(|t| t.id.clone()));
                            *menu =
                                crate::browser::menu(&threads, search.text(), selected.as_deref());
                            *sessions = threads;
                        }
                        self.notice = None;
                    }
                    Err(error) => self.notice = Some(error),
                }
            }
            RpcEvent::Created {
                result,
                text,
                delivery,
                id,
            } => {
                self.creating = false;
                match result {
                    Ok(info) => {
                        self.switch_thread(info);
                        self.dispatch(text, delivery, id);
                    }
                    Err(error) => {
                        self.prompt.insert_text(&text);
                        self.notice = Some(error);
                    }
                }
            }
            RpcEvent::ThreadStream {
                address,
                generation,
                event,
            } => {
                if self.address().as_ref() != Some(&address) || generation != self.generation {
                    return false;
                }
                match event {
                    StreamEvent::Item(item) => self.apply_item(item),
                    StreamEvent::Info { rev, info } => {
                        if rev >= self.info_revision {
                            self.info_revision = rev;
                            self.apply_info(*info);
                        }
                    }
                    StreamEvent::Event(envelope) => self.apply_event(envelope),
                    StreamEvent::Reset => {
                        self.entries.clear();
                        self.turns.clear();
                        self.early.clear();
                        self.revisions.clear();
                        self.queued_prompts.clear();
                        self.floor = None;
                        self.info_revision = 0;
                        self.paging = false;
                        self.scroll = 0;
                    }
                    StreamEvent::Disconnected => self.reconnecting = true,
                    StreamEvent::Reconnected => self.reconnecting = false,
                    StreamEvent::Failed(error) => {
                        self.reconnecting = false;
                        self.notice = Some(error);
                    }
                }
            }
            RpcEvent::Operation {
                address,
                generation,
                result,
            } => {
                if self.address().as_ref() != Some(&address) || generation != self.generation {
                    return false;
                }
                match result {
                    Err(error) => {
                        self.notice = Some(error);
                    }
                    Ok(OperationResult::PageFailed(error)) => {
                        self.paging = false;
                        self.notice = Some(error);
                    }
                    Ok(OperationResult::QueueFailed { id, error }) => {
                        self.queue_pending.remove(&id);
                        self.notice = Some(error);
                    }
                    Ok(OperationResult::Cancel {
                        id,
                        restore,
                        cancelled,
                    }) => {
                        self.queue_pending.remove(&id);
                        if cancelled {
                            self.queued_prompts.retain(|q| q.message_id != id);
                            if let Some(text) = restore {
                                let current = self.prompt.text().to_string();
                                self.prompt = Prompt::default();
                                self.prompt.insert_text(&if current.trim().is_empty() {
                                    text
                                } else {
                                    format!("{text}\n\n{current}")
                                });
                                self.queue_focus = None;
                            }
                        } else {
                            self.notice = Some("message was already sent or removed".into());
                        }
                        self.reconcile_focus();
                    }
                    Ok(OperationResult::Update {
                        id,
                        delivery,
                        text,
                        updated,
                    }) => {
                        self.queue_pending.remove(&id);
                        if updated {
                            if let Some(q) =
                                self.queued_prompts.iter_mut().find(|q| q.message_id == id)
                            {
                                if let Some(delivery) = delivery {
                                    q.delivery = delivery;
                                }
                                if let Some(text) = text {
                                    q.prompt = text;
                                }
                            }
                        } else {
                            self.notice = Some("message was already sent or removed".into());
                        }
                    }
                    Ok(OperationResult::Fork(reply)) => {
                        self.switch_thread(reply.thread);
                        if let Some(text) = reply.text {
                            self.prompt.clear();
                            self.prompt.insert_text(&text);
                        }
                    }
                    Ok(OperationResult::Page { before, entries }) => {
                        self.paging = false;
                        let oldest = entries.iter().map(|e| e.seq).min();
                        let known: BTreeSet<_> =
                            self.entries.iter().map(|e| e.id.clone()).collect();
                        self.entries.extend(
                            entries
                                .into_iter()
                                .filter(|e| e.seq < before && !known.contains(&e.id)),
                        );
                        self.entries.sort_by_key(|e| e.seq);
                        self.floor = Some(oldest.filter(|seq| *seq < before).unwrap_or(1));
                        self.rebuild();
                    }
                    Ok(OperationResult::Info(info)) => self.apply_info(info),
                    Ok(OperationResult::SendFailed { id, error }) => {
                        if let Some(at) =
                            self.queued_prompts.iter().position(|q| q.message_id == id)
                        {
                            let queued = self.queued_prompts.remove(at);
                            if self.prompt.text().is_empty() {
                                self.prompt.insert_text(&queued.prompt);
                            } else {
                                self.notice = Some(format!("{error} · unsent: {}", queued.prompt));
                                self.reconcile_focus();
                                return true;
                            }
                        }
                        self.reconcile_focus();
                        self.notice = Some(error);
                    }
                    Ok(OperationResult::Sent { id }) => {
                        if let Some(q) = self.queued_prompts.iter_mut().find(|q| q.message_id == id)
                        {
                            q.admitted = true;
                        }
                    }
                    Ok(OperationResult::Notice(text)) => self.notice = Some(text),
                }
            }
        }
        true
    }
    fn reconcile_focus(&mut self) {
        if self
            .queue_edit
            .as_ref()
            .is_some_and(|edit| !self.queued_prompts.iter().any(|q| q.message_id == edit.id))
        {
            self.queue_edit = None;
        }
        if self
            .queue_focus
            .as_ref()
            .is_some_and(|id| !self.queued_prompts.iter().any(|q| &q.message_id == id))
        {
            self.queue_focus = self.queued_prompts.first().map(|q| q.message_id.clone());
        }
    }
    pub fn apply_item(&mut self, item: ThreadItem) {
        match item {
            ThreadItem::Synced { floor, .. } => {
                if let Some(floor) = floor {
                    self.floor = Some(floor);
                }
                return;
            }
            ThreadItem::Entry { mut entry, rev } => {
                let key = format!("entry:{}", entry.id);
                if self.revisions.get(&key).is_some_and(|old| *old >= rev) {
                    return;
                }
                self.revisions.insert(key, rev);
                if let Some(at) = self.entries.iter().position(|e| e.id == entry.id) {
                    let previous = &self.entries[at];
                    if entry.state == "draft" {
                        if previous.state != "draft" {
                            return;
                        }
                        merge_streamed(&mut entry.parts, &previous.parts);
                    }
                    self.entries[at] = entry;
                } else {
                    if let Some(parts) = self.early.remove(&entry.id) {
                        if entry.state == "draft" {
                            merge_streamed(&mut entry.parts, &parts);
                        }
                    }
                    self.queued_prompts.retain(|q| q.message_id != entry.id);
                    self.entries.push(entry);
                    self.entries.sort_by_key(|e| e.seq);
                }
            }
            ThreadItem::Inbox { prompt, state, rev } => {
                let key = format!("inbox:{}", prompt.id);
                if self.revisions.get(&key).is_some_and(|old| *old >= rev) {
                    return;
                }
                self.revisions.insert(key, rev);
                if state == InboxState::Pending && !self.entries.iter().any(|e| e.id == prompt.id) {
                    let q = QueuedPrompt {
                        message_id: prompt.id.clone(),
                        prompt: prompt.text,
                        delivery: prompt.delivery,
                        admitted: true,
                    };
                    if let Some(at) = self
                        .queued_prompts
                        .iter()
                        .position(|q| q.message_id == prompt.id)
                    {
                        self.queued_prompts[at] = q;
                    } else {
                        self.queued_prompts.push(q);
                    }
                } else {
                    self.queued_prompts.retain(|q| q.message_id != prompt.id);
                }
                self.reconcile_focus();
                return;
            }
            ThreadItem::Delta { delta } => {
                if let Some(entry) = self.entries.iter_mut().find(|e| e.id == delta.entry_id) {
                    if entry.state != "draft" {
                        return;
                    }
                    fold_delta(&mut entry.parts, &delta);
                } else {
                    fold_delta(
                        self.early.entry(delta.entry_id.clone()).or_default(),
                        &delta,
                    );
                }
            }
        }
        self.reconcile_focus();
        self.rebuild();
    }
    fn apply_event(&mut self, envelope: crate::rpc::protocol::EventEnvelope) {
        let Some(data) = envelope.data else {
            return;
        };
        if data.get("threadId").and_then(serde_json::Value::as_str)
            != self.session.as_ref().map(|t| t.id.as_str())
        {
            return;
        }
        let Some(turn) = self.turns.last_mut() else {
            return;
        };
        match envelope.event_type.as_str() {
            "session.tool.progress" => {
                let id = data
                    .get("callID")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if let Some(tool) = turn
                    .tools
                    .iter_mut()
                    .find(|t| t.call_id == id && t.status == ToolStatus::Running)
                {
                    if let Some(partial) = data.get("partial") {
                        let output = partial.as_str().map(str::to_string).or_else(|| {
                            partial
                                .get("content")
                                .and_then(serde_json::Value::as_array)
                                .map(|blocks| {
                                    blocks
                                        .iter()
                                        .filter_map(|b| {
                                            b.get("text").and_then(serde_json::Value::as_str)
                                        })
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                        });
                        tool.apply_progress(output, partial.get("details"));
                    }
                }
            }
            "session.retry.scheduled" => {
                turn.retry = Some(RetryStatus {
                    attempt: data["attempt"].as_u64().unwrap_or(0),
                    max_retries: data["maxRetries"].as_u64().unwrap_or(0),
                    delay_ms: data["delayMs"].as_u64().unwrap_or(0),
                    message: data["message"].as_str().unwrap_or("").to_string(),
                });
            }
            "session.retry.finished" => turn.retry = None,
            "plugin.updated" => {
                self.notice = data
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            }
            _ => {}
        }
    }
    fn rebuild(&mut self) {
        let mut turns = turns_from_history(&self.entries);
        if self.busy {
            if let Some(last) = turns.last_mut() {
                if matches!(last.state, TurnState::Succeeded) {
                    last.state = TurnState::Running;
                }
            }
        }
        if !self.busy {
            if let Some((last, run)) = turns
                .last_mut()
                .zip(self.session.as_ref().and_then(|t| t.last_run.as_ref()))
            {
                if run.started_at >= last.created_at {
                    if let Some(error) = &run.error {
                        last.state = match error {
                            crate::types::RunError::Interrupted { reason } => {
                                TurnState::Interrupted(reason.clone())
                            }
                            _ => TurnState::Failed(error.message().to_string()),
                        };
                    }
                }
            }
        }
        for turn in &mut turns {
            if let Some(open) = turn
                .prompt_id
                .as_ref()
                .and_then(|id| self.work_restore.remove(id))
            {
                turn.work_open = Some(open);
            }
            if let Some(previous) = self
                .turns
                .iter()
                .find(|p| p.prompt_id == turn.prompt_id && p.created_at == turn.created_at)
            {
                if turn.state == TurnState::Running {
                    turn.retry = previous.retry.clone();
                    for tool in &mut turn.tools {
                        if tool.status == ToolStatus::Running {
                            if let Some(old) =
                                previous.tools.iter().find(|t| t.call_id == tool.call_id)
                            {
                                tool.output = old.output.clone();
                                tool.summary = old.summary.clone();
                            }
                        }
                    }
                }
                if previous.working() == turn.working() {
                    turn.work_open = previous.work_open;
                }
            }
        }
        self.turns = turns;
    }
}

fn text_of(entry: &HistoryEntry) -> String {
    entry
        .parts
        .iter()
        .filter_map(|p| {
            if let Part::Text { text } = p {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
fn part_text(part: &Part) -> Option<&str> {
    match part {
        Part::Text { text } => Some(text),
        Part::Thinking { thinking, .. } => Some(thinking),
        _ => None,
    }
}
fn merge_streamed(parts: &mut Vec<Part>, held: &[Part]) {
    for (at, old) in held.iter().enumerate() {
        if let Some(next) = parts.get_mut(at) {
            if std::mem::discriminant(next) == std::mem::discriminant(old)
                && part_text(next)
                    .zip(part_text(old))
                    .is_some_and(|(next, old)| old.len() > next.len() && old.starts_with(next))
            {
                *next = old.clone();
            }
        } else {
            parts.push(old.clone());
        }
    }
}
fn fold_delta(parts: &mut Vec<Part>, delta: &LiveDelta) {
    let held = parts.get(delta.part_index);
    let text = held.and_then(part_text).unwrap_or("");
    let same_kind = matches!(
        (held, delta.kind),
        (Some(Part::Text { .. }), DeltaKind::Text)
            | (Some(Part::Thinking { .. }), DeltaKind::Thinking)
    );
    if !(delta.offset == 0 && text.is_empty())
        && (!same_kind || text.encode_utf16().count() != delta.offset)
    {
        return;
    }
    let next = format!("{text}{}", delta.delta);
    while parts.len() <= delta.part_index {
        parts.push(Part::Text {
            text: String::new(),
        });
    }
    parts[delta.part_index] = match delta.kind {
        DeltaKind::Text => Part::Text { text: next },
        DeltaKind::Thinking => Part::Thinking {
            thinking: next,
            redacted: None,
        },
    };
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
    let default = list.default.as_ref();
    let default_key = default.map(|d| format!("{}/{}", d.provider, d.id));
    let default_provider_available =
        default.is_some_and(|d| list.providers.iter().any(|p| p.id == d.provider));

    let mut entries: Vec<Entry> = Vec::new();
    for provider in &list.providers {
        for model in &provider.models {
            let id = format!("{}/{}", provider.id, model.id);
            let is_default = default.is_some_and(|d| provider.id == d.provider && model.id == d.id);
            let detail = if is_default {
                format!("{} · {} · default", provider.name, model.name)
            } else {
                format!("{} · {}", provider.name, model.name)
            };
            entries.push(Entry::owned(id.clone(), id, detail));
        }
    }

    if let Some(default) = default.filter(|_| {
        !entries
            .iter()
            .any(|e| Some(e.id.as_ref()) == default_key.as_deref())
    }) {
        let provider_name = default
            .provider_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                list.providers
                    .iter()
                    .find(|p| p.id == default.provider)
                    .map(|p| p.name.as_str())
            })
            .unwrap_or(&default.provider);
        let model_name = default
            .name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&default.id);
        let detail = if default_provider_available {
            format!("{provider_name} · {model_name} · default")
        } else {
            format!("{provider_name} · {model_name} · default (no credentials)")
        };
        entries.insert(
            0,
            Entry::owned(
                default_key.clone().unwrap_or_default(),
                default_key.clone().unwrap_or_default(),
                detail,
            ),
        );
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
            turn.created_at = entry.created_at;
            turn.updated_at = entry.updated_at;
            turn.last_draft = entry.state == "draft";
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
        turn.last_draft = entry.state == "draft";
        turn.state = entry
            .error
            .as_ref()
            .map(|e| TurnState::Failed(e.clone()))
            .unwrap_or_else(|| entry_turn_state(&entry.state));
        if turn.created_at == 0 {
            turn.created_at = entry.created_at;
        }
        turn.updated_at = turn.updated_at.max(entry.updated_at);
        // The last assistant entry alone owns the answer; previous text is work.
        if !turn.text.is_empty() {
            if !turn.notes.is_empty() {
                turn.notes.push_str("\n\n");
            }
            turn.notes.push_str(&turn.text);
        }
        turn.text.clear();
        turn.answer_present = entry
            .parts
            .iter()
            .any(|part| matches!(part, Part::Text { .. }));
        for part in &entry.parts {
            if let Part::ToolCall {
                time: Some(time), ..
            } = part
            {
                turn.updated_at = turn.updated_at.max(time.end);
            }
        }
        for part in &entry.parts {
            match part {
                Part::Text { text } if !text.is_empty() => {
                    if !turn.text.is_empty() {
                        turn.text.push_str("\n\n");
                    }
                    turn.text.push_str(text);
                }
                Part::Thinking { thinking, redacted }
                    if redacted != &Some(true) && !thinking.is_empty() =>
                {
                    if !turn.thinking.is_empty() {
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
