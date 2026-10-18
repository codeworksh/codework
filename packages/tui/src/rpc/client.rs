use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::rpc::protocol::{
    ConfigureSessionPayload, CreateSessionPayload, ExitPayload, ListModelsPayload, ModelRefPayload,
    PromptSessionPayload, RpcAck, RpcRequest, RuntimePayload, ServerMessage,
    SessionHistoryResponse, SessionIdPayload,
};
use crate::types::{
    HistoryEntry, ModelList, ServerInfo, ServiceRegistration, SessionInfo, UsageReport,
};

pub const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:7433/rpc/v1";

/// How long to wait between reconnection attempts, and how many to make before
/// giving the turn up. The server outlives this client, so a short window is
/// enough to cover a restart and far short of hanging the UI forever.
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const RECONNECT_ATTEMPTS: u32 = 30;

/// Resolve the CodeWork home directory (`CODEWORK_HOME_DIR`, otherwise `~/.codework`).
pub fn codework_home_dir() -> Option<PathBuf> {
    let user_home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from);
    resolve_codework_home(
        std::env::var("CODEWORK_HOME_DIR").ok().as_deref(),
        user_home.as_deref(),
    )
}

pub fn resolve_codework_home(
    env_home: Option<&str>,
    user_home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(raw) = env_home.map(str::trim).filter(|s| !s.is_empty()) {
        if raw == "~" {
            return user_home.map(Path::to_path_buf);
        }
        if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
            if let Some(base) = user_home {
                return Some(base.join(rest));
            }
        }
        return Some(PathBuf::from(raw));
    }
    user_home.map(|base| base.join(".codework"))
}

/// Path to `<home>/service.json`.
pub fn service_json_path(home: &Path) -> PathBuf {
    home.join("service.json")
}

/// Read `<home>/service.json` if present and valid.
pub fn read_service_registration_from(home: &Path) -> Option<ServiceRegistration> {
    let text = std::fs::read_to_string(service_json_path(home)).ok()?;
    let mut reg = serde_json::from_str::<ServiceRegistration>(&text).ok()?;
    reg.url = reg.url.trim().to_string();
    (!reg.url.is_empty()).then_some(reg)
}

/// Read `<home>/service.json` from the active CodeWork home directory.
#[allow(dead_code)]
pub fn read_service_registration() -> Option<ServiceRegistration> {
    let home = codework_home_dir()?;
    read_service_registration_from(&home)
}

/// Resolve the RPC server URL and any matching `<home>/service.json` registration.
///
/// Precedence:
/// 1. `CODEWORK_RPC_SERVER` when set and non-empty (retaining the `service.json` registration
///    when it points at the same endpoint).
/// 2. `<home>/service.json` (`CODEWORK_HOME_DIR` or `~/.codework`).
/// 3. `DEFAULT_SERVER_URL` (`ws://127.0.0.1:7433/rpc/v1`).
pub fn resolve_server_endpoint(
    env_server: Option<&str>,
    home: Option<&Path>,
) -> (String, Option<ServiceRegistration>) {
    let registration = home.and_then(read_service_registration_from);
    if let Some(explicit) = env_server.map(str::trim).filter(|s| !s.is_empty()) {
        let matching_reg = registration.filter(|reg| reg.url == explicit);
        return (explicit.to_string(), matching_reg);
    }
    if let Some(reg) = registration {
        let url = reg.url.clone();
        return (url, Some(reg));
    }
    (DEFAULT_SERVER_URL.to_string(), None)
}

/// The endpoint to connect to.
///
/// Checks `CODEWORK_RPC_SERVER` first, then `<home>/service.json` (`CODEWORK_HOME_DIR` or
/// `~/.codework`), and finally falls back to `DEFAULT_SERVER_URL`.
#[allow(dead_code)]
pub fn server_url() -> String {
    resolve_server_endpoint(
        std::env::var("CODEWORK_RPC_SERVER").ok().as_deref(),
        codework_home_dir().as_deref(),
    )
    .0
}

