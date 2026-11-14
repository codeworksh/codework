use serde::{Deserialize, Serialize};
use serde_json::Value;

#[allow(unused_imports)]
pub use crate::types::{
    DeltaKind, HistoryEntry, InboxState, LiveDelta, Part, QueuedPrompt, ThreadInfo, ThreadItem,
    ToolResult, ToolResultContent, ToolTime,
};

#[derive(Debug, Serialize)]
pub struct RpcRequest<T> {
    pub _tag: &'static str,
    pub id: u64,
    pub tag: String,
    pub payload: T,
    pub headers: Vec<(String, String)>,
}

impl<T> RpcRequest<T> {
    pub fn new(id: u64, tag: impl Into<String>, payload: T) -> Self {
        Self {
            _tag: "Request",
            id,
            tag: tag.into(),
            payload,
            headers: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcAck {
    pub _tag: &'static str,
    #[serde(rename = "requestId")]
    pub request_id: u64,
}

impl RpcAck {
    pub fn new(request_id: u64) -> Self {
        Self {
            _tag: "Ack",
            request_id,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct RpcInterrupt {
    pub _tag: &'static str,
    #[serde(rename = "requestId")]
    pub request_id: u64,
}

#[allow(dead_code)]
impl RpcInterrupt {
    pub fn new(request_id: u64) -> Self {
        Self {
            _tag: "Interrupt",
            request_id,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "_tag")]
pub enum ServerMessage {
    Exit {
        #[serde(rename = "requestId")]
        request_id: Value,
        exit: ExitPayload,
    },
    Chunk {
        #[serde(rename = "requestId")]
        request_id: Value,
        values: Vec<Value>,
    },
    Defect {
        defect: Option<Value>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "_tag")]
pub enum ExitPayload {
    Success { value: Value },
    Failure { cause: Option<Value> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DurableMeta {
    #[serde(rename = "aggregateId")]
    pub aggregate_id: String,
    pub seq: u64,
    #[serde(default)]
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct EventEnvelope {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub durable: Option<DurableMeta>,
    pub data: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct CreateSessionPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(rename = "hostDir", skip_serializing_if = "Option::is_none")]
    pub host_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePayload>,
}

#[derive(Debug, Serialize)]
pub struct ListThreadsPayload<'a> {
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadRefPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
}

#[derive(Debug, Serialize)]
pub struct ConfigureThreadPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub runtime: RuntimePayload,
}

#[derive(Debug, Serialize)]
pub struct RuntimePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRefPayload>,
    #[serde(rename = "thinkingLevel", skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelRefPayload {
    pub provider: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct PromptThreadPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub text: String,
    pub delivery: &'static str,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadMessagePayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadSyncPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EventSubscribePayload {
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct ListModelsPayload<'a> {
    #[serde(rename = "hostDir", skip_serializing_if = "Option::is_none")]
    pub host_dir: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadHistoryResponse {
    #[serde(default)]
    pub entries: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdatePromptPayload {
    #[serde(flatten)]
    pub address: ThreadRefPayload,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<crate::types::PromptDelivery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForkMode {
    At,
    Before,
}

#[derive(Debug, Serialize)]
pub struct ForkThreadPayload {
    #[serde(flatten)]
    pub address: ThreadRefPayload,
    #[serde(rename = "entryId")]
    pub entry_id: String,
    pub mode: ForkMode,
}

#[derive(Debug, Serialize)]
pub struct PageThreadPayload {
    #[serde(flatten)]
    pub address: ThreadRefPayload,
    pub before: u64,
    pub limit: u64,
}

#[derive(Debug, Deserialize)]
pub struct CancelledResponse {
    pub cancelled: bool,
}
#[derive(Debug, Deserialize)]
pub struct UpdatedResponse {
    pub updated: bool,
}
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ForkResponse {
    pub thread: ThreadInfo,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitDiffPayload<'a> {
    pub plugin: &'static str,
    #[serde(rename = "spaceId")]
    pub space_id: &'a str,
    pub method: &'static str,
    pub input: GitDiffInput<'a>,
}
#[derive(Debug, Serialize)]
pub struct GitDiffInput<'a> {
    pub files: [&'a str; 1],
    pub context: u64,
}
