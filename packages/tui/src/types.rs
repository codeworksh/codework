use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxInfo {
    pub id: String,
    pub driver: String,
    pub kind: String,
    #[serde(
        rename = "providerResourceId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_resource_id: Option<String>,
    pub ownership: String,
    pub status: String,
    pub usage: String,
    #[serde(rename = "refCount", default)]
    pub ref_count: u64,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub directory: String,
    #[serde(rename = "hostDir", default, skip_serializing_if = "Option::is_none")]
    pub host_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectInfo>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    #[serde(default)]
    pub seq: u64,
    pub role: String,
    #[serde(default = "default_entry_state")]
    pub state: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
    #[serde(default)]
    pub parts: Vec<Part>,
}

fn default_entry_state() -> String {
    "committed".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Part {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    #[serde(rename = "thinking")]
    Thinking {
        thinking: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    #[serde(rename = "toolCall")]
    ToolCall {
        #[serde(rename = "callID")]
        call_id: String,
        name: String,
        #[serde(default)]
        arguments: Value,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<ToolResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        time: Option<ToolTime>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolResult {
    #[serde(default)]
    pub content: Vec<ToolResultContent>,
    #[serde(rename = "isError", default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ToolResultContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolTime {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct UsageReport {
    #[serde(rename = "totalTokens", default)]
    pub total_tokens: u64,
    #[serde(rename = "inputTokens", alias = "input", default)]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens", alias = "output", default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}