/// Confirm that the live `server.info` response matches the `<home>/service.json` registration.
pub fn verify_registration(
    expected: &ServiceRegistration,
    actual: &ServerInfo,
) -> Result<(), String> {
    let pid_mismatch = actual.pid != expected.pid;
    let version_mismatch = actual.version != expected.version;
    match (pid_mismatch, version_mismatch) {
        (true, true) => Err(format!(
            "Server at {} reported pid {} (version {}), expected pid {} (version {}) from service.json",
            expected.url, actual.pid, actual.version, expected.pid, expected.version
        )),
        (true, false) => Err(format!(
            "Server at {} reported pid {}, expected pid {} from service.json",
            expected.url, actual.pid, expected.pid
        )),
        (false, true) => Err(format!(
            "Server at {} runs version {}, expected {} from service.json",
            expected.url, actual.version, expected.version
        )),
        (false, false) => Ok(()),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    SessionCreated(SessionInfo),
    TextDelta(String),
    ThinkingDelta(String),
    ToolStarted {
        call_id: String,
        name: String,
        label: Option<String>,
        /// The tool call's raw arguments — the command, path, or query.
        arguments: Value,
    },
    ToolSettled {
        call_id: String,
        name: Option<String>,
        is_error: bool,
        /// The arguments the terminal part carries, repeated from `started`.
        arguments: Value,
        /// Text output returned by the tool in `result.content`.
        output: Option<String>,
        /// The tool's own success/failure struct. Arbitrary JSON: the shape is the
        /// tool's to define, so it is interpreted downstream rather than here.
        details: Option<Value>,
    },
    /// A plugin or runtime warning surfaced during the turn (as ACP's `Feed.notice` does).
    Notice(String),
    Usage(UsageReport),
    Succeeded,
    Failed(String),
    Interrupted(String),
    /// The transport dropped mid-stream. Distinct from `Failed`: the work is not
    /// necessarily over, only the socket is, so the UI shows reconnecting rather
    /// than an error.
    Disconnected,
    /// The server answered again after a `Disconnected`.
    Reconnected,
}

pub struct RpcClient {
    url: String,
    expected: Option<ServiceRegistration>,
    next_id: AtomicU64,
}

impl Default for RpcClient {
    fn default() -> Self {
        let (url, expected) = resolve_server_endpoint(
            std::env::var("CODEWORK_RPC_SERVER").ok().as_deref(),
            codework_home_dir().as_deref(),
        );
        Self {
            url,
            expected,
            next_id: AtomicU64::new(1),
        }
    }
}

impl RpcClient {
    #[allow(dead_code)]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            expected: None,
            next_id: AtomicU64::new(1),
        }
    }

    #[allow(dead_code)]
    pub fn from_registration(reg: ServiceRegistration) -> Self {
        Self {
            url: reg.url.clone(),
            expected: Some(reg),
            next_id: AtomicU64::new(1),
        }
    }

    #[allow(dead_code)]
    pub fn from_home(home: &Path) -> Self {
        let (url, expected) = resolve_server_endpoint(None, Some(home));
        Self {
            url,
            expected,
            next_id: AtomicU64::new(1),
        }
    }

    #[allow(dead_code)]
    pub fn url(&self) -> &str {
        &self.url
    }

    #[allow(dead_code)]
    pub fn expected_registration(&self) -> Option<&ServiceRegistration> {
        self.expected.as_ref()
    }

    fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Perform one request-response RPC call over the WebSocket endpoint.
    async fn call<P: Serialize>(&self, tag: &str, payload: P) -> Result<Value, String> {
        let (ws_stream, _) = connect_async(&self.url)
            .await
            .map_err(|e| format!("Failed to connect to {}: {}", self.url, e))?;

        let (mut write, mut read) = ws_stream.split();
        let req_id = self.next_request_id();
        let req = RpcRequest::new(req_id, tag, payload);
        let mut text = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        text.push('\n');

        write
            .send(Message::Text(text.into()))
            .await
            .map_err(|e| format!("Send error: {}", e))?;

        while let Some(msg_result) = read.next().await {
            let msg = msg_result.map_err(|e| format!("Read error: {}", e))?;
            if let Message::Text(txt) = msg {
                for line in txt.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(parsed) = serde_json::from_str::<ServerMessage>(line) else {
                        continue;
                    };
                    match parsed {
                        ServerMessage::Exit { request_id, exit }
                            if as_request_id(&request_id) == Some(req_id) =>
                        {
                            return match exit {
                                ExitPayload::Success { value } => Ok(value),
                                ExitPayload::Failure { cause } => Err(format_cause(cause.as_ref())),
                            };
                        }
                        ServerMessage::Defect { defect } => {
                            return Err(format_cause(defect.as_ref()));
                        }
                        _ => {}
                    }
                }
            }
        }

        Err("Connection closed before response received".to_string())
    }

    /// Whether this endpoint currently accepts a WebSocket connection.
    #[cfg(test)]
    pub async fn is_server_running(&self) -> bool {
        matches!(
            tokio::time::timeout(Duration::from_millis(1500), connect_async(&self.url)).await,
            Ok(Ok(_))
        )
    }

    /// Probe the server's identity (`server.info` -> `{ pid, version }`).
    pub async fn server_info(&self) -> Result<ServerInfo, String> {
        let value = self.call("server.info", serde_json::json!({})).await?;
        parse_server_info(&value)
    }

    /// Probe `server.info` and, when a `<home>/service.json` registration applies to this
    /// endpoint, confirm that the answering process matches the registered `pid` and `version`.
    pub async fn verify_server(&self) -> Result<ServerInfo, String> {
        let info = self.server_info().await?;
        if let Some(expected) = &self.expected {
            verify_registration(expected, &info)?;
        }
        Ok(info)
    }

    /// Create a session, letting the server pick the default model from settings when `model` is
    /// `None` (matching ACP's `newSession`).
    pub async fn create_session(
        &self,
        host_dir: Option<String>,
        model: Option<(String, String)>,
        thinking_level: Option<String>,
    ) -> Result<SessionInfo, String> {
        let dir = host_dir.or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        });
        let runtime = if model.is_some() || thinking_level.is_some() {
            Some(RuntimePayload {
                model: model.map(|(provider, id)| ModelRefPayload { provider, id }),
                thinking_level,
            })
        } else {
            None
        };
        let value = self
            .call(
                "session.create",
                CreateSessionPayload {
                    host_dir: dir,
                    runtime,
                },
            )
            .await?;
        parse_session_info(&value)
    }

    /// List all sessions on the server (`session.list`).
    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>, String> {
        let value = self.call("session.list", serde_json::json!({})).await?;
        let Some(items) = value.as_array() else {
            return Ok(Vec::new());
        };
        Ok(items
            .iter()
            .filter_map(|item| parse_session_info(item).ok())
            .collect())
    }

    /// List the models available for `host_dir` and the resolved settings default (`model.list`).
    pub async fn list_models(&self, host_dir: Option<&str>) -> Result<ModelList, String> {
        let value = self
            .call("model.list", ListModelsPayload { host_dir })
            .await?;
        parse_model_list(&value)
    }

    /// Fetch a session's current info (`session.info`), used to pick up auto-generated titles.
    pub async fn session_info(&self, session_id: &str) -> Result<SessionInfo, String> {
        let value = self
            .call(
                "session.info",
                SessionIdPayload {
                    session_id: session_id.to_string(),
                },
            )
            .await?;
        parse_session_info(&value)
    }

    /// Fetch a session's active-branch conversation history (`session.history`).
    pub async fn session_history(&self, session_id: &str) -> Result<Vec<HistoryEntry>, String> {
        let value = self
            .call(
                "session.history",
                SessionIdPayload {
                    session_id: session_id.to_string(),
                },
            )
            .await?;
        parse_session_history(&value)
    }

    /// Update a session's model or thinking effort (`session.configure`, matching ACP's
    /// `setConfigOption`).
    pub async fn configure_session(
        &self,
        session_id: &str,
        model: Option<(String, String)>,
        thinking_level: Option<String>,
    ) -> Result<SessionInfo, String> {
        let value = self
            .call(
                "session.configure",
                ConfigureSessionPayload {
                    session_id: session_id.to_string(),
                    runtime: RuntimePayload {
                        model: model.map(|(provider, id)| ModelRefPayload { provider, id }),
                        thinking_level,
                    },
                },
            )
            .await?;
        parse_session_info(&value)
    }

    pub async fn interrupt_session(&self, session_id: &str) -> Result<bool, String> {
        let value = self
            .call(
                "session.interrupt",
                SessionIdPayload {
                    session_id: session_id.to_string(),
                },
            )
            .await?;
        Ok(value
            .get("interrupted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false))
    }

    /// Reload server plugins (`plugin.reload`).
    pub async fn reload_plugins(&self) -> Result<(u64, Option<String>), String> {
        let value = self.call("plugin.reload", serde_json::json!({})).await?;
        let count = value.get("plugins").and_then(|v| v.as_u64()).unwrap_or(0);
        let failure = value
            .get("failure")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        Ok((count, failure))
    }

    /// Stream one prompt, reconnecting the socket when the transport drops.
    ///
    /// The session lives on the server, not this socket, so a dropped connection
    /// is not the end of the turn: the stream is re-established and retried until
    /// it terminates or the server has been gone longer than the grace period.
    /// Every drop is announced as `Disconnected` so the UI can show reconnecting,
    /// and the first event after a retry as `Reconnected` so it can clear it.
    pub async fn prompt_session(
        &self,
        session_id: String,
        prompt_text: String,
        event_tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<(), String> {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        // One stable id regardless of retries, so a prompt re-admitted on a new
        // connection is recognized as the same message rather than a duplicate.
        let prompt_message_id = format!("msg_{}_{}", millis, self.next_request_id());
        let mut prompt_dispatched = false;
        let mut attempt = 0u32;

        loop {
            match self
                .stream_session_once(
                    &session_id,
                    &prompt_text,
                    &prompt_message_id,
                    &mut prompt_dispatched,
                    attempt > 0,
                    &event_tx,
                )
                .await
            {
                Ok(true) => {
                    // Refresh session metadata so an auto-generated title from the first prompt
                    // reaches the UI, matching ACP's `session_info_update`.
                    if let Ok(info) = self.session_info(&session_id).await {
                        let _ = event_tx.send(StreamEvent::SessionCreated(info));
                    }
                    return Ok(());
                }
                Ok(false) => {
                    attempt += 1;
                    if attempt > RECONNECT_ATTEMPTS {
                        let _ = event_tx.send(StreamEvent::Failed(format!(
                            "Lost the connection to {} and could not reconnect",
                            self.url
                        )));
                        return Ok(());
                    }
                    let _ = event_tx.send(StreamEvent::Disconnected);

                    sleep(RECONNECT_DELAY).await;
                }
                Err(message) => {
                    let _ = event_tx.send(StreamEvent::Failed(message));
                    return Ok(());
                }
            }
        }
    }

    /// One connection's worth of a prompt. `Ok(true)` means the turn ended;
    /// `Ok(false)` means the socket dropped and the caller should retry.
    async fn stream_session_once(
        &self,
        session_id: &str,
        prompt_text: &str,
        prompt_message_id: &str,
        prompt_dispatched: &mut bool,
        is_retry: bool,
        event_tx: &mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<bool, String> {
        let (ws_stream, _) = match connect_async(&self.url).await {
            Ok(stream) => stream,
            // The server is not up yet: leave the retry to the reconnect loop.
            Err(_) => return Ok(false),
        };

        let (mut write, mut read) = ws_stream.split();

        // 1. Subscribe to events
        let sub_id = self.next_request_id();
        let sub_req = RpcRequest::new(sub_id, "event.subscribe", serde_json::json!({}));
        let mut sub_text = serde_json::to_string(&sub_req).map_err(|e| e.to_string())?;
        sub_text.push('\n');
        write
            .send(Message::Text(sub_text.into()))
            .await
            .map_err(|e| format!("Failed to subscribe to events: {}", e))?;

        let mut prompt_req_id: Option<u64> = None;
        // On a retry, the first matching event is proof the socket is back.
        let mut reconnected = is_retry;
        let mut notices = std::collections::HashSet::new();

        while let Some(msg_res) = read.next().await {
            let msg = match msg_res {
                Ok(m) => m,
                // A read error is a dropped socket, not a dead turn: retry.
                Err(_) => return Ok(false),
            };

            if let Message::Text(txt) = msg {
                for line in txt.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }

                    let parsed: ServerMessage = match serde_json::from_str(line) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };

                    match parsed {
                        ServerMessage::Chunk { request_id, values } => {
                            if let Some(id_num) = as_request_id(&request_id) {
                                let ack = RpcAck::new(id_num);
                                if let Ok(mut ack_json) = serde_json::to_string(&ack) {
                                    ack_json.push('\n');
                                    let _ = write.send(Message::Text(ack_json.into())).await;
                                }
                            }

                            for env in values {
                                // On server.connected, dispatch prompt if not yet dispatched
                                if env.event_type == "server.connected" && !*prompt_dispatched {
                                    *prompt_dispatched = true;
                                    let prompt_id = self.next_request_id();
                                    prompt_req_id = Some(prompt_id);
                                    let prompt_req = RpcRequest::new(
                                        prompt_id,
                                        "session.prompt",
                                        PromptSessionPayload {
                                            session_id: session_id.to_string(),
                                            text: prompt_text.to_string(),
                                            delivery: "followUp",
                                            id: prompt_message_id.to_string(),
                                        },
                                    );
                                    if let Ok(mut p_json) = serde_json::to_string(&prompt_req) {
                                        p_json.push('\n');
                                        let _ = write.send(Message::Text(p_json.into())).await;
                                    }
                                    continue;
                                }

                                let data = match &env.data {
                                    Some(d) => d,
                                    None => continue,
                                };

                                // Plugin failure notices can be process-wide or session-scoped,
                                // matching ACP's `Feed.notice`.
                                if env.event_type == "plugin.updated" {
                                    let matches_session = data
                                        .get("sessionId")
                                        .and_then(|v| v.as_str())
                                        .is_none_or(|s| s == session_id);
                                    if matches_session
                                        && data.get("status").and_then(|v| v.as_str())
                                            == Some("failed")
                                    {
                                        if let Some(err) =
                                            data.get("error").and_then(|v| v.as_str())
                                        {
                                            if notices.insert(err.to_string()) {
                                                let _ = event_tx
                                                    .send(StreamEvent::Notice(err.to_string()));
                                            }
                                        }
                                    }
                                    continue;
                                }

                                // Verify sessionId matches
                                let s_id = data.get("sessionId").and_then(|v| v.as_str());
                                if s_id != Some(session_id) {
                                    continue;
                                }

                                // The first real event on a retried socket proves the
                                // connection is back; the UI can stop showing reconnecting.
                                if reconnected {
                                    reconnected = false;
                                    let _ = event_tx.send(StreamEvent::Reconnected);
                                }

                                match env.event_type.as_str() {
                                    "session.llm.text.delta" | "session.llm.text-delta" => {
                                        if let Some(delta) =
                                            data.get("delta").and_then(|v| v.as_str())
                                        {
                                            let _ = event_tx
                                                .send(StreamEvent::TextDelta(delta.to_string()));
                                        }
                                    }
                                    "session.llm.thinking.delta" | "session.llm.thinking-delta" => {
                                        if let Some(delta) =
                                            data.get("delta").and_then(|v| v.as_str())
                                        {
                                            let _ = event_tx.send(StreamEvent::ThinkingDelta(
                                                delta.to_string(),
                                            ));
                                        }
                                    }
                                    "session.tool.started" => {
                                        let _ = event_tx.send(started_event(data));
                                    }
                                    "session.tool.settled" => {
                                        let _ = event_tx.send(settled_event(data));
                                    }
                                    "session.llm.ended" => {
                                        if let Some(msg) = data.get("message") {
                                            if let Some(usage) = msg.get("usage") {
                                                let total_tokens = usage
                                                    .get("totalTokens")
                                                    .and_then(|v| v.as_u64())
                                                    .unwrap_or(0);
                                                let input_tokens = usage
                                                    .get("input")
                                                    .and_then(|v| v.as_u64())
                                                    .unwrap_or(0);
                                                let output_tokens = usage
                                                    .get("output")
                                                    .and_then(|v| v.as_u64())
                                                    .unwrap_or(0);
                                                let cost = usage
                                                    .get("cost")
                                                    .and_then(|c| c.get("total"))
                                                    .and_then(|v| v.as_f64())
                                                    .unwrap_or(0.0);
                                                let model = msg
                                                    .get("responseModel")
                                                    .or_else(|| msg.get("model"))
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.to_string());

                                                let _ = event_tx.send(StreamEvent::Usage(
                                                    UsageReport {
                                                        total_tokens,
                                                        input_tokens,
                                                        output_tokens,
                                                        cost,
                                                        model,
                                                    },
                                                ));
                                            }
                                        }
                                    }
                                    "session.execution.succeeded" => {
                                        let _ = event_tx.send(StreamEvent::Succeeded);
                                        return Ok(true);
                                    }
                                    "session.execution.failed" => {
                                        let err_msg = data
                                            .get("error")
                                            .map(|e| format_cause(Some(e)))
                                            .filter(|msg| !msg.is_empty() && msg != "RPC request failed")
                                            .unwrap_or_else(|| "Execution failed".to_string());
                                        let _ = event_tx.send(StreamEvent::Failed(err_msg));
                                        return Ok(true);
                                    }
                                    "session.execution.interrupted" => {
                                        let reason = data
                                            .get("reason")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("Interrupted");
                                        let _ = event_tx
                                            .send(StreamEvent::Interrupted(reason.to_string()));
                                        return Ok(true);
                                    }
                                    _ => {}
                                }
                            }
                        }
                        ServerMessage::Exit {
                            request_id,
                            exit: ExitPayload::Failure { cause },
                        } => {
                            let id = as_request_id(&request_id);
                            if id == Some(sub_id)
                                || (prompt_req_id.is_some() && id == prompt_req_id)
                            {
                                return Err(format_cause(cause.as_ref()));
                            }
                        }
                        ServerMessage::Defect { defect } => {
                            return Err(format_cause(defect.as_ref()));
                        }
                        _ => {}
                    }
                }
            }
        }

        // The socket ended without a terminal event: the server went away mid-turn.
        Ok(false)
    }
}

