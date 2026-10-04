use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub provider: String,
    pub model: String,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "isDefault", default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelCost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(rename = "cacheRead", skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(rename = "cacheWrite", skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDetails {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub provider_name: String,
    pub env_keys: Vec<String>,
    pub base_url: Option<String>,
    pub npm: Option<String>,
    pub reasoning: bool,
    pub input_modalities: Vec<String>,
    pub cost: Option<ModelCost>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub family: String,
    pub status: String,
    pub docs_url: Option<String>,
    pub released: Option<String>,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
    pub model_count: usize,
    pub env_keys: Vec<String>,
    pub base_url: Option<String>,
    pub npm: Option<String>,
    pub docs_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusedPanel {
    Providers,
    Models,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSortMode {
    Id,
    Provider,
    Cost,
    Context,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ProviderDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub env_keys: &'static [&'static str],
    pub default_model: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageReport {
    #[serde(rename = "totalTokens", default)]
    pub total_tokens: u64,
    #[serde(rename = "inputTokens", default)]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens", default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConversationTurn {
    #[allow(dead_code)]
    pub id: String,
    pub prompt: String,
    pub response: String,
    pub thinking: String,
    pub streaming: bool,
    pub start_time: i64,
    pub end_time: Option<i64>,
    pub tokens: u64,
    pub tokens_per_sec: f64,
    pub model_name: String,
    pub error: Option<String>,
    pub active_tool: Option<String>,
    pub completed_tools: Vec<String>,
}

impl ConversationTurn {
    pub fn new(id: String, prompt: String, model_name: String) -> Self {
        Self {
            id,
            prompt,
            response: String::new(),
            thinking: String::new(),
            streaming: true,
            start_time: chrono::Utc::now().timestamp_millis(),
            end_time: None,
            tokens: 0,
            tokens_per_sec: 0.0,
            model_name,
            error: None,
            active_tool: None,
            completed_tools: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SessionStats {
    pub total_tokens: u64,
    pub cost: f64,
    pub turns_count: usize,
}
