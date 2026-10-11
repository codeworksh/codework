use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::rpc::protocol::{
    CreateSessionPayload, ExitPayload, InterruptSessionPayload, ModelRefPayload,
    PromptSessionPayload, RpcAck, RpcRequest, RuntimePayload, ServerMessage,
};
use crate::types::{SessionInfo, UsageReport};

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

#[derive(Debug, Clone)]
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
        /// The tool's own success/failure struct. Arbitrary JSON: the shape is the
        /// tool's to define, so it is interpreted downstream rather than here.
        details: Option<Value>,
    },
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

    /// The endpoint this client connects to.
    pub fn url(&self) -> &str {
        &self.url
    }

    fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Whether this endpoint currently accepts a WebSocket connection.
    pub async fn is_server_running(&self) -> bool {
        match tokio::time::timeout(Duration::from_millis(1500), connect_async(&self.url)).await {
            Ok(Ok(_)) => true,
            _ => false,
        }
    }

    /// Wait, briefly, for the endpoint to answer.
    ///
    /// The CLI has already ensured a server before launching the UI, so this is
    /// only a guard against connecting in the same instant it finishes binding.
    /// It never starts a server: process startup belongs to the CLI alone.
    pub async fn wait_for_server(&self) -> bool {
        for _ in 0..25 {
            if self.is_server_running().await {
                return true;
            }
            sleep(Duration::from_millis(200)).await;
        }
        self.is_server_running().await
    }

    pub async fn create_session(
        &self,
        provider: &str,
        model_id: &str,
        host_dir: Option<String>,
        thinking_level: Option<String>,
    ) -> Result<SessionInfo, String> {
        let (ws_stream, _) = connect_async(&self.url)
            .await
            .map_err(|e| format!("Failed to connect to {}: {}", self.url, e))?;

        let (mut write, mut read) = ws_stream.split();
        let req_id = self.next_request_id();

        let dir = host_dir.unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string())
        });

        let payload = CreateSessionPayload {
            host_dir: dir,
            runtime: RuntimePayload {
                model: ModelRefPayload {
                    provider: provider.to_string(),
                    id: model_id.to_string(),
                },
                thinking_level,
            },
        };

        let req = RpcRequest::new(req_id, "session.create", payload);
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
                    let parsed: ServerMessage = match serde_json::from_str(line) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };

                    if let ServerMessage::Exit { request_id, exit } = parsed {
                        let matches = match request_id {
                            serde_json::Value::Number(n) => n.as_u64() == Some(req_id),
                            serde_json::Value::String(s) => s.parse::<u64>().ok() == Some(req_id),
                            _ => false,
                        };

                        if matches {
                            match exit {
                                ExitPayload::Success { value } => {
                                    let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    let title = value.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    let directory = value.get("directory").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    return Ok(SessionInfo { id, title, directory });
                                }
                                ExitPayload::Failure { cause } => {
                                    return Err(format!("RPC Failure: {:?}", cause));
                                }
                            }
                        }
                    }
                }
            }
        }

        Err("Connection closed before response received".to_string())
    }

    pub async fn interrupt_session(&self, session_id: &str) -> Result<bool, String> {
        let (ws_stream, _) = connect_async(&self.url)
            .await
            .map_err(|e| format!("Failed to connect: {}", e))?;

        let (mut write, mut read) = ws_stream.split();
        let req_id = self.next_request_id();

        let req = RpcRequest::new(
            req_id,
            "session.interrupt",
            InterruptSessionPayload {
                session_id: session_id.to_string(),
            },
        );
        let mut text = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        text.push('\n');

        write
            .send(Message::Text(text.into()))
            .await
            .map_err(|e| e.to_string())?;

        while let Some(msg_result) = read.next().await {
            let msg = msg_result.map_err(|e| e.to_string())?;
            if let Message::Text(txt) = msg {
                for line in txt.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(ServerMessage::Exit { exit, .. }) = serde_json::from_str::<ServerMessage>(line) {
                        if let ExitPayload::Success { value } = exit {
                            let interrupted = value.get("interrupted").and_then(|v| v.as_bool()).unwrap_or(false);
                            return Ok(interrupted);
                        }
                    }
                }
            }
        }
        Ok(false)
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
        let mut attempt = 0u32;
        loop {
            match self
                .stream_session_once(&session_id, &prompt_text, attempt > 0, &event_tx)
                .await
            {
                Ok(true) => return Ok(()),
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

        // One stable id regardless of retries, so a prompt re-admitted on a new
        // connection is recognized as the same message rather than a duplicate.
        let prompt_message_id = format!("msg_{}", chrono::Utc::now().timestamp_millis());
        // A retry must not re-admit the prompt: it may still be running server-side,
        // and re-sending it would collide. The subscription alone re-attaches us to
        // the events for the work already in flight.
        let mut prompt_dispatched = is_retry;
        // On a retry, the first matching event is proof the socket is back.
        let mut reconnected = is_retry;

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
                            // Send Ack for chunk with \n
                            if let Some(id_num) = request_id.as_u64() {
                                let ack = RpcAck::new(id_num);
                                if let Ok(mut ack_json) = serde_json::to_string(&ack) {
                                    ack_json.push('\n');
                                    let _ = write.send(Message::Text(ack_json.into())).await;
                                }
                            }

                            for env in values {
                                // On server.connected, dispatch prompt
                                if env.event_type == "server.connected" && !prompt_dispatched {
                                    prompt_dispatched = true;
                                    let prompt_id = self.next_request_id();
                                    let prompt_req = RpcRequest::new(
                                        prompt_id,
                                        "session.prompt",
                                        PromptSessionPayload {
                                            session_id: session_id.to_string(),
                                            text: prompt_text.to_string(),
                                            delivery: "followUp",
                                            id: prompt_message_id.clone(),
                                        },
                                    );
                                    if let Ok(mut p_json) = serde_json::to_string(&prompt_req) {
                                        p_json.push('\n');
                                        let _ = write.send(Message::Text(p_json.into())).await;
                                    }
                                    continue;
                                }

                                // Verify sessionId matches
                                let data = match &env.data {
                                    Some(d) => d,
                                    None => continue,
                                };

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
                                        if let Some(delta) = data.get("delta").and_then(|v| v.as_str()) {
                                            let _ = event_tx.send(StreamEvent::TextDelta(delta.to_string()));
                                        }
                                    }
                                    "session.llm.thinking.delta" | "session.llm.thinking-delta" => {
                                        if let Some(delta) = data.get("delta").and_then(|v| v.as_str()) {
                                            let _ = event_tx.send(StreamEvent::ThinkingDelta(delta.to_string()));
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
                                                let total_tokens = usage.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                                let input_tokens = usage.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
                                                let output_tokens = usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
                                                let cost = usage.get("cost").and_then(|c| c.get("total")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                                                let model = msg.get("responseModel").or_else(|| msg.get("model")).and_then(|v| v.as_str()).map(|s| s.to_string());

                                                let _ = event_tx.send(StreamEvent::Usage(UsageReport {
                                                    total_tokens,
                                                    input_tokens,
                                                    output_tokens,
                                                    cost,
                                                    model,
                                                }));
                                            }
                                        }
                                    }
                                    "session.execution.succeeded" => {
                                        let _ = event_tx.send(StreamEvent::Succeeded);
                                        return Ok(true);
                                    }
                                    "session.execution.failed" => {
                                        let err_msg = data.get("error").and_then(|e| e.get("message")).and_then(|v| v.as_str()).unwrap_or("Execution failed");
                                        let _ = event_tx.send(StreamEvent::Failed(err_msg.to_string()));
                                        return Ok(true);
                                    }
                                    "session.execution.interrupted" => {
                                        let reason = data.get("reason").and_then(|v| v.as_str()).unwrap_or("Interrupted");
                                        let _ = event_tx.send(StreamEvent::Interrupted(reason.to_string()));
                                        return Ok(true);
                                    }
                                    _ => {}
                                }
                            }
                        }
                        ServerMessage::Exit { .. } => {}
                        _ => {}
                    }
                }
            }
        }

        // The socket ended without a terminal event: the server went away mid-turn.
        Ok(false)
    }
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
    let call_id = data.get("callID").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
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
    let details = result.and_then(|r| r.get("details")).cloned();
    StreamEvent::ToolSettled {
        call_id,
        name,
        is_error,
        arguments,
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
            StreamEvent::ToolSettled { call_id, name, is_error, arguments, details } => {
                assert_eq!(call_id, "call_1");
                assert_eq!(name.as_deref(), Some("edit"));
                assert!(!is_error);
                // The arguments ride on the terminal part, so a settled call is titled
                // from them even when no started event arrived.
                assert_eq!(arguments.get("path").and_then(Value::as_str), Some("src/a.ts"));
                let details = details.expect("details");
                assert_eq!(details.get("patch").and_then(Value::as_str), Some("--- src/a.ts"));
                assert_eq!(details.get("firstChangedLine").and_then(Value::as_u64), Some(3));
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
            StreamEvent::ToolSettled { arguments, details, is_error, name, .. } => {
                assert!(arguments.is_null());
                assert!(details.is_none());
                assert!(!is_error);
                assert_eq!(name.as_deref(), Some("acme_echo"));
            }
            other => panic!("expected ToolSettled, got {other:?}"),
        }
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
        let session = client.create_session("google", "gemini-2.5-flash", None, None).await;
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