fn as_request_id(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
}

fn parse_server_info(value: &Value) -> Result<ServerInfo, String> {
    serde_json::from_value::<ServerInfo>(value.clone())
        .map_err(|e| format!("Invalid server.info response: {e}"))
}

fn parse_session_info(value: &Value) -> Result<SessionInfo, String> {
    serde_json::from_value::<SessionInfo>(value.clone())
        .map_err(|e| format!("Invalid session response: {e}"))
}

fn parse_session_history(value: &Value) -> Result<Vec<HistoryEntry>, String> {
    serde_json::from_value::<SessionHistoryResponse>(value.clone())
        .map(|res| res.entries)
        .map_err(|e| format!("Invalid session history response: {e}"))
}

fn parse_model_list(value: &Value) -> Result<ModelList, String> {
    serde_json::from_value::<ModelList>(value.clone())
        .map_err(|e| format!("Invalid model list response: {e}"))
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn format_cause(cause: Option<&Value>) -> String {
    let Some(cause) = cause else {
        return "RPC request failed".to_string();
    };
    match cause {
        Value::Null => "RPC request failed".to_string(),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                "RPC request failed".to_string()
            } else {
                trimmed.to_string()
            }
        }
        Value::Array(items) => {
            for item in items {
                let formatted = format_cause(Some(item));
                if !formatted.is_empty() && formatted != "RPC request failed" {
                    return formatted;
                }
            }
            "RPC request failed".to_string()
        }
        Value::Object(_) => {
            if let Some(tag) = str_field(cause, "_tag") {
                match tag {
                    "Fail" => {
                        if let Some(inner) = cause.get("error").or_else(|| cause.get("failure")) {
                            return format_cause(Some(inner));
                        }
                        return "RPC request failed".to_string();
                    }
                    "Die" => {
                        if let Some(inner) = cause.get("defect") {
                            return format_cause(Some(inner));
                        }
                        return "RPC server defect".to_string();
                    }
                    "Interrupt" => {
                        return "RPC request interrupted".to_string();
                    }
                    _ => return format_tagged_error(tag, cause),
                }
            }
            if let Some(msg) = str_field(cause, "message") {
                return msg.to_string();
            }
            if let Some(inner) = cause
                .get("error")
                .or_else(|| cause.get("failure"))
                .or_else(|| cause.get("defect"))
            {
                return format_cause(Some(inner));
            }
            cause.to_string()
        }
        other => other.to_string(),
    }
}

