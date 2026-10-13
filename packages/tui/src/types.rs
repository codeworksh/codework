use serde::{Deserialize, Serialize};

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
