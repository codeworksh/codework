use serde::{Deserialize, Serialize};

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
        request_id: serde_json::Value,
        exit: ExitPayload,
    },
    Chunk {
        #[serde(rename = "requestId")]
        request_id: serde_json::Value,
        values: Vec<serde_json::Value>,
    },
    Defect {
        #[allow(dead_code)]
        defect: Option<serde_json::Value>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "_tag")]
pub enum ExitPayload {
    Success { value: serde_json::Value },
    Failure { cause: Option<serde_json::Value> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DurableMeta {
    #[serde(rename = "aggregateId")]
    pub aggregate_id: String,
    pub seq: u64,
    #[serde(default)]
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogSynced {
    #[serde(rename = "aggregateId")]
    pub aggregate_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventEnvelope {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub durable: Option<DurableMeta>,
    #[serde(rename = "aggregateId", default)]
    pub aggregate_id: Option<String>,
    #[serde(default)]
    pub seq: Option<u64>,
    pub data: Option<serde_json::Value>,
}

impl EventEnvelope {
    #[allow(dead_code)]
    pub fn as_log_synced(&self) -> Option<LogSynced> {
        if self.event_type == "log.synced" {
            Some(LogSynced {
                aggregate_id: self.aggregate_id.clone().unwrap_or_default(),
                seq: self.seq,
            })
        } else {
            None
        }
    }

    pub fn durable_seq(&self) -> Option<u64> {
        self.durable.as_ref().map(|d| d.seq)
    }

    #[allow(dead_code)]
    pub fn cursor_seq(&self) -> Option<u64> {
        if self.event_type == "log.synced" {
            self.seq
        } else {
            self.durable_seq()
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CreateSessionPayload {
    #[serde(rename = "hostDir", skip_serializing_if = "Option::is_none")]
    pub host_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePayload>,
}

#[derive(Debug, Default, Serialize)]
pub struct ListThreadsPayload {
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadRefPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConfigureThreadPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
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
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub text: String,
    pub delivery: &'static str,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadMessagePayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadMessageResponse {
    #[serde(default)]
    pub found: bool,
}
