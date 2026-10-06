use std::sync::Arc;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use tokio::sync::mpsc;

use crate::catalog::{
    copy_to_clipboard, open_browser_url, validate_api_key,
};
use crate::config::ConfigManager;
use crate::credentials::CredentialStore;
use crate::rpc::{RpcClient, StreamEvent};
use crate::tool;
use crate::types::{
    ConversationTurn, FocusedPanel, ModelConfig, ModelSortMode, SessionInfo, SessionStats,
};
use crate::ui::model::ModelBrowserState;
use crate::ui::spinner::Spinner;
use crate::ui::welcome::COMMANDS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActiveScreen {
    Welcome,
    ModelFlow,
    Session,
}

pub struct App {
    pub screen: ActiveScreen,
    pub should_quit: bool,
    pub config_manager: ConfigManager,
    pub active_config: Option<ModelConfig>,
    pub spinner: Spinner,

    // Welcome screen state
    pub welcome_input: String,
    pub welcome_cursor: usize,
    pub welcome_dropdown_index: usize,
    pub welcome_status_message: Option<String>,

    // Model browser state
    pub model_browser: ModelBrowserState,

    // Session state
    pub session_info: Option<SessionInfo>,
    pub turns: Vec<ConversationTurn>,
    pub session_stats: SessionStats,
    pub session_input: String,
    pub session_cursor: usize,
    pub session_scroll_offset: usize,
    pub session_dropdown_index: usize,
    pub is_streaming: bool,

    // RPC Client
    pub rpc_client: Arc<RpcClient>,
    pub stream_tx: mpsc::UnboundedSender<StreamEvent>,
    pub stream_rx: mpsc::UnboundedReceiver<StreamEvent>,
}

impl App {
    pub fn new() -> Self {
        let config_manager = ConfigManager::new();
        let active_config = config_manager.load();
        let (stream_tx, stream_rx) = mpsc::unbounded_channel();

        Self {
            screen: ActiveScreen::Welcome,
            should_quit: false,
            config_manager,
            active_config,
            spinner: Spinner::new(),

            welcome_input: String::new(),
            welcome_cursor: 0,
            welcome_dropdown_index: 0,
            welcome_status_message: None,

            model_browser: ModelBrowserState::new(),

            session_info: None,
            turns: Vec::new(),
            session_stats: SessionStats::default(),
            session_input: String::new(),
            session_cursor: 0,
            session_scroll_offset: 0,
            session_dropdown_index: 0,
            is_streaming: false,

            rpc_client: Arc::new(RpcClient::default()),
            stream_tx,
            stream_rx,
        }
    }

    pub fn on_tick(&mut self) {
        self.spinner.tick();

        // Process any pending stream events from background RPC tasks
        while let Ok(event) = self.stream_rx.try_recv() {
            self.handle_stream_event(event);
        }
    }

    pub fn handle_stream_event(&mut self, event: StreamEvent) {
        if self.screen == ActiveScreen::ModelFlow {
            match event {
                StreamEvent::Succeeded => {
                    self.model_browser.validating = false;
                    self.model_browser.validation_error = None;
                    self.model_browser.api_key_modal_open = false;
                    self.active_config = self.config_manager.load();
                    if let Some(cfg) = &self.active_config {
                        self.welcome_status_message = Some(format!("Model configured: {} ({})", cfg.model, cfg.provider));
                    }
                    self.screen = ActiveScreen::Welcome;
                }
                StreamEvent::Failed(err) => {
                    self.model_browser.validating = false;
                    self.model_browser.validation_error = Some(err);
                }
                _ => {}
            }
            return;
        }

        let last_turn_idx = if self.turns.is_empty() {
            return;
        } else {
            self.turns.len() - 1
        };

        match event {
            StreamEvent::SessionCreated(info) => {
                self.session_info = Some(info);
            }
            StreamEvent::TextDelta(delta) => {
                if let Some(turn) = self.turns.get_mut(last_turn_idx) {
                    turn.response.push_str(&delta);
                    let approx_tokens = (delta.len() / 4).max(1) as u64;
                    turn.tokens += approx_tokens;
                    let elapsed_sec = (chrono::Utc::now().timestamp_millis() - turn.start_time) as f64 / 1000.0;
                    if elapsed_sec > 0.1 {
                        turn.tokens_per_sec = turn.tokens as f64 / elapsed_sec;
                    }
                }
            }
            StreamEvent::ThinkingDelta(delta) => {
                if let Some(turn) = self.turns.get_mut(last_turn_idx) {
                    turn.thinking.push_str(&delta);
                }
            }
            StreamEvent::ToolStarted {
                call_id,
                name,
                label,
                arguments,
            } => {
                if let Some(turn) = self.turns.get_mut(last_turn_idx) {
                    // Title the running line from the call's arguments, so an in-flight tool
                    // reads `bash npm test` rather than just `bash`.
                    turn.active_tool = Some(tool::derive(&name, label.as_deref(), &arguments, None, false));
                    turn.active_call_id = Some(call_id);
                }
            }
            StreamEvent::ToolSettled {
                call_id,
                name,
                is_error,
                arguments,
                details,
            } => {
                if let Some(turn) = self.turns.get_mut(last_turn_idx) {
                    // Pair by callID: parallel tool calls settle out of order, so a settle that
                    // is not the current active call must not clear or steal its line.
                    let live = if turn.active_call_id.as_deref() == Some(call_id.as_str()) {
                        turn.active_call_id = None;
                        turn.active_tool.take()
                    } else {
                        None
                    };
                    let tool_name = name.clone().unwrap_or_else(|| call_id.clone());
                    let settled =
                        tool::derive(&tool_name, None, &arguments, details.as_ref(), is_error);
                    // The running call already resolved its own identity, including the
                    // tool's declared label, which the terminal part does not carry.
                    let result = match live {
                        Some(running) => tool::settle(running, settled),
                        None => settled,
                    };
                    turn.completed_tools.push(result);
                }
            }
            StreamEvent::Usage(usage) => {
                self.session_stats.total_tokens += usage.total_tokens;
                self.session_stats.cost += usage.cost;
                self.session_stats.turns_count += 1;

                if let Some(turn) = self.turns.get_mut(last_turn_idx) {
                    turn.tokens = usage.output_tokens.max(turn.tokens);
                    let elapsed_sec = (chrono::Utc::now().timestamp_millis() - turn.start_time) as f64 / 1000.0;
                    if elapsed_sec > 0.1 {
                        turn.tokens_per_sec = turn.tokens as f64 / elapsed_sec;
                    }
                }
            }
            StreamEvent::Succeeded => {
                if let Some(turn) = self.turns.get_mut(last_turn_idx) {
                    turn.streaming = false;
                    turn.end_time = Some(chrono::Utc::now().timestamp_millis());
                    // A call that never settled keeps the line it was titled with.
                    if let Some(running) = turn.active_tool.take() {
                        turn.active_call_id = None;
                        turn.completed_tools.push(running);
                    }
                }
                self.is_streaming = false;
            }
            StreamEvent::Failed(err) => {
                if let Some(turn) = self.turns.get_mut(last_turn_idx) {
                    turn.streaming = false;
                    turn.error = Some(err);
                    turn.active_tool = None;
                    turn.active_call_id = None;
                }
                self.is_streaming = false;
            }
            StreamEvent::Interrupted(reason) => {
                if let Some(turn) = self.turns.get_mut(last_turn_idx) {
                    turn.streaming = false;
                    turn.error = Some(format!("Interrupted: {}", reason));
                    turn.active_tool = None;
                    turn.active_call_id = None;
                }
                self.is_streaming = false;
            }
        }
    }

