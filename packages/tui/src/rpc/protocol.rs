use serde::{Deserialize, Serialize};

#[allow(unused_imports)]
pub use crate::types::{HistoryEntry, Part, ToolResult, ToolResultContent, ToolTime};

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
        values: Vec<EventEnvelope>,
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

#[derive(Debug, Clone, Deserialize)]
pub struct EventEnvelope {
    #[allow(dead_code)]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct CreateSessionPayload {
    #[serde(rename = "hostDir", skip_serializing_if = "Option::is_none")]
    pub host_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePayload>,
}

#[derive(Debug, Serialize)]
pub struct ConfigureSessionPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
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
pub struct PromptSessionPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub text: String,
    pub delivery: &'static str, // "followUp"
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct SessionIdPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Serialize)]
pub struct ListModelsPayload<'a> {
    #[serde(rename = "hostDir", skip_serializing_if = "Option::is_none")]
    pub host_dir: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionHistoryResponse {
    #[serde(default)]
    pub entries: Vec<HistoryEntry>,
}
