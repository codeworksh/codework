//! Thread RPC transport. One socket per unary call; one resumable socket per thread sync.
use super::protocol::*;
use crate::event::{AppEvent, RpcEvent};
use crate::types::{
    ModelList, PromptDelivery, ServerInfo, ServiceRegistration, ThreadInfo, ThreadItem,
};
use futures_util::{SinkExt, StreamExt};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
pub const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:7433/rpc/v1";
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

pub fn resolve_codework_home(env_home: Option<&str>, user_home: Option<&Path>) -> Option<PathBuf> {
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
    Item(ThreadItem),
    Info { rev: u64, info: Box<ThreadInfo> },
    Event(EventEnvelope),
    Reset,
    Disconnected,
    Reconnected,
    Failed(String),
}

#[derive(Debug, Default, Clone)]
pub struct SyncCursor {
    pub store_id: Option<String>,
    pub rev: Option<u64>,
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
            .send(Message::Text(text))
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

    pub async fn verify_server(&self) -> Result<ServerInfo, String> {
        let info: ServerInfo = self.request("server.info", serde_json::json!({})).await?;
        if let Some(expected) = &self.expected {
            verify_registration(expected, &info)?;
        }
        Ok(info)
    }

    async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        tag: &str,
        payload: P,
    ) -> Result<R, String> {
        let value = tokio::time::timeout(Duration::from_secs(30), self.call(tag, payload))
            .await
            .map_err(|_| format!("{tag} timed out"))??;
        serde_json::from_value(value).map_err(|e| format!("Invalid {tag} response: {e}"))
    }

    pub async fn create_session(
        &self,
        host_dir: Option<String>,
        model: Option<(String, String)>,
        thinking_level: Option<String>,
    ) -> Result<ThreadInfo, String> {
        self.request(
            "session.create",
            CreateSessionPayload {
                directory: None,
                host_dir,
                runtime: if model.is_some() || thinking_level.is_some() {
                    Some(RuntimePayload {
                        model: model.map(|(provider, id)| ModelRefPayload { provider, id }),
                        thinking_level,
                    })
                } else {
                    None
                },
            },
        )
        .await
    }

    pub async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.request("thread.list", ListThreadsPayload { session_id: None })
            .await
    }

    /// Index commits invalidate the browser's complete thread list, including removals.
    /// Reopening from zero on reconnect avoids maintaining a second index projection.
    pub async fn watch_threads(&self, tx: mpsc::UnboundedSender<AppEvent>, generation: u64) {
        for _ in 0..30 {
            let result = self.watch_index_once(&tx, generation).await;
            if tx.is_closed() {
                return;
            }
            if let Err(error) = result {
                let _ = tx.send(AppEvent::rpc(RpcEvent::ThreadsLoaded {
                    generation,
                    result: Err(format!("Thread browser reconnecting: {error}")),
                }));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    async fn watch_index_once(
        &self,
        tx: &mpsc::UnboundedSender<AppEvent>,
        generation: u64,
    ) -> Result<(), String> {
        let (mut ws, _) = connect_async(&self.url).await.map_err(|e| e.to_string())?;
        let id = self.next_request_id();
        ws.send(Message::Text(
            serde_json::to_string(&RpcRequest::new(
                id,
                "index.sync",
                serde_json::json!({"after":0}),
            ))
            .map_err(|e| e.to_string())?
                + "\n",
        ))
        .await
        .map_err(|e| e.to_string())?;
        while let Some(message) = ws.next().await {
            match message.map_err(|e| e.to_string())? {
                Message::Text(text) => {
                    for line in text.lines().filter(|line| !line.trim().is_empty()) {
                        match serde_json::from_str::<ServerMessage>(line)
                            .map_err(|e| e.to_string())?
                        {
                            ServerMessage::Chunk { request_id, values }
                                if as_request_id(&request_id) == Some(id) =>
                            {
                                if values.iter().any(|value| value["_tag"] == "Synced") {
                                    let threads = self.list_threads().await?;
                                    tx.send(AppEvent::rpc(RpcEvent::ThreadsLoaded {
                                        generation,
                                        result: Ok(threads),
                                    }))
                                    .map_err(|_| "UI closed".to_string())?;
                                }
                                ws.send(Message::Text(
                                    serde_json::to_string(&RpcAck::new(id))
                                        .map_err(|e| e.to_string())?
                                        + "\n",
                                ))
                                .await
                                .map_err(|e| e.to_string())?;
                            }
                            ServerMessage::Exit { request_id, exit }
                                if as_request_id(&request_id) == Some(id) =>
                            {
                                return Err(match exit {
                                    ExitPayload::Failure { cause } => format_cause(cause.as_ref()),
                                    _ => "Index subscription ended".into(),
                                })
                            }
                            ServerMessage::Defect { defect } => {
                                return Err(format_cause(defect.as_ref()))
                            }
                            _ => {}
                        }
                    }
                }
                Message::Ping(bytes) => ws
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|e| e.to_string())?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        Err("Index connection closed".into())
    }

    pub async fn list_models(&self, host_dir: Option<&str>) -> Result<ModelList, String> {
        self.request("model.list", ListModelsPayload { host_dir })
            .await
    }

    pub async fn thread_info(&self, address: ThreadRefPayload) -> Result<ThreadInfo, String> {
        self.request("thread.info", address).await
    }

    pub async fn configure_thread(
        &self,
        address: ThreadRefPayload,
        model: Option<(String, String)>,
        thinking_level: Option<String>,
    ) -> Result<ThreadInfo, String> {
        self.request(
            "thread.configure",
            ConfigureThreadPayload {
                session_id: address.session_id,
                thread_id: address.thread_id,
                runtime: RuntimePayload {
                    model: model.map(|(provider, id)| ModelRefPayload { provider, id }),
                    thinking_level,
                },
            },
        )
        .await
    }

    pub async fn interrupt_thread(&self, address: ThreadRefPayload) -> Result<(), String> {
        self.call("thread.interrupt", address).await.map(|_| ())
    }

    pub async fn reload_plugins(&self) -> Result<(u64, Option<String>), String> {
        let value = self.call("plugin.reload", serde_json::json!({})).await?;
        Ok((
            value["plugins"].as_u64().unwrap_or(0),
            value["failure"].as_str().map(str::to_string),
        ))
    }

    pub async fn send_prompt(
        &self,
        address: ThreadRefPayload,
        text: String,
        delivery: PromptDelivery,
        id: String,
    ) -> Result<(), String> {
        self.call(
            "thread.prompt",
            PromptThreadPayload {
                session_id: address.session_id,
                thread_id: address.thread_id,
                text,
                delivery: delivery.as_str(),
                id,
            },
        )
        .await
        .map(|_| ())
    }

    pub async fn cancel_queued_prompt(
        &self,
        address: ThreadRefPayload,
        message_id: String,
    ) -> Result<bool, String> {
        let reply: CancelledResponse = self
            .request(
                "thread.cancel",
                ThreadMessagePayload {
                    session_id: address.session_id,
                    thread_id: address.thread_id,
                    message_id,
                },
            )
            .await?;
        Ok(reply.cancelled)
    }

    pub async fn update_queued_prompt(
        &self,
        address: ThreadRefPayload,
        message_id: String,
        delivery: Option<PromptDelivery>,
        text: Option<String>,
    ) -> Result<bool, String> {
        let reply: UpdatedResponse = self
            .request(
                "thread.update",
                UpdatePromptPayload {
                    address,
                    message_id,
                    delivery,
                    text,
                },
            )
            .await?;
        Ok(reply.updated)
    }

    pub async fn fork_thread(
        &self,
        address: ThreadRefPayload,
        entry_id: String,
        mode: ForkMode,
    ) -> Result<ForkResponse, String> {
        self.request(
            "thread.fork",
            ForkThreadPayload {
                address,
                entry_id,
                mode,
            },
        )
        .await
    }

    pub async fn page_thread(
        &self,
        address: ThreadRefPayload,
        before: u64,
        limit: u64,
    ) -> Result<Vec<HistoryEntry>, String> {
        let reply: ThreadHistoryResponse = self
            .request(
                "thread.page",
                PageThreadPayload {
                    address,
                    before,
                    limit,
                },
            )
            .await?;
        Ok(reply.entries)
    }

    pub async fn git_diff(&self, space_id: &str, file: &str) -> Result<crate::git::Diff, String> {
        self.request(
            "daemon.call",
            GitDiffPayload {
                plugin: "git",
                space_id,
                method: "diff",
                input: GitDiffInput {
                    files: [file],
                    context: 3,
                },
            },
        )
        .await
    }

    /// Space daemons have no threadId: request their type without a thread filter,
    /// then select the active space from the replay and every subsequent live event.
    pub async fn watch_git(
        &self,
        space_id: String,
        tx: mpsc::UnboundedSender<AppEvent>,
        generation: u64,
    ) {
        for attempt in 0..30 {
            if let Err(error) = self.git_events_once(&space_id, &tx, generation).await {
                if tx.is_closed() {
                    return;
                }
                let _ = tx.send(AppEvent::rpc(RpcEvent::Git {
                    space_id: space_id.clone(),
                    generation,
                    event: crate::git::GitEvent::Disconnected(error),
                }));
            }
            if attempt < 29 {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    async fn git_events_once(
        &self,
        space_id: &str,
        tx: &mpsc::UnboundedSender<AppEvent>,
        generation: u64,
    ) -> Result<(), String> {
        let (mut ws, _) = connect_async(&self.url).await.map_err(|e| e.to_string())?;
        let id = self.next_request_id();
        let payload = EventSubscribePayload {
            thread_id: None,
            types: Some(vec!["plugin.git.status".into()]),
        };
        ws.send(Message::Text(
            serde_json::to_string(&RpcRequest::new(id, "event.subscribe", payload))
                .map_err(|e| e.to_string())?
                + "\n",
        ))
        .await
        .map_err(|e| e.to_string())?;
        let send = |event| {
            tx.send(AppEvent::rpc(RpcEvent::Git {
                space_id: space_id.to_string(),
                generation,
                event,
            }))
            .map_err(|_| "UI closed".to_string())
        };
        while let Some(message) = ws.next().await {
            match message.map_err(|e| e.to_string())? {
                Message::Text(text) => {
                    for line in text.lines().filter(|line| !line.trim().is_empty()) {
                        match serde_json::from_str::<ServerMessage>(line)
                            .map_err(|e| e.to_string())?
                        {
                            ServerMessage::Chunk { request_id, values }
                                if as_request_id(&request_id) == Some(id) =>
                            {
                                for value in values {
                                    let envelope: EventEnvelope =
                                        serde_json::from_value(value).map_err(|e| e.to_string())?;
                                    if envelope.event_type == "server.connected" {
                                        send(crate::git::GitEvent::Connected)?;
                                    } else if envelope.event_type == "plugin.git.status" {
                                        if let Some(data) =
                                            envelope.data.filter(|data| data["spaceId"] == space_id)
                                        {
                                            let status = serde_json::from_value(data)
                                                .map_err(|e| e.to_string())?;
                                            send(crate::git::GitEvent::Status(status))?;
                                        }
                                    }
                                }
                                ws.send(Message::Text(
                                    serde_json::to_string(&RpcAck::new(id))
                                        .map_err(|e| e.to_string())?
                                        + "\n",
                                ))
                                .await
                                .map_err(|e| e.to_string())?;
                            }
                            ServerMessage::Exit { request_id, exit }
                                if as_request_id(&request_id) == Some(id) =>
                            {
                                return Err(match exit {
                                    ExitPayload::Failure { cause } => format_cause(cause.as_ref()),
                                    _ => "Git subscription ended".into(),
                                })
                            }
                            ServerMessage::Defect { defect } => {
                                return Err(format_cause(defect.as_ref()))
                            }
                            _ => {}
                        }
                    }
                }
                Message::Ping(bytes) => ws
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|e| e.to_string())?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        Err("Git status connection closed".into())
    }

    /// Owns a resumable subscription. The app cancels this task when switching threads.
    /// Metadata is refreshed on sync commits; queue/entry/delta ordering stays on one channel.
    pub async fn follow_thread(
        &self,
        address: ThreadRefPayload,
        tx: mpsc::UnboundedSender<AppEvent>,
        generation: u64,
    ) {
        let mut cursor = SyncCursor::default();
        for attempt in 0..30 {
            match self.sync_once(&address, &tx, generation, &mut cursor).await {
                Ok(()) => return,
                Err(error) => {
                    if tx.is_closed() {
                        return;
                    }
                    let _ = tx.send(AppEvent::rpc(RpcEvent::ThreadStream {
                        address: address.clone(),
                        generation,
                        event: if attempt == 29 {
                            StreamEvent::Failed(error)
                        } else {
                            StreamEvent::Disconnected
                        },
                    }));
                    if attempt < 29 {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        }
    }

    async fn sync_once(
        &self,
        address: &ThreadRefPayload,
        tx: &mpsc::UnboundedSender<AppEvent>,
        generation: u64,
        cursor: &mut SyncCursor,
    ) -> Result<(), String> {
        let (mut ws, _) = connect_async(&self.url).await.map_err(|e| e.to_string())?;
        let send = |event| {
            tx.send(AppEvent::rpc(RpcEvent::ThreadStream {
                address: address.clone(),
                generation,
                event,
            }))
            .map_err(|_| "UI closed".to_string())
        };
        // A restarted/replaced server may have reused revisions. Verify its store before resuming.
        if cursor.store_id.is_some() {
            let info = self.verify_server().await?;
            if cursor.store_id.as_deref() != Some(&info.store_id) {
                cursor.rev = None;
                cursor.store_id = None;
                send(StreamEvent::Reset)?;
            }
        }
        let id = self.next_request_id();
        let payload = ThreadSyncPayload {
            session_id: address.session_id.clone(),
            thread_id: address.thread_id.clone(),
            after: cursor.rev,
            budget: None,
        };
        ws.send(Message::Text(
            serde_json::to_string(&RpcRequest::new(id, "thread.sync", payload))
                .map_err(|e| e.to_string())?
                + "\n",
        ))
        .await
        .map_err(|e| e.to_string())?;
        let event_id = self.next_request_id();
        let subscription = EventSubscribePayload {
            thread_id: Some(address.thread_id.clone()),
            types: Some(vec![
                "session.tool.progress".into(),
                "session.retry.scheduled".into(),
                "session.retry.finished".into(),
                "plugin.updated".into(),
            ]),
        };
        ws.send(Message::Text(
            serde_json::to_string(&RpcRequest::new(event_id, "event.subscribe", subscription))
                .map_err(|e| e.to_string())?
                + "\n",
        ))
        .await
        .map_err(|e| e.to_string())?;
        let mut metadata = tokio::task::JoinSet::new();
        send(StreamEvent::Reconnected)?;
        while let Some(message) = ws.next().await {
            match message.map_err(|e| e.to_string())? {
                Message::Text(text) => {
                    for line in text.lines().filter(|s| !s.trim().is_empty()) {
                        match serde_json::from_str::<ServerMessage>(line)
                            .map_err(|e| e.to_string())?
                        {
                            ServerMessage::Chunk { request_id, values }
                                if as_request_id(&request_id) == Some(id) =>
                            {
                                for value in values {
                                    let item: ThreadItem =
                                        serde_json::from_value(value).map_err(|e| e.to_string())?;
                                    if let ThreadItem::Synced { store_id, rev, .. } = &item {
                                        cursor.store_id = Some(store_id.clone());
                                        cursor.rev = Some(*rev);
                                    }
                                    let synced = match &item {
                                        ThreadItem::Synced { rev, .. } => Some(*rev),
                                        _ => None,
                                    };
                                    send(StreamEvent::Item(item))?;
                                    if let Some(rev) = synced {
                                        // Do not block the delta stream on a metadata round trip.
                                        let client = RpcClient::new(&self.url);
                                        let address = address.clone();
                                        let tx = tx.clone();
                                        while metadata.try_join_next().is_some() {}
                                        metadata.spawn(async move {
                                            if let Ok(info) =
                                                client.thread_info(address.clone()).await
                                            {
                                                let _ = tx.send(AppEvent::rpc(
                                                    RpcEvent::ThreadStream {
                                                        address,
                                                        generation,
                                                        event: StreamEvent::Info {
                                                            rev,
                                                            info: Box::new(info),
                                                        },
                                                    },
                                                ));
                                            }
                                        });
                                    }
                                }
                                ws.send(Message::Text(
                                    serde_json::to_string(&RpcAck::new(id))
                                        .map_err(|e| e.to_string())?
                                        + "\n",
                                ))
                                .await
                                .map_err(|e| e.to_string())?;
                            }
                            ServerMessage::Chunk { request_id, values }
                                if as_request_id(&request_id) == Some(event_id) =>
                            {
                                for value in values {
                                    let envelope: EventEnvelope =
                                        serde_json::from_value(value).map_err(|e| e.to_string())?;
                                    send(StreamEvent::Event(envelope))?;
                                }
                                ws.send(Message::Text(
                                    serde_json::to_string(&RpcAck::new(event_id))
                                        .map_err(|e| e.to_string())?
                                        + "\n",
                                ))
                                .await
                                .map_err(|e| e.to_string())?;
                            }
                            ServerMessage::Exit {
                                request_id,
                                exit: ExitPayload::Failure { cause },
                            } if as_request_id(&request_id) == Some(event_id) => {
                                return Err(format_cause(cause.as_ref()))
                            }
                            ServerMessage::Exit { request_id, exit }
                                if as_request_id(&request_id) == Some(id) =>
                            {
                                return match exit {
                                    ExitPayload::Failure { cause } => {
                                        Err(format_cause(cause.as_ref()))
                                    }
                                    ExitPayload::Success { .. } => {
                                        Err("Thread subscription ended".into())
                                    }
                                }
                            }
                            ServerMessage::Defect { defect } => {
                                return Err(format_cause(defect.as_ref()))
                            }
                            _ => {}
                        }
                    }
                }
                Message::Ping(bytes) => ws
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|e| e.to_string())?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        Err("Thread connection closed".into())
    }
}

fn as_request_id(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
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
                Some("directory_outside_space") => {
                    format!("Cannot relink session {session}: directory is outside space {space}")
                }
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
        "Runner.ModelNotFoundError" => {
            match (str_field(err, "provider"), str_field(err, "model")) {
                (Some(provider), Some(model)) => {
                    format!("Model \"{provider}/{model}\" not found in catalog")
                }
                _ => str_field(err, "message")
                    .unwrap_or("Model not found in catalog")
                    .to_string(),
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};
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
            format_cause(Some(
                &json!([{ "_tag": "Die", "defect": "unexpected panic" }])
            )),
            "unexpected panic"
        );
        assert_eq!(
            format_cause(Some(&json!([{ "_tag": "Interrupt", "fiberId": 7 }]))),
            "RPC request interrupted"
        );
    }
}