    pub fn get_session_input_width(&self) -> usize {
        let (term_w, _) = crossterm::terminal::size().unwrap_or((80, 24));
        let sidebar_width = (term_w / 4).clamp(24, 32);
        let main_width = term_w.saturating_sub(sidebar_width + 1);
        (main_width as usize).saturating_sub(6).max(10)
    }

    pub fn get_welcome_input_width(&self) -> usize {
        let (term_w, _) = crossterm::terminal::size().unwrap_or((80, 24));
        let card_width = 78u16.min(term_w.saturating_sub(2));
        (card_width as usize).saturating_sub(6).max(10)
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        self.spinner.reset_blink();

        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            if self.is_streaming {
                // Interrupt active session
                if let Some(sess) = &self.session_info {
                    let rpc = self.rpc_client.clone();
                    let s_id = sess.id.clone();
                    tokio::spawn(async move {
                        let _ = rpc.interrupt_session(&s_id).await;
                    });
                }
                self.is_streaming = false;
                return;
            }
            self.should_quit = true;
            return;
        }

        match self.screen {
            ActiveScreen::Welcome => self.handle_welcome_key(key),
            ActiveScreen::ModelFlow => self.handle_model_flow_key(key),
            ActiveScreen::Session => self.handle_session_key(key),
        }
    }

    fn handle_welcome_key(&mut self, key: KeyEvent) {
        let is_dropdown_open = self.welcome_input.starts_with('/') && !self.welcome_input.contains(' ');
        let matching_cmds = if is_dropdown_open {
            COMMANDS
                .iter()
                .filter(|cmd| cmd.name.starts_with(&self.welcome_input))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        match key.code {
            KeyCode::Esc => {
                if is_dropdown_open {
                    self.welcome_input.clear();
                    self.welcome_cursor = 0;
                    self.welcome_dropdown_index = 0;
                } else {
                    self.should_quit = true;
                }
            }
            KeyCode::Up => {
                if is_dropdown_open && !matching_cmds.is_empty() {
                    if self.welcome_dropdown_index == 0 {
                        self.welcome_dropdown_index = matching_cmds.len() - 1;
                    } else {
                        self.welcome_dropdown_index -= 1;
                    }
                } else if !is_dropdown_open {
                    let w = self.get_welcome_input_width();
                    if let Some(new_cur) = crate::ui::input::cursor_up_in_input(&self.welcome_input, self.welcome_cursor, w) {
                        self.welcome_cursor = new_cur;
                    }
                }
            }
            KeyCode::Down => {
                if is_dropdown_open && !matching_cmds.is_empty() {
                    if self.welcome_dropdown_index + 1 >= matching_cmds.len() {
                        self.welcome_dropdown_index = 0;
                    } else {
                        self.welcome_dropdown_index += 1;
                    }
                } else if !is_dropdown_open {
                    let w = self.get_welcome_input_width();
                    if let Some(new_cur) = crate::ui::input::cursor_down_in_input(&self.welcome_input, self.welcome_cursor, w) {
                        self.welcome_cursor = new_cur;
                    }
                }
            }
            KeyCode::Left => {
                self.welcome_cursor = self.welcome_cursor.saturating_sub(1);
            }
            KeyCode::Right => {
                let char_count = self.welcome_input.chars().count();
                if self.welcome_cursor < char_count {
                    self.welcome_cursor += 1;
                }
            }
            KeyCode::Home => {
                self.welcome_cursor = 0;
            }
            KeyCode::End => {
                self.welcome_cursor = self.welcome_input.chars().count();
            }
            KeyCode::Delete => {
                delete_at(&mut self.welcome_input, self.welcome_cursor);
            }
            KeyCode::Tab => {
                if is_dropdown_open && !matching_cmds.is_empty() {
                    let cmd_name = matching_cmds[self.welcome_dropdown_index].name;
                    self.welcome_input = format!("{} ", cmd_name);
                    self.welcome_cursor = self.welcome_input.chars().count();
                }
            }
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) || key.modifiers.contains(KeyModifiers::ALT) => {
                insert_char_at(&mut self.welcome_input, &mut self.welcome_cursor, '\n');
                self.welcome_dropdown_index = 0;
            }
            KeyCode::Enter => {
                if is_dropdown_open && !matching_cmds.is_empty() {
                    let cmd_name = matching_cmds[self.welcome_dropdown_index.min(matching_cmds.len() - 1)].name;
                    self.welcome_input.clear();
                    self.welcome_cursor = 0;
                    self.welcome_dropdown_index = 0;
                    if self.execute_command(cmd_name) {
                        return;
                    } else {
                        self.welcome_input = format!("{} ", cmd_name);
                        self.welcome_cursor = self.welcome_input.chars().count();
                        return;
                    }
                }

                let trimmed = self.welcome_input.trim().to_string();
                if trimmed.is_empty() {
                    return;
                }

                if self.execute_command(&trimmed) {
                    self.welcome_input.clear();
                    self.welcome_cursor = 0;
                    self.welcome_dropdown_index = 0;
                    return;
                }

                if self.active_config.is_none() {
                    self.welcome_status_message = Some("Please connect a model first (/model)".to_string());
                    self.open_model_flow();
                    return;
                }

                // Start Session
                self.welcome_input.clear();
                self.welcome_cursor = 0;
                self.welcome_dropdown_index = 0;
                self.start_session(trimmed);
            }
            KeyCode::Backspace => {
                backspace_at(&mut self.welcome_input, &mut self.welcome_cursor);
                self.welcome_dropdown_index = 0;
            }
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.welcome_cursor = 0;
            }
            KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.welcome_cursor = self.welcome_input.chars().count();
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                clear_to_start(&mut self.welcome_input, &mut self.welcome_cursor);
            }
            KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                delete_word_backward(&mut self.welcome_input, &mut self.welcome_cursor);
            }
            KeyCode::Char(c) => {
                insert_char_at(&mut self.welcome_input, &mut self.welcome_cursor, c);
                self.welcome_dropdown_index = 0;
                self.welcome_status_message = None;
            }
            _ => {}
        }
    }

    pub fn execute_command(&mut self, cmd: &str) -> bool {
        let trimmed = cmd.trim();
        let cmd_name = trimmed.split_whitespace().next().unwrap_or(trimmed);

        match cmd_name {
            "/model" => {
                self.open_model_flow();
                true
            }
            "/exit" => {
                self.should_quit = true;
                true
            }
            "/clear" => {
                self.turns.clear();
                self.session_scroll_offset = 0;
                true
            }
            "/session" => {
                self.screen = ActiveScreen::Welcome;
                true
            }
            "/help" => {
                let mut help_turn = ConversationTurn::new("help".to_string(), "/help".to_string(), "system".to_string());
                help_turn.streaming = false;
                help_turn.end_time = Some(chrono::Utc::now().timestamp_millis());
                help_turn.response = "### CodeWork Help & Commands\n\n| Command | Description |\n| :--- | :--- |\n| `/help` | Show available commands and shortcuts |\n| `/clear` | Clear conversation history and screen |\n| `/model` | Switch or view active LLM model |\n| `/session` | List or resume recent sessions |\n| `/compact` | Compact current conversation context |\n| `/exit` | Exit CodeWork TUI |\n\n**Shortcuts:**\n- `↑` / `↓` : Scroll chat history (or navigate commands when typing `/`)\n- `Home` / `End` : Jump to top / bottom of chat\n- `Ctrl+C` : Interrupt streaming response / Exit".to_string();
                self.turns.push(help_turn);
                true
            }
            "/compact" => {
                if self.turns.len() > 1 {
                    let old_count = self.turns.len();
                    let last_turn = self.turns.pop().unwrap();
                    self.turns.clear();
                    let mut compact_turn = ConversationTurn::new("compact".to_string(), "[Context Compacted]".to_string(), "system".to_string());
                    compact_turn.streaming = false;
                    compact_turn.end_time = Some(chrono::Utc::now().timestamp_millis());
                    compact_turn.response = format!("Previous {} turns compacted into session context summary.", old_count - 1);
                    self.turns.push(compact_turn);
                    self.turns.push(last_turn);
                    self.session_scroll_offset = 0;
                }
                true
            }
            _ => false,
        }
    }

    pub fn open_model_flow(&mut self) {
        self.model_browser = ModelBrowserState::new();
        self.screen = ActiveScreen::ModelFlow;
    }

    fn handle_model_flow_key(&mut self, key: KeyEvent) {
        // Case 1: Help Modal is Open
        if self.model_browser.show_help {
            self.model_browser.show_help = false;
            return;
        }

        // Case 2: API Key Modal is Open
        if self.model_browser.api_key_modal_open {
            if self.model_browser.validating {
                return;
            }
            match key.code {
                KeyCode::Esc => {
                    self.model_browser.api_key_modal_open = false;
                    self.model_browser.validation_error = None;
                }
                KeyCode::Backspace => {
                    self.model_browser.api_key_input.pop();
                }
                KeyCode::Char(c) => {
                    self.model_browser.api_key_input.push(c);
                }
                KeyCode::Enter => {
                    let api_key = self.model_browser.api_key_input.trim().to_string();
                    let pending = match &self.model_browser.pending_model {
                        Some(m) => m.clone(),
                        None => return,
                    };

                    if api_key.is_empty() && pending.provider_id != "ollama" {
                        self.model_browser.validation_error = Some("API key cannot be empty".to_string());
                        return;
                    }

                    self.model_browser.validating = true;
                    self.model_browser.validation_error = None;

                    let tx = self.stream_tx.clone();
                    tokio::spawn(async move {
                        let val_res = validate_api_key(&pending.provider_id, &api_key).await;
                        match val_res {
                            Ok(_) => {
                                if !api_key.is_empty() {
                                    let cred_store = CredentialStore::new();
                                    let _ = cred_store.set_api_key(&pending.provider_id, &api_key);
                                }

                                let cfg_mgr = ConfigManager::new();
                                let _ = cfg_mgr.save(&ModelConfig {
                                    provider: pending.provider_id.clone(),
                                    model: pending.id.clone(),
                                    updated_at: Some(chrono::Utc::now().to_rfc3339()),
                                });

                                let _ = tx.send(StreamEvent::Succeeded);
                            }
                            Err(err) => {
                                let _ = tx.send(StreamEvent::Failed(err));
                            }
                        }
                    });
                }
                _ => {}
            }
            return;
        }

        // Case 3: Search mode is active
        if self.model_browser.is_searching {
            match self.model_browser.focused_panel {
                FocusedPanel::Providers => match key.code {
                    KeyCode::Esc => {
                        self.model_browser.provider_search.clear();
                        self.model_browser.is_searching = false;
                        self.model_browser.provider_index = 0;
                        self.model_browser.provider_scroll_offset = 0;
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    KeyCode::Enter => {
                        self.model_browser.is_searching = false;
                    }
                    KeyCode::Backspace => {
                        self.model_browser.provider_search.pop();
                        let filtered = self.model_browser.filtered_providers();
                        if self.model_browser.provider_search.is_empty() {
                            self.model_browser.provider_index = 0;
                        } else if !filtered.is_empty() {
                            self.model_browser.provider_index = 1;
                        } else {
                            self.model_browser.provider_index = 0;
                        }
                        self.model_browser.provider_scroll_offset = 0;
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    KeyCode::Char(c) => {
                        self.model_browser.provider_search.push(c);
                        let filtered = self.model_browser.filtered_providers();
                        if !filtered.is_empty() {
                            self.model_browser.provider_index = 1;
                        } else {
                            self.model_browser.provider_index = 0;
                        }
                        self.model_browser.provider_scroll_offset = 0;
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    _ => {}
                },
                FocusedPanel::Models => match key.code {
                    KeyCode::Esc => {
                        self.model_browser.model_search.clear();
                        self.model_browser.search_query.clear();
                        self.model_browser.is_searching = false;
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    KeyCode::Enter => {
                        self.model_browser.is_searching = false;
                        self.model_browser.focused_panel = FocusedPanel::Models;
                    }
                    KeyCode::Backspace => {
                        self.model_browser.model_search.pop();
                        self.model_browser.search_query.pop();
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    KeyCode::Char(c) => {
                        self.model_browser.model_search.push(c);
                        self.model_browser.search_query.push(c);
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    _ => {}
                },
            }
            return;
        }

        // Case 4: Normal browser dashboard navigation
        match key.code {
            KeyCode::Char('q') => {
                self.screen = ActiveScreen::Welcome;
            }
            KeyCode::Esc => {
                match self.model_browser.focused_panel {
                    FocusedPanel::Providers => {
                        if !self.model_browser.provider_search.is_empty() {
                            self.model_browser.provider_search.clear();
                            self.model_browser.provider_index = 0;
                            self.model_browser.provider_scroll_offset = 0;
                            self.model_browser.model_index = 0;
                            self.model_browser.model_scroll_offset = 0;
                        } else if !self.model_browser.model_search.is_empty() || !self.model_browser.search_query.is_empty() {
                            self.model_browser.model_search.clear();
                            self.model_browser.search_query.clear();
                            self.model_browser.model_index = 0;
                            self.model_browser.model_scroll_offset = 0;
                        } else {
                            self.screen = ActiveScreen::Welcome;
                        }
                    }
                    FocusedPanel::Models => {
                        if !self.model_browser.model_search.is_empty() || !self.model_browser.search_query.is_empty() {
                            self.model_browser.model_search.clear();
                            self.model_browser.search_query.clear();
                            self.model_browser.model_index = 0;
                            self.model_browser.model_scroll_offset = 0;
                        } else if !self.model_browser.provider_search.is_empty() {
                            self.model_browser.provider_search.clear();
                            self.model_browser.provider_index = 0;
                            self.model_browser.provider_scroll_offset = 0;
                            self.model_browser.model_index = 0;
                            self.model_browser.model_scroll_offset = 0;
                        } else {
                            self.screen = ActiveScreen::Welcome;
                        }
                    }
                }
            }
            KeyCode::Tab | KeyCode::BackTab => {
                self.model_browser.focused_panel = match self.model_browser.focused_panel {
                    FocusedPanel::Providers => FocusedPanel::Models,
                    FocusedPanel::Models => FocusedPanel::Providers,
                };
            }
            KeyCode::Char('/') => {
                self.model_browser.is_searching = true;
            }
            KeyCode::Char('s') => {
                self.model_browser.sort_mode = match self.model_browser.sort_mode {
                    ModelSortMode::Id => ModelSortMode::Provider,
                    ModelSortMode::Provider => ModelSortMode::Context,
                    ModelSortMode::Context => ModelSortMode::Cost,
                    ModelSortMode::Cost => ModelSortMode::Id,
                };
                self.model_browser.model_index = 0;
                self.model_browser.model_scroll_offset = 0;
                let sort_label = match self.model_browser.sort_mode {
                    ModelSortMode::Id => "Model ID",
                    ModelSortMode::Provider => "Provider",
                    ModelSortMode::Context => "Context Window",
                    ModelSortMode::Cost => "Cost",
                };
                self.model_browser.set_notification(format!("Sorted by {}", sort_label));
            }
            KeyCode::Char('c') => {
                match self.model_browser.focused_panel {
                    FocusedPanel::Providers => {
                        if let Some(prov) = self.model_browser.provider_for_details() {
                            let val = prov.env_keys.first().cloned().unwrap_or_else(|| prov.id.clone());
                            copy_to_clipboard(&val);
                            self.model_browser.set_notification(format!("Copied \"{}\"", val));
                        }
                    }
                    FocusedPanel::Models => {
                        if let Some(m) = self.model_browser.current_model() {
                            copy_to_clipboard(&m.id);
                            self.model_browser.set_notification(format!("Copied \"{}\"", m.id));
                        }
                    }
                }
            }
            KeyCode::Char('o') => {
                if let Some(prov) = self.model_browser.provider_for_details() {
                    if let Some(url) = &prov.docs_url {
                        open_browser_url(url);
                        self.model_browser.set_notification(format!("Opening {}", url));
                    }
                }
            }
            KeyCode::Char('?') => {
                self.model_browser.show_help = true;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                match self.model_browser.focused_panel {
                    FocusedPanel::Providers => {
                        let total_provs = 1 + self.model_browser.filtered_providers().len();
                        if self.model_browser.provider_index > 0 {
                            self.model_browser.provider_index -= 1;
                        } else {
                            self.model_browser.provider_index = total_provs.saturating_sub(1);
                        }
                        if self.model_browser.provider_index < self.model_browser.provider_scroll_offset {
                            self.model_browser.provider_scroll_offset = self.model_browser.provider_index;
                        }
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    FocusedPanel::Models => {
                        if self.model_browser.model_index > 0 {
                            self.model_browser.model_index -= 1;
                            if self.model_browser.model_index < self.model_browser.model_scroll_offset {
                                self.model_browser.model_scroll_offset = self.model_browser.model_index;
                            }
                        }
                    }
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                match self.model_browser.focused_panel {
                    FocusedPanel::Providers => {
                        let total_provs = 1 + self.model_browser.filtered_providers().len();
                        if self.model_browser.provider_index + 1 < total_provs {
                            self.model_browser.provider_index += 1;
                        } else {
                            self.model_browser.provider_index = 0;
                        }
                        let visible = 14usize;
                        if self.model_browser.provider_index >= self.model_browser.provider_scroll_offset + visible {
                            self.model_browser.provider_scroll_offset = self.model_browser.provider_index + 1 - visible;
                        }
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    FocusedPanel::Models => {
                        let models = self.model_browser.filtered_models();
                        if !models.is_empty() && self.model_browser.model_index + 1 < models.len() {
                            self.model_browser.model_index += 1;
                            let visible = 14usize;
                            if self.model_browser.model_index >= self.model_browser.model_scroll_offset + visible {
                                self.model_browser.model_scroll_offset = self.model_browser.model_index + 1 - visible;
                            }
                        }
                    }
                }
            }
            KeyCode::PageUp => {
                match self.model_browser.focused_panel {
                    FocusedPanel::Providers => {
                        self.model_browser.provider_index = self.model_browser.provider_index.saturating_sub(12);
                        self.model_browser.provider_scroll_offset = self.model_browser.provider_index;
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    FocusedPanel::Models => {
                        self.model_browser.model_index = self.model_browser.model_index.saturating_sub(12);
                        if self.model_browser.model_index < self.model_browser.model_scroll_offset {
                            self.model_browser.model_scroll_offset = self.model_browser.model_index;
                        }
                    }
                }
            }
            KeyCode::PageDown => {
                match self.model_browser.focused_panel {
                    FocusedPanel::Providers => {
                        let total_provs = 1 + self.model_browser.filtered_providers().len();
                        self.model_browser.provider_index = (self.model_browser.provider_index + 12).min(total_provs.saturating_sub(1));
                        let visible = 14usize;
                        if self.model_browser.provider_index >= self.model_browser.provider_scroll_offset + visible {
                            self.model_browser.provider_scroll_offset = self.model_browser.provider_index + 1 - visible;
                        }
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    FocusedPanel::Models => {
                        let models = self.model_browser.filtered_models();
                        if !models.is_empty() {
                            self.model_browser.model_index = (self.model_browser.model_index + 12).min(models.len() - 1);
                            let visible = 14usize;
                            if self.model_browser.model_index >= self.model_browser.model_scroll_offset + visible {
                                self.model_browser.model_scroll_offset = self.model_browser.model_index + 1 - visible;
                            }
                        }
                    }
                }
            }
            KeyCode::Home => {
                match self.model_browser.focused_panel {
                    FocusedPanel::Providers => {
                        self.model_browser.provider_index = 0;
                        self.model_browser.provider_scroll_offset = 0;
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    FocusedPanel::Models => {
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                }
            }
            KeyCode::End => {
                match self.model_browser.focused_panel {
                    FocusedPanel::Providers => {
                        let total_provs = 1 + self.model_browser.filtered_providers().len();
                        self.model_browser.provider_index = total_provs.saturating_sub(1);
                        let visible = 14usize;
                        if self.model_browser.provider_index >= visible {
                            self.model_browser.provider_scroll_offset = self.model_browser.provider_index + 1 - visible;
                        }
                        self.model_browser.model_index = 0;
                        self.model_browser.model_scroll_offset = 0;
                    }
                    FocusedPanel::Models => {
                        let models = self.model_browser.filtered_models();
                        if !models.is_empty() {
                            self.model_browser.model_index = models.len() - 1;
                            let visible = 14usize;
                            if self.model_browser.model_index >= visible {
                                self.model_browser.model_scroll_offset = self.model_browser.model_index + 1 - visible;
                            }
                        }
                    }
                }
            }
            KeyCode::Enter => {
                if let Some(m) = self.model_browser.current_model() {
                    let m_clone = m.clone();
                    let has_key = m.provider_id == "ollama" || {
                        let mut found = false;
                        for env_k in &m.env_keys {
                            if let Ok(v) = std::env::var(env_k) {
                                if !v.trim().is_empty() {
                                    found = true;
                                    break;
                                }
                            }
                        }
                        if !found {
                            let cred = CredentialStore::new();
                            if let Some(k) = cred.get_api_key(&m.provider_id) {
                                if !k.trim().is_empty() {
                                    found = true;
                                }
                            }
                        }
                        found
                    };

                    if has_key {
                        let _ = self.config_manager.save(&ModelConfig {
                            provider: m_clone.provider_id.clone(),
                            model: m_clone.id.clone(),
                            updated_at: Some(chrono::Utc::now().to_rfc3339()),
                        });
                        self.active_config = self.config_manager.load();
                        self.welcome_status_message = Some(format!("Connected to {} ({})", m_clone.name, m_clone.id));
                        self.screen = ActiveScreen::Welcome;
                    } else {
                        self.model_browser.pending_model = Some(m_clone);
                        self.model_browser.api_key_input.clear();
                        self.model_browser.validation_error = None;
                        self.model_browser.validating = false;
                        self.model_browser.api_key_modal_open = true;
                    }
                }
            }
            _ => {}
        }
    }

    pub fn handle_mouse(&mut self, mouse: crossterm::event::MouseEvent) {
        if self.screen == ActiveScreen::Session {
            match mouse.kind {
                crossterm::event::MouseEventKind::ScrollUp => {
                    self.session_scroll_offset += 2;
                }
                crossterm::event::MouseEventKind::ScrollDown => {
                    self.session_scroll_offset = self.session_scroll_offset.saturating_sub(2);
                }
                _ => {}
            }
        }
    }

    fn handle_session_key(&mut self, key: KeyEvent) {
        if self.is_streaming {
            match key.code {
                KeyCode::Up => {
                    self.session_scroll_offset += 2;
                }
                KeyCode::Down => {
                    self.session_scroll_offset = self.session_scroll_offset.saturating_sub(2);
                }
                KeyCode::PageUp => {
                    self.session_scroll_offset += 15;
                }
                KeyCode::PageDown => {
                    self.session_scroll_offset = self.session_scroll_offset.saturating_sub(15);
                }
                KeyCode::Home => {
                    self.session_scroll_offset = usize::MAX / 2;
                }
                KeyCode::End => {
                    self.session_scroll_offset = 0;
                }
                _ => {}
            }
            return;
        }

        let is_dropdown_open = self.session_input.starts_with('/') && !self.session_input.contains(' ');
        let matching_cmds = if is_dropdown_open {
            COMMANDS
                .iter()
                .filter(|cmd| cmd.name.starts_with(&self.session_input))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        if is_dropdown_open {
            match key.code {
                KeyCode::Esc => {
                    self.session_input.clear();
                    self.session_cursor = 0;
                    self.session_dropdown_index = 0;
                    return;
                }
                KeyCode::Up => {
                    if !matching_cmds.is_empty() {
                        if self.session_dropdown_index == 0 {
                            self.session_dropdown_index = matching_cmds.len() - 1;
                        } else {
                            self.session_dropdown_index -= 1;
                        }
                    }
                    return;
                }
                KeyCode::Down => {
                    if !matching_cmds.is_empty() {
                        if self.session_dropdown_index + 1 >= matching_cmds.len() {
                            self.session_dropdown_index = 0;
                        } else {
                            self.session_dropdown_index += 1;
                        }
                    }
                    return;
                }
                KeyCode::Tab => {
                    if !matching_cmds.is_empty() {
                        let cmd_name = matching_cmds[self.session_dropdown_index.min(matching_cmds.len() - 1)].name;
                        self.session_input = format!("{} ", cmd_name);
                        self.session_cursor = self.session_input.chars().count();
                    }
                    return;
                }
                KeyCode::Enter => {
                    if !matching_cmds.is_empty() {
                        let cmd_name = matching_cmds[self.session_dropdown_index.min(matching_cmds.len() - 1)].name;
                        self.session_input.clear();
                        self.session_cursor = 0;
                        self.session_dropdown_index = 0;
                        if self.execute_command(cmd_name) {
                            return;
                        } else {
                            self.session_input = format!("{} ", cmd_name);
                            self.session_cursor = self.session_input.chars().count();
                            return;
                        }
                    }
                }
                _ => {}
            }
        }

        match key.code {
            KeyCode::Esc => {
                self.screen = ActiveScreen::Welcome;
            }
            KeyCode::Up => {
                let w = self.get_session_input_width();
                if let Some(new_cur) = crate::ui::input::cursor_up_in_input(&self.session_input, self.session_cursor, w) {
                    self.session_cursor = new_cur;
                } else {
                    self.session_scroll_offset += 2;
                }
            }
            KeyCode::Down => {
                let w = self.get_session_input_width();
                if let Some(new_cur) = crate::ui::input::cursor_down_in_input(&self.session_input, self.session_cursor, w) {
                    self.session_cursor = new_cur;
                } else {
                    self.session_scroll_offset = self.session_scroll_offset.saturating_sub(2);
                }
            }
            KeyCode::PageUp => {
                self.session_scroll_offset += 15;
            }
            KeyCode::PageDown => {
                self.session_scroll_offset = self.session_scroll_offset.saturating_sub(15);
            }
            KeyCode::Left => {
                self.session_cursor = self.session_cursor.saturating_sub(1);
            }
            KeyCode::Right => {
                let char_count = self.session_input.chars().count();
                if self.session_cursor < char_count {
                    self.session_cursor += 1;
                }
            }
            KeyCode::Home => {
                if self.session_input.is_empty() {
                    self.session_scroll_offset = usize::MAX / 2;
                } else {
                    self.session_cursor = 0;
                }
            }
            KeyCode::End => {
                if self.session_input.is_empty() {
                    self.session_scroll_offset = 0;
                } else {
                    self.session_cursor = self.session_input.chars().count();
                }
            }
            KeyCode::Delete => {
                delete_at(&mut self.session_input, self.session_cursor);
                self.session_dropdown_index = 0;
            }
            KeyCode::Backspace => {
                backspace_at(&mut self.session_input, &mut self.session_cursor);
                self.session_dropdown_index = 0;
            }
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) || key.modifiers.contains(KeyModifiers::ALT) => {
                insert_char_at(&mut self.session_input, &mut self.session_cursor, '\n');
                self.session_dropdown_index = 0;
            }
            KeyCode::Enter => {
                let prompt = self.session_input.trim().to_string();
                if prompt.is_empty() {
                    return;
                }
                self.session_input.clear();
                self.session_cursor = 0;
                self.session_dropdown_index = 0;
                if self.execute_command(&prompt) {
                    return;
                }
                self.dispatch_turn(prompt);
            }
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.session_cursor = 0;
            }
            KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.session_cursor = self.session_input.chars().count();
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                clear_to_start(&mut self.session_input, &mut self.session_cursor);
                self.session_dropdown_index = 0;
            }
            KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                delete_word_backward(&mut self.session_input, &mut self.session_cursor);
                self.session_dropdown_index = 0;
            }
            KeyCode::Char('k') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                let byte_pos = self.session_input.char_indices().nth(self.session_cursor).map(|(i, _)| i).unwrap_or(self.session_input.len());
                self.session_input.truncate(byte_pos);
                self.session_dropdown_index = 0;
            }
            KeyCode::Char(c) => {
                insert_char_at(&mut self.session_input, &mut self.session_cursor, c);
                self.session_dropdown_index = 0;
            }
            _ => {}
        }
    }

    pub fn handle_paste(&mut self, text: &str) {
        self.spinner.reset_blink();
        match self.screen {
            ActiveScreen::Welcome => {
                insert_str_at(&mut self.welcome_input, &mut self.welcome_cursor, text);
                self.welcome_dropdown_index = 0;
                self.welcome_status_message = None;
            }
            ActiveScreen::ModelFlow => {
                if self.model_browser.api_key_modal_open {
                    self.model_browser.api_key_input.push_str(text);
                } else if self.model_browser.is_searching {
                    match self.model_browser.focused_panel {
                        FocusedPanel::Providers => {
                            self.model_browser.provider_search.push_str(text);
                            let filtered = self.model_browser.filtered_providers();
                            if !filtered.is_empty() {
                                self.model_browser.provider_index = 1;
                            } else {
                                self.model_browser.provider_index = 0;
                            }
                            self.model_browser.provider_scroll_offset = 0;
                            self.model_browser.model_index = 0;
                            self.model_browser.model_scroll_offset = 0;
                        }
                        FocusedPanel::Models => {
                            self.model_browser.model_search.push_str(text);
                            self.model_browser.search_query.push_str(text);
                            self.model_browser.model_index = 0;
                            self.model_browser.model_scroll_offset = 0;
                        }
                    }
                }
            }
            ActiveScreen::Session => {
                if !self.is_streaming {
                    insert_str_at(&mut self.session_input, &mut self.session_cursor, text);
                    self.session_dropdown_index = 0;
                }
            }
        }
    }

    pub fn start_session(&mut self, initial_prompt: String) {
        self.screen = ActiveScreen::Session;
        self.session_cursor = 0;
        self.session_scroll_offset = 0;
        self.session_dropdown_index = 0;

        let cfg = match &self.active_config {
            Some(c) => c.clone(),
            None => return,
        };

        let rpc = self.rpc_client.clone();
        let tx = self.stream_tx.clone();
        let prompt_clone = initial_prompt.clone();

        let model_name = cfg.model.clone();
        let new_turn = ConversationTurn::new(
            format!("turn_{}", chrono::Utc::now().timestamp_millis()),
            initial_prompt,
            model_name,
        );
        self.turns.push(new_turn);
        self.is_streaming = true;

        tokio::spawn(async move {
            let running = rpc.ensure_server_running().await;
            if !running {
                let _ = tx.send(StreamEvent::Failed("Could not connect to CodeWork server (ws://127.0.0.1:7433/rpc)".to_string()));
                return;
            }

            match rpc.create_session(&cfg.provider, &cfg.model, None, Some("high".to_string())).await {
                Ok(info) => {
                    let s_id = info.id.clone();
                    let _ = tx.send(StreamEvent::SessionCreated(info));
                    let _ = rpc.prompt_session(s_id, prompt_clone, tx).await;
                }
                Err(err) => {
                    let _ = tx.send(StreamEvent::Failed(err));
                }
            }
        });
    }

    pub fn dispatch_turn(&mut self, prompt: String) {
        let cfg = match &self.active_config {
            Some(c) => c.clone(),
            None => return,
        };

        let model_name = cfg.model.clone();
        let new_turn = ConversationTurn::new(
            format!("turn_{}", chrono::Utc::now().timestamp_millis()),
            prompt.clone(),
            model_name,
        );
        self.turns.push(new_turn);
        self.is_streaming = true;
        self.session_scroll_offset = 0;

        let rpc = self.rpc_client.clone();
        let tx = self.stream_tx.clone();
        let existing_sess_id = self.session_info.as_ref().map(|s| s.id.clone());

        tokio::spawn(async move {
            let sess_id = match existing_sess_id {
                Some(id) => id,
                None => match rpc.create_session(&cfg.provider, &cfg.model, None, Some("high".to_string())).await {
                    Ok(info) => {
                        let id = info.id.clone();
                        let _ = tx.send(StreamEvent::SessionCreated(info));
                        id
                    }
                    Err(e) => {
                        let _ = tx.send(StreamEvent::Failed(e));
                        return;
                    }
                },
            };
            let _ = rpc.prompt_session(sess_id, prompt, tx).await;
        });
    }
}

fn insert_char_at(s: &mut String, cursor: &mut usize, c: char) {
    let byte_pos = s.char_indices().nth(*cursor).map(|(i, _)| i).unwrap_or(s.len());
    s.insert(byte_pos, c);
    *cursor += 1;
}

fn insert_str_at(s: &mut String, cursor: &mut usize, text: &str) {
    let byte_pos = s.char_indices().nth(*cursor).map(|(i, _)| i).unwrap_or(s.len());
    s.insert_str(byte_pos, text);
    *cursor += text.chars().count();
}

fn backspace_at(s: &mut String, cursor: &mut usize) {
    if *cursor > 0 {
        *cursor -= 1;
        let byte_pos = s.char_indices().nth(*cursor).map(|(i, _)| i).unwrap_or(s.len());
        if let Some((_, ch)) = s[byte_pos..].char_indices().next() {
            s.drain(byte_pos..byte_pos + ch.len_utf8());
        }
    }
}

fn delete_at(s: &mut String, cursor: usize) {
    let char_count = s.chars().count();
    if cursor < char_count {
        let byte_pos = s.char_indices().nth(cursor).map(|(i, _)| i).unwrap_or(s.len());
        if let Some((_, ch)) = s[byte_pos..].char_indices().next() {
            s.drain(byte_pos..byte_pos + ch.len_utf8());
        }
    }
}

fn delete_word_backward(s: &mut String, cursor: &mut usize) {
    if *cursor == 0 {
        return;
    }
    let chars: Vec<char> = s.chars().collect();
    let mut new_cursor = *cursor;
    while new_cursor > 0 && chars[new_cursor - 1].is_whitespace() {
        new_cursor -= 1;
    }
    while new_cursor > 0 && !chars[new_cursor - 1].is_whitespace() {
        new_cursor -= 1;
    }
    let remove_count = *cursor - new_cursor;
    let start_byte = s.char_indices().nth(new_cursor).map(|(i, _)| i).unwrap_or(s.len());
    let end_byte = start_byte
        + chars[new_cursor..new_cursor + remove_count]
            .iter()
            .map(|c| c.len_utf8())
            .sum::<usize>();
    s.drain(start_byte..end_byte);
    *cursor = new_cursor;
}

fn clear_to_start(s: &mut String, cursor: &mut usize) {
    let byte_pos = s.char_indices().nth(*cursor).map(|(i, _)| i).unwrap_or(s.len());
    s.drain(0..byte_pos);
    *cursor = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_editing_operations() {
        let mut s = String::new();
        let mut cursor = 0;

        // Typing fast
        for c in "hello world".chars() {
            insert_char_at(&mut s, &mut cursor, c);
        }
        assert_eq!(s, "hello world");
        assert_eq!(cursor, 11);

        // Move cursor back
        cursor = 5;
        insert_char_at(&mut s, &mut cursor, ',');
        assert_eq!(s, "hello, world");
        assert_eq!(cursor, 6);

        // Backspace
        backspace_at(&mut s, &mut cursor);
        assert_eq!(s, "hello world");
        assert_eq!(cursor, 5);

        // Delete char at cursor (' ')
        delete_at(&mut s, cursor);
        assert_eq!(s, "helloworld");
        assert_eq!(cursor, 5);

        // Paste
        insert_str_at(&mut s, &mut cursor, " beautiful ");
        assert_eq!(s, "hello beautiful world");
        assert_eq!(cursor, 16);

        // Delete word backward
        delete_word_backward(&mut s, &mut cursor);
        assert_eq!(s, "hello world");
        assert_eq!(cursor, 6);

        // Clear to start
        clear_to_start(&mut s, &mut cursor);
        assert_eq!(s, "world");
        assert_eq!(cursor, 0);
    }

    #[test]
    fn test_unicode_text_editing() {
        let mut s = String::new();
        let mut cursor = 0;

        insert_char_at(&mut s, &mut cursor, '🚀');
        insert_char_at(&mut s, &mut cursor, ' ');
        insert_char_at(&mut s, &mut cursor, 'h');
        insert_char_at(&mut s, &mut cursor, 'i');
        assert_eq!(s, "🚀 hi");
        assert_eq!(cursor, 4);

        // Backspace 'i'
        backspace_at(&mut s, &mut cursor);
        assert_eq!(s, "🚀 h");
        assert_eq!(cursor, 3);

        // Backspace 'h', ' ', '🚀'
        backspace_at(&mut s, &mut cursor);
        backspace_at(&mut s, &mut cursor);
        backspace_at(&mut s, &mut cursor);
        assert_eq!(s, "");
        assert_eq!(cursor, 0);
    }

    #[tokio::test]
    async fn test_model_browser_full_flow() {
        let mut app = App::new();
        assert_eq!(app.screen, ActiveScreen::Welcome);

        // Type /model and press Enter
        app.welcome_input = "/model".to_string();
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(app.screen, ActiveScreen::ModelFlow);

        // Check initial state: 6001 models, focused on Models panel
        assert_eq!(app.model_browser.focused_panel, FocusedPanel::Models);
        assert_eq!(app.model_browser.filtered_models().len(), 6001);

        // Tab switches to Providers panel
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.model_browser.focused_panel, FocusedPanel::Providers);

        // Arrow down moves to first provider
        app.handle_key(KeyEvent::from(KeyCode::Down));
        assert_eq!(app.model_browser.provider_index, 1);
        let models_for_p1 = app.model_browser.filtered_models();
        assert!(!models_for_p1.is_empty() && models_for_p1.len() < 6001);

        // Tab back to Models panel
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.model_browser.focused_panel, FocusedPanel::Models);

        // Press / to search
        app.handle_key(KeyEvent::from(KeyCode::Char('/')));
        assert!(app.model_browser.is_searching);

        for c in "claude".chars() {
            app.handle_key(KeyEvent::from(KeyCode::Char(c)));
        }
        assert_eq!(app.model_browser.search_query, "claude");

        // Enter finishes typing and focuses Models panel
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(!app.model_browser.is_searching);
        assert_eq!(app.model_browser.focused_panel, FocusedPanel::Models);

        // Cycle sort with s
        app.handle_key(KeyEvent::from(KeyCode::Char('s')));
        assert_eq!(app.model_browser.sort_mode, ModelSortMode::Provider);

        // Press Esc clears search filter
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert_eq!(app.model_browser.search_query, "");

        // Press q exits back to Welcome screen
        app.handle_key(KeyEvent::from(KeyCode::Char('q')));
        assert_eq!(app.screen, ActiveScreen::Welcome);
    }

    #[tokio::test]
    async fn test_provider_search_flow() {
        let mut app = App::new();
        app.welcome_input = "/model".to_string();
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert_eq!(app.screen, ActiveScreen::ModelFlow);

        // Switch to Providers panel
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.model_browser.focused_panel, FocusedPanel::Providers);

        // Press / to search provider
        app.handle_key(KeyEvent::from(KeyCode::Char('/')));
        assert!(app.model_browser.is_searching);

        for c in "openai".chars() {
            app.handle_key(KeyEvent::from(KeyCode::Char(c)));
        }
        assert_eq!(app.model_browser.provider_search, "openai");
        assert_eq!(app.model_browser.provider_index, 1);
        assert_eq!(app.model_browser.selected_provider_id(), Some("openai"));

        // Models panel now filtered to openai models
        let models = app.model_browser.filtered_models();
        assert!(!models.is_empty());
        for m in &models {
            assert_eq!(m.provider_id, "openai");
        }

        // Enter stops search typing but keeps provider selected
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(!app.model_browser.is_searching);
        assert_eq!(app.model_browser.provider_search, "openai");

        // Esc clears provider filter and resets to All
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert_eq!(app.model_browser.provider_search, "");
        assert_eq!(app.model_browser.provider_index, 0);
        assert_eq!(app.model_browser.filtered_models().len(), 6001);
    }

    #[tokio::test]
    async fn test_session_scrolling() {
        let mut app = App::new();
        app.screen = ActiveScreen::Session;
        assert_eq!(app.session_scroll_offset, 0);

        // Press Up scrolls up
        app.handle_key(KeyEvent::from(KeyCode::Up));
        assert_eq!(app.session_scroll_offset, 2);

        // PageUp scrolls up 15 lines
        app.handle_key(KeyEvent::from(KeyCode::PageUp));
        assert_eq!(app.session_scroll_offset, 17);

        // Down scrolls back down
        app.handle_key(KeyEvent::from(KeyCode::Down));
        assert_eq!(app.session_scroll_offset, 15);

        // PageDown scrolls back down
        app.handle_key(KeyEvent::from(KeyCode::PageDown));
        assert_eq!(app.session_scroll_offset, 0);

        // Down at bottom stays at 0
        app.handle_key(KeyEvent::from(KeyCode::Down));
        assert_eq!(app.session_scroll_offset, 0);

        // Mouse scroll
        app.handle_mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::ScrollUp,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.session_scroll_offset, 2);

        // End resets to 0 (when input empty)
        app.handle_key(KeyEvent::from(KeyCode::End));
        assert_eq!(app.session_scroll_offset, 0);
    }

    #[tokio::test]
    async fn test_session_command_dropdown() {
        let mut app = App::new();
        app.screen = ActiveScreen::Session;
        assert_eq!(app.session_input, "");

        // Typing '/' opens the command dropdown
        app.handle_key(KeyEvent::from(KeyCode::Char('/')));
        assert_eq!(app.session_input, "/");
        assert_eq!(app.session_dropdown_index, 0);

        // Pressing Down navigates to next command
        app.handle_key(KeyEvent::from(KeyCode::Down));
        assert_eq!(app.session_dropdown_index, 1);

        // Pressing Up navigates back
        app.handle_key(KeyEvent::from(KeyCode::Up));
        assert_eq!(app.session_dropdown_index, 0);

        // Typing 'm' filters commands
        app.handle_key(KeyEvent::from(KeyCode::Char('m')));
        assert_eq!(app.session_input, "/m");

        // Pressing Tab auto-completes the selected command
        app.handle_key(KeyEvent::from(KeyCode::Tab));
        assert_eq!(app.session_input, "/model ");

        // Pressing Esc clears the input and closes dropdown
        app.session_input = "/".to_string();
        app.session_cursor = 1;
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert_eq!(app.session_input, "");
        assert_eq!(app.screen, ActiveScreen::Session);

        // Executing /clear clears turns
        let mut turn = ConversationTurn::new("1".to_string(), "hello".to_string(), "model".to_string());
        turn.response = "world".to_string();
        turn.streaming = false;
        app.turns.push(turn);
        assert_eq!(app.turns.len(), 1);
        app.session_input = "/clear".to_string();
        app.session_cursor = 6;
        app.handle_key(KeyEvent::from(KeyCode::Enter));
        assert!(app.turns.is_empty());
        assert_eq!(app.session_input, "");
    }

    #[tokio::test]
    async fn test_multiline_session_input_and_navigation() {
        let mut app = App::new();
        app.screen = ActiveScreen::Session;
        app.session_input = "hello world".to_string();
        app.session_cursor = 11;

        // Shift+Enter inserts newline
        let shift_enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT);
        app.handle_key(shift_enter);
        assert_eq!(app.session_input, "hello world\n");
        assert_eq!(app.session_cursor, 12);

        // Type second line
        for c in "next line".chars() {
            app.handle_key(KeyEvent::from(KeyCode::Char(c)));
        }
        assert_eq!(app.session_input, "hello world\nnext line");
        assert_eq!(app.session_cursor, 21);

        // Press Up should move cursor to line 1 (col 9, which is 'r') instead of scrolling chat
        let initial_scroll = app.session_scroll_offset;
        app.handle_key(KeyEvent::from(KeyCode::Up));
        assert_eq!(app.session_scroll_offset, initial_scroll);
        assert_eq!(app.session_cursor, 9); // col 9 on "hello world"

        // Press Up again from line 0 should scroll chat history
        app.handle_key(KeyEvent::from(KeyCode::Up));
        assert_eq!(app.session_scroll_offset, initial_scroll + 2);

        // Press Down moves cursor to line 1
        app.handle_key(KeyEvent::from(KeyCode::Down));
        assert_eq!(app.session_cursor, 12 + 9); // col 9 on "next line" (12 + 9 = 21)

        // Press Down again from last line scrolls chat down
        app.handle_key(KeyEvent::from(KeyCode::Down));
        assert_eq!(app.session_scroll_offset, initial_scroll);
    }
}