fn format_tagged_error(tag: &str, err: &Value) -> String {
    match tag {
        "SessionNotFoundError" => match str_field(err, "sessionId") {
            Some(id) => format!("Session not found: {id}"),
            None => "Session not found".to_string(),
        },
        "SessionLinkedSpaceNotFoundError" => match str_field(err, "sessionId") {
            Some(id) => format!("Linked space not found for session {id}"),
            None => "Session linked space not found".to_string(),
        },
        "SessionNotLinkedError" => match str_field(err, "sessionId") {
            Some(id) => format!("Session {id} is not linked to a host directory"),
            None => "Session is not linked to a host directory".to_string(),
        },
        "RelinkError" => {
            let session = str_field(err, "sessionId").unwrap_or("unknown");
            let space = str_field(err, "spaceId").unwrap_or("unknown");
            match str_field(err, "reason") {
                Some("space_not_found") => {
                    format!("Cannot relink session {session}: space {space} not found")
                }
                Some("space_is_archived") => {
                    format!("Cannot relink session {session}: space {space} is archived")
                }
                Some("project_scope_mismatch") => format!(
                    "Cannot relink session {session}: space {space} belongs to a different project"
                ),
                Some("directory_outside_space") => format!(
                    "Cannot relink session {session}: directory is outside space {space}"
                ),
                Some(reason) => {
                    format!("Cannot relink session {session} to space {space}: {reason}")
                }
                None => format!("Cannot relink session {session} to space {space}"),
            }
        }
        "PromptConflictError" => match (str_field(err, "sessionId"), str_field(err, "messageId")) {
            (Some(session), Some(msg)) => {
                format!("Prompt conflict in session {session}: message {msg} already exists")
            }
            (_, Some(msg)) => format!("Prompt conflict: message {msg} already exists"),
            _ => "Prompt conflict: message ID was already used".to_string(),
        },
        "ProjectNotFoundError" => match str_field(err, "projectId") {
            Some(id) => format!("Project not found: {id}"),
            None => "Project not found".to_string(),
        },
        "Location.DirectoryNotFoundError" | "Runner.SandboxDirectoryNotFoundError" => {
            let dir = str_field(err, "directory").unwrap_or("<unknown>");
            match str_field(err, "sandboxInstanceId") {
                Some(sandbox) if sandbox != "local" && sandbox != "sbx_local" => {
                    format!("Directory not found: {dir} (sandbox {sandbox})")
                }
                _ => format!("Directory not found: {dir}"),
            }
        }
        "Location.NotDirectoryError" => {
            let dir = str_field(err, "directory").unwrap_or("<unknown>");
            match str_field(err, "sandboxInstanceId") {
                Some(sandbox) if sandbox != "local" && sandbox != "sbx_local" => {
                    format!("Not a directory: {dir} (sandbox {sandbox})")
                }
                _ => format!("Not a directory: {dir}"),
            }
        }
        "SandboxNotFoundError" => match str_field(err, "id") {
            Some(id) => format!("Sandbox not found: {id}"),
            None => "Sandbox not found".to_string(),
        },
        "SandboxDriverNotRegisteredError" => {
            let driver = str_field(err, "driver").unwrap_or("<unknown>");
            let registered = err
                .get("registered")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|s| !s.is_empty());
            match registered {
                Some(avail) => {
                    format!("Sandbox driver \"{driver}\" is not registered (available: {avail})")
                }
                None => format!("Sandbox driver \"{driver}\" is not registered"),
            }
        }
        "SandboxDriverRegistrationError" => {
            let driver = str_field(err, "driver").unwrap_or("<unknown>");
            match str_field(err, "reason") {
                Some(reason) => format!("Sandbox driver \"{driver}\" error: {reason}"),
                None => format!("Sandbox driver \"{driver}\" registration failed"),
            }
        }
        "SandboxUnsupportedError" => {
            let driver = str_field(err, "driver").unwrap_or("<unknown>");
            let op = str_field(err, "operation").unwrap_or("operation");
            match str_field(err, "id") {
                Some(id) => format!("Sandbox {id} (driver \"{driver}\") does not support {op}"),
                None => format!("Sandbox driver \"{driver}\" does not support {op}"),
            }
        }
        "SandboxProviderError" => {
            let driver = str_field(err, "driver").unwrap_or("<unknown>");
            let op = str_field(err, "operation").unwrap_or("operation");
            let sanitized = err.get("sanitized");
            let msg = sanitized
                .and_then(|s| str_field(s, "message"))
                .or_else(|| str_field(err, "message"));
            let code = sanitized.and_then(|s| str_field(s, "code"));
            match (msg, code) {
                (Some(m), Some(c)) => {
                    format!("Sandbox provider \"{driver}\" failed during {op}: {m} ({c})")
                }
                (Some(m), None) => {
                    format!("Sandbox provider \"{driver}\" failed during {op}: {m}")
                }
                _ => format!("Sandbox provider \"{driver}\" failed during {op}"),
            }
        }
        "SandboxUnavailError" => {
            let id = str_field(err, "id").unwrap_or("<unknown>");
            match str_field(err, "reason") {
                Some(reason) => format!("Sandbox {id} is unavailable: {reason}"),
                None => format!("Sandbox {id} is unavailable"),
            }
        }
        "SandboxRemovedError" => {
            let id = str_field(err, "id").unwrap_or("<unknown>");
            match str_field(err, "removedAt") {
                Some(at) => format!("Sandbox {id} was removed at {at}"),
                None => format!("Sandbox {id} was removed"),
            }
        }
        "SandboxTransitionConflictError" => {
            let id = str_field(err, "id").unwrap_or("<unknown>");
            let actual = str_field(err, "actual").unwrap_or("unknown");
            let expected = err
                .get("expected")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" or ")
                })
                .filter(|s| !s.is_empty());
            match expected {
                Some(exp) => format!("Sandbox {id} is {actual}, expected {exp}"),
                None => format!("Sandbox {id} state conflict (current: {actual})"),
            }
        }
        "SandboxBusyError" => {
            let id = str_field(err, "id").unwrap_or("<unknown>");
            match err.get("refCount").and_then(Value::as_u64) {
                Some(count) => format!("Sandbox {id} is busy ({count} active reference(s))"),
                None => format!("Sandbox {id} is busy"),
            }
        }
        "SandboxMustBeStoppedError" => {
            let id = str_field(err, "id").unwrap_or("<unknown>");
            match str_field(err, "status") {
                Some(status) => format!("Sandbox {id} must be stopped first (status: {status})"),
                None => format!("Sandbox {id} must be stopped first"),
            }
        }
        "SettingsError" => {
            let path = str_field(err, "path");
            let reason = str_field(err, "reason");
            let detail = str_field(err, "detail").or_else(|| str_field(err, "message"));
            match (path, reason, detail) {
                (Some(p), Some(r), Some(d)) => format!("Settings {r} error in {p}: {d}"),
                (Some(p), None, Some(d)) => format!("Settings error in {p}: {d}"),
                (Some(p), Some(r), None) => format!("Settings {r} error in {p}"),
                (None, Some(r), Some(d)) => format!("Settings {r} error: {d}"),
                (_, _, Some(d)) => format!("Settings error: {d}"),
                _ => "Invalid settings file".to_string(),
            }
        }
        "Runner.ModelCatalogError" => {
            let path = str_field(err, "path");
            let reason = str_field(err, "reason");
            let detail = str_field(err, "detail").or_else(|| str_field(err, "message"));
            match (path, reason, detail) {
                (Some(p), Some(r), Some(d)) if !d.contains(p) => {
                    format!("Model catalog {r} ({p}): {d}")
                }
                (_, Some(r), Some(d)) => format!("Model catalog {r}: {d}"),
                (Some(p), Some(r), None) => format!("Model catalog {r}: {p}"),
                (_, None, Some(d)) => format!("Model catalog error: {d}"),
                _ => "Model catalog error".to_string(),
            }
        }
        "Runner.ModelNotFoundError" => match (str_field(err, "provider"), str_field(err, "model")) {
            (Some(provider), Some(model)) => {
                format!("Model \"{provider}/{model}\" not found in catalog")
            }
            _ => str_field(err, "message")
                .unwrap_or("Model not found in catalog")
                .to_string(),
        },
        "Runner.ProviderError" => {
            let provider = str_field(err, "provider");
            let model = str_field(err, "model");
            let reason_msg = err
                .get("reason")
                .and_then(|r| str_field(r, "message"))
                .or_else(|| str_field(err, "message"));
            match (provider, model, reason_msg) {
                (Some(p), Some(m), Some(msg)) => format!("{p}/{m}: {msg}"),
                (Some(p), Some(m), None) => format!("Provider error for {p}/{m}"),
                (_, _, Some(msg)) => msg.to_string(),
                _ => "Provider error".to_string(),
            }
        }
        "Runner.LLMStreamError" => {
            match str_field(err, "reason").or_else(|| str_field(err, "message")) {
                Some(reason) => format!("LLM stream error: {reason}"),
                None => "LLM stream error".to_string(),
            }
        }
        "Server.OAuthError" | "CLI.OAuthError" => match str_field(err, "message") {
            Some(msg) => format!("OAuth error: {msg}"),
            None => "OAuth error".to_string(),
        },
        "SubscriptionOverflowError" => match err.get("capacity").and_then(Value::as_u64) {
            Some(cap) => format!("Event subscription overflowed (capacity: {cap})"),
            None => "Event subscription overflowed".to_string(),
        },
        "EventEncodingError" => {
            let event_type = str_field(err, "type").unwrap_or("<unknown>");
            match err.get("cause") {
                Some(c) if !c.is_null() => {
                    let detail = format_cause(Some(c));
                    if detail != "RPC request failed" {
                        format!("Failed to encode event \"{event_type}\": {detail}")
                    } else {
                        format!("Failed to encode event \"{event_type}\"")
                    }
                }
                _ => format!("Failed to encode event \"{event_type}\""),
            }
        }
        "UnknownEventTypeError" => match str_field(err, "type") {
            Some(t) => format!("Unknown event type: {t}"),
            None => "Unknown event type".to_string(),
        },
        _ => {
            if let Some(msg) = str_field(err, "message") {
                return msg.to_string();
            }
            if let Some(detail) = str_field(err, "detail").or_else(|| str_field(err, "reason")) {
                return format!("{tag}: {detail}");
            }
            tag.to_string()
        }
    }
}

