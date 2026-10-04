use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::rpc::protocol::{
    CreateSessionPayload, ExitPayload, InterruptSessionPayload, ModelRefPayload,
    PromptSessionPayload, RpcAck, RpcRequest, RuntimePayload, ServerMessage,
};
use crate::types::{SessionInfo, UsageReport};

pub const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:7433/rpc";

#[derive(Debug, Clone)]
pub enum StreamEvent {
    SessionCreated(SessionInfo),
    TextDelta(String),
    ThinkingDelta(String),
    ToolStarted { name: String, label: Option<String> },
    ToolSettled { name: String },
    Usage(UsageReport),
    Succeeded,
    Failed(String),
    Interrupted(String),
}

pub struct RpcClient {
    url: String,
    next_id: AtomicU64,
}

impl Default for RpcClient {
    fn default() -> Self {
        Self::new(DEFAULT_SERVER_URL)
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

    pub async fn is_server_running(&self) -> bool {
        match tokio::time::timeout(Duration::from_millis(1500), connect_async(&self.url)).await {
            Ok(Ok(_)) => true,
            _ => false,
        }
    }

    pub async fn ensure_server_running(&self) -> bool {
        if self.is_server_running().await {
            return true;
        }

        // Try to spawn codework serve
        let candidates = [
            PathBuf::from("packages/codework/src/index.ts"),
            PathBuf::from("../codework/src/index.ts"),
        ];

        let entry = candidates.iter().find(|p| p.exists());
        if let Some(entry_path) = entry {
            let _ = Command::new("node")
                .arg(entry_path)
                .arg("serve")
                .spawn();

            for _ in 0..25 {
                sleep(Duration::from_millis(200)).await;
                if self.is_server_running().await {
                    return true;
                }
            }
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

    pub async fn prompt_session(
        &self,
        session_id: String,
        prompt_text: String,
        event_tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<(), String> {
        let (ws_stream, _) = connect_async(&self.url)
            .await
            .map_err(|e| format!("Failed to connect to {}: {}", self.url, e))?;

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

        let prompt_message_id = format!("msg_{}", chrono::Utc::now().timestamp_millis());
        let mut prompt_dispatched = false;

        while let Some(msg_res) = read.next().await {
            let msg = match msg_res {
                Ok(m) => m,
                Err(e) => {
                    let _ = event_tx.send(StreamEvent::Failed(format!("WS read error: {}", e)));
                    break;
                }
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
                                            session_id: session_id.clone(),
                                            text: prompt_text.clone(),
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
                                if s_id != Some(&session_id) {
                                    continue;
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
                                        let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
                                        let label = data.get("label").and_then(|v| v.as_str()).map(|s| s.to_string());
                                        let _ = event_tx.send(StreamEvent::ToolStarted { name, label });
                                    }
                                    "session.tool.settled" => {
                                        let name = data.get("callID").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
                                        let _ = event_tx.send(StreamEvent::ToolSettled { name });
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
                                        return Ok(());
                                    }
                                    "session.execution.failed" => {
                                        let err_msg = data.get("error").and_then(|e| e.get("message")).and_then(|v| v.as_str()).unwrap_or("Execution failed");
                                        let _ = event_tx.send(StreamEvent::Failed(err_msg.to_string()));
                                        return Ok(());
                                    }
                                    "session.execution.interrupted" => {
                                        let reason = data.get("reason").and_then(|v| v.as_str()).unwrap_or("Interrupted");
                                        let _ = event_tx.send(StreamEvent::Interrupted(reason.to_string()));
                                        return Ok(());
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

        let _ = event_tx.send(StreamEvent::Succeeded);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
