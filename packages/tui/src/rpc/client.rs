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
    ConfigureSessionPayload, CreateSessionPayload, ExitPayload, ModelRefPayload,
    PromptSessionPayload, RpcAck, RpcRequest, RuntimePayload, ServerMessage,
    SessionHistoryResponse, SessionIdPayload,
};
use crate::types::{HistoryEntry, SessionInfo, UsageReport};

pub const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:7433/rpc/v1";

/// How long to wait between reconnection attempts, and how many to make before
/// giving the turn up. The server outlives this client, so a short window is
/// enough to cover a restart and far short of hanging the UI forever.
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const RECONNECT_ATTEMPTS: u32 = 30;

/// The endpoint to connect to.
///
/// The CLI owns the server lifecycle and names the endpoint it made ready; the
/// TUI only connects. The environment variable is how that endpoint travels, and
/// the default is the address an unmanaged `codework serve` uses.
pub fn server_url() -> String {
    std::env::var("CODEWORK_RPC_SERVER").unwrap_or_else(|_| DEFAULT_SERVER_URL.to_string())
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
    next_id: AtomicU64,
}

impl Default for RpcClient {
    fn default() -> Self {
        Self::new(server_url())
    }
}

impl RpcClient {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            next_id: AtomicU64::new(1),
        }
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
                                            .and_then(|e| e.get("message"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("Execution failed");
                                        let _ =
                                            event_tx.send(StreamEvent::Failed(err_msg.to_string()));
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
                            if id == Some(sub_id) || (prompt_req_id.is_some() && id == prompt_req_id)
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

fn parse_session_info(value: &Value) -> Result<SessionInfo, String> {
    serde_json::from_value::<SessionInfo>(value.clone())
        .map_err(|e| format!("Invalid session response: {e}"))
}

fn parse_session_history(value: &Value) -> Result<Vec<HistoryEntry>, String> {
    serde_json::from_value::<SessionHistoryResponse>(value.clone())
        .map(|res| res.entries)
        .map_err(|e| format!("Invalid session history response: {e}"))
}

fn format_cause(cause: Option<&Value>) -> String {
    let Some(cause) = cause else {
        return "RPC request failed".to_string();
    };
    if let Some(msg) = cause.get("message").and_then(|v| v.as_str()) {
        return msg.to_string();
    }
    if let Some(failure) = cause.get("failure") {
        if let Some(msg) = failure.get("message").and_then(|v| v.as_str()) {
            return msg.to_string();
        }
    }
    cause.to_string()
}

/// Reads a `session.tool.started` payload. Every field is best-effort: a missing
/// or malformed one yields a plain `tool` line rather than an error.
fn started_event(data: &Value) -> StreamEvent {
    let call_id = data.get("callID").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
    let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
    let label = data.get("label").and_then(|v| v.as_str()).map(str::to_string);
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
            StreamEvent::ToolStarted { call_id, name, label, arguments } => {
                assert_eq!(call_id, "call_1");
                assert_eq!(name, "bash");
                assert_eq!(label.as_deref(), Some("bash"));
                assert_eq!(arguments.get("command").and_then(Value::as_str), Some("npm test"));
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
            StreamEvent::ToolSettled { is_error, details, .. } => {
                assert!(is_error);
                assert_eq!(details.and_then(|d| d.get("exitCode").and_then(Value::as_u64)), Some(1));
            }
            other => panic!("expected ToolSettled, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_bare_payload_without_arguments_or_details() {
        // A plugin tool, or an older server: nothing to read, nothing to fail on.
        match started_event(&json!({ "callID": "c", "name": "acme_echo" })) {
            StreamEvent::ToolStarted { arguments, label, .. } => {
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
                assert_eq!(time, &Some(ToolTime { start: 100, end: 150 }));
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
            assert_eq!(req.get("tag").and_then(Value::as_str), Some("session.history"));
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
            if matches!(evt, StreamEvent::Succeeded | StreamEvent::Failed(_) | StreamEvent::Interrupted(_)) {
                break;
            }
        }
        println!("Total events received: {}", events_count);
    }
}