/// Reads a `session.tool.started` payload. Every field is best-effort: a missing
/// or malformed one yields a plain `tool` line rather than an error.
fn started_event(data: &Value) -> StreamEvent {
    let call_id = data
        .get("callID")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let label = data
        .get("label")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let arguments = data.get("arguments").cloned().unwrap_or(Value::Null);
    StreamEvent::ToolStarted {
        call_id,
        name,
        label,
        arguments,
    }
}

/// Reads a `session.tool.settled` payload. The terminal `part` carries both the
/// call's `arguments` and its `result.details`, whose shape is the tool's own
/// (the `edit` tool's `patch` and `firstChangedLine`, a `read`'s line window, a
/// `bash`'s `exitCode`), so it is carried through opaquely.
fn settled_event(data: &Value) -> StreamEvent {
    let call_id = data
        .get("callID")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let part = data.get("part");
    let name = part
        .and_then(|p| p.get("name"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let arguments = part
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or(Value::Null);
    let result = part.and_then(|p| p.get("result"));
    let is_error = result
        .and_then(|r| r.get("isError"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let output = result
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                        block.get("text").and_then(|v| v.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty());
    let details = result.and_then(|r| r.get("details")).cloned();
    StreamEvent::ToolSettled {
        call_id,
        name,
        is_error,
        arguments,
        output,
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_started_call_with_its_arguments() {
        let data = json!({
            "sessionId": "ses_1",
            "messageId": "msg_1",
            "callID": "call_1",
            "name": "bash",
            "label": "bash",
            "arguments": { "command": "npm test", "timeout": 30 },
        });
        match started_event(&data) {
            StreamEvent::ToolStarted {
                call_id,
                name,
                label,
                arguments,
            } => {
                assert_eq!(call_id, "call_1");
                assert_eq!(name, "bash");
                assert_eq!(label.as_deref(), Some("bash"));
                assert_eq!(
                    arguments.get("command").and_then(Value::as_str),
                    Some("npm test")
                );
            }
            other => panic!("expected ToolStarted, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_settled_call_with_its_result_details() {
        let data = json!({
            "sessionId": "ses_1",
            "messageId": "msg_1",
            "callID": "call_1",
            "part": {
                "type": "toolCall",
                "callID": "call_1",
                "name": "edit",
                "arguments": { "path": "src/a.ts", "edits": [] },
                "status": "completed",
                "time": { "start": 1, "end": 2 },
                "result": {
                    "content": [{ "type": "text", "text": "edited" }],
                    "isError": false,
                    "details": { "patch": "--- src/a.ts", "path": "src/a.ts", "firstChangedLine": 3 },
                },
            },
        });
        match settled_event(&data) {
            StreamEvent::ToolSettled {
                call_id,
                name,
                is_error,
                arguments,
                output,
                details,
            } => {
                assert_eq!(call_id, "call_1");
                assert_eq!(name.as_deref(), Some("edit"));
                assert!(!is_error);
                assert_eq!(output.as_deref(), Some("edited"));
                // The arguments ride on the terminal part, so a settled call is titled
                // from them even when no started event arrived.
                assert_eq!(
                    arguments.get("path").and_then(Value::as_str),
                    Some("src/a.ts")
                );
                let details = details.expect("details");
                assert_eq!(
                    details.get("patch").and_then(Value::as_str),
                    Some("--- src/a.ts")
                );
                assert_eq!(
                    details.get("firstChangedLine").and_then(Value::as_u64),
                    Some(3)
                );
            }
            other => panic!("expected ToolSettled, got {other:?}"),
        }
    }

    #[test]
    fn parses_an_error_settlement() {
        let data = json!({
            "callID": "call_2",
            "part": {
                "name": "bash",
                "arguments": { "command": "false" },
                "status": "error",
                "result": {
                    "content": [{ "type": "text", "text": "boom" }],
                    "isError": true,
                    "details": { "output": "boom", "truncated": false, "exitCode": 1 },
                },
            },
        });
        match settled_event(&data) {
            StreamEvent::ToolSettled {
                is_error, details, ..
            } => {
                assert!(is_error);
                assert_eq!(
                    details.and_then(|d| d.get("exitCode").and_then(Value::as_u64)),
                    Some(1)
                );
            }
            other => panic!("expected ToolSettled, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_bare_payload_without_arguments_or_details() {
        // A plugin tool, or an older server: nothing to read, nothing to fail on.
        match started_event(&json!({ "callID": "c", "name": "acme_echo" })) {
            StreamEvent::ToolStarted {
                arguments, label, ..
            } => {
                assert!(arguments.is_null());
                assert!(label.is_none());
            }
            other => panic!("expected ToolStarted, got {other:?}"),
        }

        let settled = json!({
            "callID": "c",
            "part": { "name": "acme_echo", "status": "completed" },
        });
        match settled_event(&settled) {
            StreamEvent::ToolSettled {
                arguments,
                output,
                details,
                is_error,
                name,
                ..
            } => {
                assert!(arguments.is_null());
                assert!(output.is_none());
                assert!(details.is_none());
                assert!(!is_error);
                assert_eq!(name.as_deref(), Some("acme_echo"));
            }
            other => panic!("expected ToolSettled, got {other:?}"),
        }
    }

    #[test]
    fn parses_full_session_info_metadata() {
        let payload = json!({
            "id": "ses_abc",
            "title": "Refactor TUI",
            "directory": "/workspace/codework",
            "hostDir": "/Users/prem/codework",
            "updatedAt": 1_760_614_701_143u64,
            "project": {
                "id": "prj_1",
                "name": "codework"
            },
            "model": {
                "provider": "anthropic",
                "id": "claude-sonnet-4-5"
            },
            "sandbox": {
                "id": "sbx_1",
                "driver": "memory",
                "kind": "virtual",
                "providerResourceId": null,
                "ownership": "managed",
                "status": "online",
                "usage": "busy",
                "refCount": 2,
                "createdAt": "2026-10-16T11:00:00.000Z",
                "updatedAt": "2026-10-16T11:30:00.000Z"
            }
        });

        let info = parse_session_info(&payload).expect("valid SessionInfo");
        assert_eq!(info.id, "ses_abc");
        assert_eq!(info.title, "Refactor TUI");
        assert_eq!(info.directory, "/workspace/codework");
        assert_eq!(info.host_dir.as_deref(), Some("/Users/prem/codework"));
        assert_eq!(info.updated_at, 1_760_614_701_143);
        let project = info.project.expect("project");
        assert_eq!(project.id, "prj_1");
        assert_eq!(project.name, "codework");
        let model = info.model.expect("model");
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.id, "claude-sonnet-4-5");
        let sandbox = info.sandbox.expect("sandbox");
        assert_eq!(sandbox.id, "sbx_1");
        assert_eq!(sandbox.driver, "memory");
        assert_eq!(sandbox.kind, "virtual");
        assert_eq!(sandbox.provider_resource_id, None);
        assert_eq!(sandbox.ownership, "managed");
        assert_eq!(sandbox.status, "online");
        assert_eq!(sandbox.usage, "busy");
        assert_eq!(sandbox.ref_count, 2);
    }

    #[test]
    fn parses_session_history_entries_and_parts() {
        use crate::types::{Part, ToolResultContent, ToolTime};

        let payload = json!({
            "entries": [
                {
                    "id": "msg_u1",
                    "seq": 1,
                    "role": "user",
                    "state": "committed",
                    "createdAt": 1_760_614_700_000u64,
                    "parts": [
                        { "type": "text", "text": "Inspect Cargo.toml" },
                        { "type": "image", "data": "aGVsbG8=", "mimeType": "image/png" }
                    ]
                },
                {
                    "id": "msg_a1",
                    "seq": 2,
                    "role": "assistant",
                    "state": "committed",
                    "createdAt": 1_760_614_701_000u64,
                    "parts": [
                        { "type": "thinking", "thinking": "Reading Cargo.toml first." },
                        {
                            "type": "toolCall",
                            "callID": "call_read_1",
                            "name": "read",
                            "arguments": { "path": "packages/tui/Cargo.toml" },
                            "status": "completed",
                            "result": {
                                "content": [{ "type": "text", "text": "[package]\nname = \"codework-tui\"" }],
                                "isError": false
                            },
                            "time": { "start": 100, "end": 150 }
                        },
                        { "type": "text", "text": "Here is the package manifest." }
                    ]
                }
            ]
        });

        let entries = parse_session_history(&payload).expect("valid history");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "msg_u1");
        assert_eq!(entries[0].role, "user");
        assert_eq!(entries[0].state, "committed");
        assert_eq!(entries[0].parts.len(), 2);
        assert_eq!(
            entries[0].parts[1],
            Part::Image {
                data: "aGVsbG8=".to_string(),
                mime_type: "image/png".to_string(),
            }
        );

        assert_eq!(entries[1].id, "msg_a1");
        assert_eq!(entries[1].role, "assistant");
        assert_eq!(entries[1].parts.len(), 3);
        match &entries[1].parts[1] {
            Part::ToolCall {
                call_id,
                name,
                status,
                result,
                time,
                ..
            } => {
                assert_eq!(call_id, "call_read_1");
                assert_eq!(name, "read");
                assert_eq!(status, "completed");
                assert_eq!(
                    time,
                    &Some(ToolTime {
                        start: 100,
                        end: 150
                    })
                );
                let result = result.as_ref().expect("result");
                assert!(!result.is_error);
                assert_eq!(
                    result.content,
                    vec![ToolResultContent::Text {
                        text: "[package]\nname = \"codework-tui\"".to_string(),
                    }]
                );
            }
            other => panic!("expected ToolCall part, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn session_history_round_trips_over_websocket() {
        use tokio::net::TcpListener;
        use tokio_tungstenite::accept_async;

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws = accept_async(stream).await.expect("ws handshake");
            let Some(Ok(Message::Text(req_text))) = ws.next().await else {
                panic!("expected text request");
            };
            let req: Value = serde_json::from_str(req_text.trim()).expect("json request");
            assert_eq!(
                req.get("tag").and_then(Value::as_str),
                Some("session.history")
            );
            assert_eq!(
                req.get("payload")
                    .and_then(|p| p.get("sessionId"))
                    .and_then(Value::as_str),
                Some("ses_42")
            );
            let req_id = req.get("id").cloned().unwrap_or(json!(1));
            let reply = json!({
                "_tag": "Exit",
                "requestId": req_id,
                "exit": {
                    "_tag": "Success",
                    "value": {
                        "entries": [
                            {
                                "id": "msg_1",
                                "seq": 1,
                                "role": "user",
                                "state": "committed",
                                "createdAt": 1000,
                                "parts": [{ "type": "text", "text": "hello" }]
                            }
                        ]
                    }
                }
            });
            ws.send(Message::Text(format!("{reply}\n").into()))
                .await
                .expect("send reply");
        });

        let client = RpcClient::new(format!("ws://{addr}/rpc/v1"));
        let entries = client.session_history("ses_42").await.expect("history");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "msg_1");
        assert_eq!(entries[0].role, "user");
        server.await.expect("server task");
    }

    #[test]
    fn parses_model_list_response() {
        let payload = json!({
            "providers": [
                {
                    "id": "anthropic",
                    "name": "Anthropic",
                    "models": [
                        {
                            "id": "claude-sonnet-4-5",
                            "name": "Claude Sonnet 4.5",
                            "thinkingLevels": ["off", "low", "medium", "high"]
                        }
                    ]
                }
            ],
            "default": {
                "provider": "openai",
                "id": "gpt-5.6-luna",
                "thinkingLevel": "medium",
                "name": "GPT-5.6 Luna",
                "providerName": "OpenAI"
            }
        });

        let list = parse_model_list(&payload).expect("valid ModelList");
        assert_eq!(list.providers.len(), 1);
        assert_eq!(list.providers[0].id, "anthropic");
        assert_eq!(list.providers[0].name, "Anthropic");
        assert_eq!(list.providers[0].models.len(), 1);
        assert_eq!(list.providers[0].models[0].id, "claude-sonnet-4-5");
        assert_eq!(list.providers[0].models[0].name, "Claude Sonnet 4.5");
        assert_eq!(
            list.providers[0].models[0].thinking_levels,
            vec!["off", "low", "medium", "high"]
        );
        assert_eq!(list.default.provider, "openai");
        assert_eq!(list.default.id, "gpt-5.6-luna");
        assert_eq!(list.default.thinking_level, "medium");
        assert_eq!(list.default.name.as_deref(), Some("GPT-5.6 Luna"));
        assert_eq!(list.default.provider_name.as_deref(), Some("OpenAI"));
    }

    #[tokio::test]
    async fn model_list_round_trips_over_websocket() {
        use tokio::net::TcpListener;
        use tokio_tungstenite::accept_async;

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let server = tokio::spawn(async move {
            for expected_dir in [Some("/Users/prem/codework"), None] {
                let (stream, _) = listener.accept().await.expect("accept");
                let mut ws = accept_async(stream).await.expect("ws handshake");
                let Some(Ok(Message::Text(req_text))) = ws.next().await else {
                    panic!("expected text request");
                };
                let req: Value = serde_json::from_str(req_text.trim()).expect("json request");
                assert_eq!(req.get("tag").and_then(Value::as_str), Some("model.list"));
                let payload = req.get("payload").expect("payload");
                assert_eq!(payload.get("hostDir").and_then(Value::as_str), expected_dir);
                if expected_dir.is_none() {
                    assert!(payload.get("hostDir").is_none());
                }
                let req_id = req.get("id").cloned().unwrap_or(json!(1));
                let reply = json!({
                    "_tag": "Exit",
                    "requestId": req_id,
                    "exit": {
                        "_tag": "Success",
                        "value": {
                            "providers": [
                                {
                                    "id": "local",
                                    "name": "Local",
                                    "models": [
                                        {
                                            "id": "qwen3-coder:30b",
                                            "name": "Qwen3 Coder 30B",
                                            "thinkingLevels": ["off"]
                                        }
                                    ]
                                }
                            ],
                            "default": {
                                "provider": "local",
                                "id": "qwen3-coder:30b",
                                "thinkingLevel": "medium",
                                "name": "Qwen3 Coder 30B",
                                "providerName": "Local"
                            }
                        }
                    }
                });
                ws.send(Message::Text(format!("{reply}\n")))
                    .await
                    .expect("send reply");
            }
        });

        let client = RpcClient::new(format!("ws://{addr}/rpc/v1"));
        let anchored = client
            .list_models(Some("/Users/prem/codework"))
            .await
            .expect("anchored models");
        assert_eq!(anchored.default.provider, "local");
        assert_eq!(anchored.default.id, "qwen3-coder:30b");

        let unanchored = client.list_models(None).await.expect("unanchored models");
        assert_eq!(unanchored.providers.len(), 1);
        assert_eq!(unanchored.providers[0].models[0].id, "qwen3-coder:30b");
        server.await.expect("server task");
    }

    #[test]
    fn resolves_server_endpoint_from_env_or_service_json_or_default() {
        let temp = std::env::temp_dir().join(format!(
            "codework-tui-discovery-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp).expect("temp dir");

        // 1. No env, no service.json -> DEFAULT_SERVER_URL
        let (url, reg) = resolve_server_endpoint(None, Some(&temp));
        assert_eq!(url, DEFAULT_SERVER_URL);
        assert!(reg.is_none());

        // 2. Write `<home>/service.json` -> discovered when CODEWORK_RPC_SERVER is unset
        let service_json = json!({
            "pid": 4242,
            "version": "0.3.0",
            "url": "ws://127.0.0.1:7533/rpc/v1",
            "port": 7533
        });
        std::fs::write(
            service_json_path(&temp),
            serde_json::to_string(&service_json).expect("json"),
        )
        .expect("write service.json");

        let (url, reg) = resolve_server_endpoint(None, Some(&temp));
        assert_eq!(url, "ws://127.0.0.1:7533/rpc/v1");
        assert_eq!(
            reg,
            Some(ServiceRegistration {
                pid: 4242,
                version: "0.3.0".to_string(),
                url: "ws://127.0.0.1:7533/rpc/v1".to_string(),
                port: 7533,
            })
        );

        // 3. Explicit CODEWORK_RPC_SERVER matching service.json keeps the registration
        let (url, reg) = resolve_server_endpoint(Some("ws://127.0.0.1:7533/rpc/v1"), Some(&temp));
        assert_eq!(url, "ws://127.0.0.1:7533/rpc/v1");
        assert!(reg.is_some());

        // 4. Explicit CODEWORK_RPC_SERVER pointing elsewhere overrides service.json without
        //    pinning a mismatched local registration
        let (url, reg) = resolve_server_endpoint(Some("ws://127.0.0.1:9999/rpc/v1"), Some(&temp));
        assert_eq!(url, "ws://127.0.0.1:9999/rpc/v1");
        assert!(reg.is_none());

        // 5. Home resolution expands `~` and defaults to `<HOME>/.codework`
        assert_eq!(
            resolve_codework_home(None, Some(Path::new("/Users/prem"))),
            Some(PathBuf::from("/Users/prem/.codework"))
        );
        assert_eq!(
            resolve_codework_home(Some("~/custom-cw"), Some(Path::new("/Users/prem"))),
            Some(PathBuf::from("/Users/prem/custom-cw"))
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[tokio::test]
    async fn server_info_and_verify_server_confirm_identity_and_reject_mismatches() {
        use tokio::net::TcpListener;
        use tokio_tungstenite::accept_async;

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let url = format!("ws://{addr}/rpc/v1");

        let server = tokio::spawn(async move {
            let responses = [
                (4242u64, "0.3.0"),
                (9999u64, "0.3.0"),
                (4242u64, "0.2.0"),
                (9999u64, "0.2.0"),
            ];
            for (pid, version) in responses {
                let (stream, _) = listener.accept().await.expect("accept");
                let mut ws = accept_async(stream).await.expect("ws handshake");
                let Some(Ok(Message::Text(req_text))) = ws.next().await else {
                    panic!("expected text request");
                };
                let req: Value = serde_json::from_str(req_text.trim()).expect("json request");
                assert_eq!(req.get("tag").and_then(Value::as_str), Some("server.info"));
                let req_id = req.get("id").cloned().unwrap_or(json!(1));
                let reply = json!({
                    "_tag": "Exit",
                    "requestId": req_id,
                    "exit": {
                        "_tag": "Success",
                        "value": {
                            "pid": pid,
                            "version": version
                        }
                    }
                });
                ws.send(Message::Text(format!("{reply}\n").into()))
                    .await
                    .expect("send reply");
            }
        });

        let reg = ServiceRegistration {
            pid: 4242,
            version: "0.3.0".to_string(),
            url: url.clone(),
            port: addr.port(),
        };
        let client = RpcClient::from_registration(reg);

        // 1. Matching pid and version succeeds
        let info = client.verify_server().await.expect("matching server.info");
        assert_eq!(
            info,
            ServerInfo {
                pid: 4242,
                version: "0.3.0".to_string()
            }
        );

        // 2. PID mismatch is surfaced clearly
        let pid_err = client.verify_server().await.expect_err("pid mismatch");
        assert_eq!(
            pid_err,
            format!("Server at {url} reported pid 9999, expected pid 4242 from service.json")
        );

        // 3. Version mismatch is surfaced clearly
        let ver_err = client.verify_server().await.expect_err("version mismatch");
        assert_eq!(
            ver_err,
            format!("Server at {url} runs version 0.2.0, expected 0.3.0 from service.json")
        );

        // 4. Both PID and version mismatch
        let both_err = client.verify_server().await.expect_err("both mismatch");
        assert_eq!(
            both_err,
            format!(
                "Server at {url} reported pid 9999 (version 0.2.0), expected pid 4242 (version 0.3.0) from service.json"
            )
        );

        server.await.expect("server task");
    }

    #[test]
    fn formats_tagged_rpc_errors_and_effect_causes_for_humans() {
        // Effect 4 wire Cause array wrapping a tagged error
        let wrapped_settings = json!([
            {
                "_tag": "Fail",
                "error": {
                    "_tag": "SettingsError",
                    "path": "/Users/prem/.codework/settings.jsonc",
                    "reason": "parse",
                    "detail": "4:10: Unexpected token"
                }
            }
        ]);
        assert_eq!(
            format_cause(Some(&wrapped_settings)),
            "Settings parse error in /Users/prem/.codework/settings.jsonc: 4:10: Unexpected token"
        );

        // Runner.ModelCatalogError
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "Runner.ModelCatalogError",
                "path": "/app/models.gen.json",
                "reason": "missing",
                "detail": "catalog file does not exist"
            }))),
            "Model catalog missing (/app/models.gen.json): catalog file does not exist"
        );

        // Session & Relink & PromptConflict & Project errors
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SessionNotFoundError",
                "sessionId": "ses_404"
            }))),
            "Session not found: ses_404"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SessionLinkedSpaceNotFoundError",
                "sessionId": "ses_404"
            }))),
            "Linked space not found for session ses_404"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "RelinkError",
                "sessionId": "ses_1",
                "spaceId": "spc_2",
                "reason": "project_scope_mismatch"
            }))),
            "Cannot relink session ses_1: space spc_2 belongs to a different project"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "PromptConflictError",
                "sessionId": "ses_1",
                "messageId": "msg_9"
            }))),
            "Prompt conflict in session ses_1: message msg_9 already exists"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "ProjectNotFoundError",
                "projectId": "prj_missing"
            }))),
            "Project not found: prj_missing"
        );

        // Location errors (host vs remote sandbox)
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "Location.DirectoryNotFoundError",
                "directory": "/missing/dir",
                "sandboxInstanceId": "local"
            }))),
            "Directory not found: /missing/dir"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "Location.DirectoryNotFoundError",
                "directory": "/missing/dir",
                "sandboxInstanceId": "sbx_mem1"
            }))),
            "Directory not found: /missing/dir (sandbox sbx_mem1)"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "Location.NotDirectoryError",
                "directory": "/workspace/README.md",
                "sandboxInstanceId": "local"
            }))),
            "Not a directory: /workspace/README.md"
        );

        // Sandbox errors
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxNotFoundError",
                "id": "sbx_missing"
            }))),
            "Sandbox not found: sbx_missing"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxDriverNotRegisteredError",
                "driver": "daytona",
                "registered": ["memory", "sqldb"]
            }))),
            "Sandbox driver \"daytona\" is not registered (available: memory, sqldb)"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxDriverRegistrationError",
                "driver": "local",
                "reason": "providerResourceId is not supported"
            }))),
            "Sandbox driver \"local\" error: providerResourceId is not supported"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxUnsupportedError",
                "id": "sbx_1",
                "driver": "memory",
                "operation": "register"
            }))),
            "Sandbox sbx_1 (driver \"memory\") does not support register"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxProviderError",
                "driver": "daytona",
                "operation": "create",
                "sanitized": {
                    "name": "DaytonaError",
                    "message": "quota exceeded",
                    "code": "E_QUOTA"
                }
            }))),
            "Sandbox provider \"daytona\" failed during create: quota exceeded (E_QUOTA)"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxUnavailError",
                "id": "sbx_1",
                "reason": "container stopped"
            }))),
            "Sandbox sbx_1 is unavailable: container stopped"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxRemovedError",
                "id": "sbx_1",
                "removedAt": "2026-10-17T12:00:00Z"
            }))),
            "Sandbox sbx_1 was removed at 2026-10-17T12:00:00Z"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxTransitionConflictError",
                "id": "sbx_1",
                "expected": ["online", "stopped"],
                "actual": "creating"
            }))),
            "Sandbox sbx_1 is creating, expected online or stopped"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SandboxBusyError",
                "id": "sbx_1",
                "refCount": 3
            }))),
            "Sandbox sbx_1 is busy (3 active reference(s))"
        );

        // OAuth, SubscriptionOverflow, EventEncoding, and Die/Interrupt causes
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "Server.OAuthError",
                "message": "refresh token expired"
            }))),
            "OAuth error: refresh token expired"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "SubscriptionOverflowError",
                "capacity": 4096
            }))),
            "Event subscription overflowed (capacity: 4096)"
        );
        assert_eq!(
            format_cause(Some(&json!({
                "_tag": "EventEncodingError",
                "type": "session.llm.ended",
                "cause": "invalid date"
            }))),
            "Failed to encode event \"session.llm.ended\": invalid date"
        );
        assert_eq!(
            format_cause(Some(&json!([{ "_tag": "Die", "defect": "unexpected panic" }]))),
            "unexpected panic"
        );
        assert_eq!(
            format_cause(Some(&json!([{ "_tag": "Interrupt", "fiberId": 7 }]))),
            "RPC request interrupted"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn test_rpc_flow() {
        let client = RpcClient::new(DEFAULT_SERVER_URL);
        if !client.is_server_running().await {
            println!("Server not running, skipping test");
            return;
        }

        println!("Creating session...");
        let session = client
            .create_session(
                None,
                Some(("google".to_string(), "gemini-2.5-flash".to_string())),
                None,
            )
            .await;
        println!("Session result: {:?}", session);
        let session = match session {
            Ok(s) => s,
            Err(e) => {
                panic!("Failed to create session: {}", e);
            }
        };

        println!("Prompting session {}...", session.id);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let c = RpcClient::new(DEFAULT_SERVER_URL);
        let s_id = session.id.clone();
        tokio::spawn(async move {
            let res = c.prompt_session(s_id, "hello".to_string(), tx).await;
            println!("prompt_session finished: {:?}", res);
        });

        let mut events_count = 0;
        while let Some(evt) = rx.recv().await {
            println!("Got stream event: {:?}", evt);
            events_count += 1;
            if matches!(
                evt,
                StreamEvent::Succeeded | StreamEvent::Failed(_) | StreamEvent::Interrupted(_)
            ) {
                break;
            }
        }
        println!("Total events received: {}", events_count);
    }
}
