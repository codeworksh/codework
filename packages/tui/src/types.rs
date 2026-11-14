use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub pid: u64,
    pub version: String,
    #[serde(rename = "storeId", default)]
    pub store_id: String,
    #[serde(default)]
    pub rev: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceRegistration {
    pub pid: u64,
    pub version: String,
    pub url: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum PromptDelivery {
    #[serde(rename = "steer")]
    #[default]
    Steer,
    #[serde(rename = "followUp")]
    FollowUp,
}

impl PromptDelivery {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "followUp",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "follow-up",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    #[serde(rename = "thinkingLevels", default)]
    pub thinking_levels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub models: Vec<ModelOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DefaultModel {
    pub provider: String,
    pub id: String,
    #[serde(rename = "thinkingLevel", default)]
    pub thinking_level: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        rename = "providerName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ModelList {
    #[serde(default)]
    pub providers: Vec<ModelProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<DefaultModel>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SessionInfo {
    pub id: String,
    #[serde(rename = "spaceId", default)]
    pub space_id: String,
    #[serde(default)]
    pub slug: String,
    pub directory: String,
    #[serde(rename = "hostDir", default, skip_serializing_if = "Option::is_none")]
    pub host_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, String>>,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
    #[serde(rename = "mainThreadId", default)]
    pub main_thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind")]
pub enum ThreadOrigin {
    #[serde(rename = "main")]
    #[default]
    Main,
    #[serde(rename = "fork")]
    Fork {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "entryId")]
        entry_id: String,
        #[serde(default)]
        cut: u64,
    },
    #[serde(rename = "subagent")]
    Subagent {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(rename = "entryId", default, skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cut: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ThreadUsage {
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(rename = "cacheRead", default)]
    pub cache_read: u64,
    #[serde(rename = "cacheWrite", default)]
    pub cache_write: u64,
}

impl ThreadUsage {
    pub fn total_tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ThreadRun {
    #[serde(rename = "startedAt", default)]
    pub started_at: u64,
    #[serde(rename = "endedAt", default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadPlacement {
    #[serde(rename = "spaceId")]
    pub space_id: String,
    pub directory: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadInfo {
    pub id: String,
    #[serde(default)]
    pub origin: ThreadOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    #[serde(
        rename = "thinkingLevel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foundation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<ThreadPlacement>,
    #[serde(default)]
    pub usage: ThreadUsage,
    #[serde(rename = "runState", default = "default_run_state")]
    pub run_state: String,
    #[serde(
        rename = "runStateAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub run_state_at: Option<u64>,
    #[serde(rename = "lastRun", default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<ThreadRun>,
    #[serde(default)]
    pub parked: bool,
    #[serde(default)]
    pub restarts: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u64>,
    #[serde(rename = "createdSeq", default)]
    pub created_seq: u64,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
    pub session: SessionInfo,
}

fn default_run_state() -> String {
    "idle".to_string()
}

impl ThreadInfo {
    /// Display title for headers and menus: `thread.title` when present and non-empty,
    /// falling back to `thread.session.slug`, then `thread.id`.
    pub fn display_title(&self) -> &str {
        self.title
            .as_deref()
            .filter(|t| !t.is_empty())
            .or_else(|| (!self.session.slug.is_empty()).then_some(self.session.slug.as_str()))
            .or_else(|| (!self.id.is_empty()).then_some(self.id.as_str()))
            .unwrap_or("session")
    }

    pub fn is_running(&self) -> bool {
        self.run_state != "idle"
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    #[serde(rename = "threadId", default)]
    pub thread_id: String,
    #[serde(default)]
    pub seq: u64,
    pub role: String,
    #[serde(default = "default_entry_state")]
    pub state: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
    #[serde(default)]
    pub parts: Vec<Part>,
    #[serde(default)]
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_entry_state() -> String {
    "committed".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedPrompt {
    pub id: String,
    #[serde(default)]
    pub delivery: PromptDelivery,
    pub text: String,
    #[serde(rename = "admittedSeq", default)]
    pub admitted_seq: u64,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InboxState {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "promoted")]
    Promoted,
    #[serde(rename = "cancelled")]
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeltaKind {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "thinking")]
    Thinking,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveDelta {
    #[serde(rename = "entryId")]
    pub entry_id: String,
    #[serde(rename = "partIndex")]
    pub part_index: usize,
    pub kind: DeltaKind,
    pub offset: usize,
    pub delta: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum ThreadItem {
    Entry {
        entry: HistoryEntry,
        #[serde(default)]
        rev: u64,
    },
    Inbox {
        prompt: QueuedPrompt,
        state: InboxState,
        #[serde(default)]
        rev: u64,
    },
    Synced {
        #[serde(rename = "storeId", default)]
        store_id: String,
        #[serde(default)]
        rev: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor: Option<u64>,
    },
    Delta {
        delta: LiveDelta,
    },
}

impl ThreadItem {
    pub fn rev(&self) -> Option<u64> {
        match self {
            Self::Entry { rev, .. } | Self::Inbox { rev, .. } | Self::Synced { rev, .. } => {
                Some(*rev)
            }
            Self::Delta { .. } => None,
        }
    }
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
