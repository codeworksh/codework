use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use crate::credentials::{get_codework_dir, CredentialStore};
use crate::types::{ModelCost, ModelDetails, ModelEntry, ProviderDefinition, ProviderSummary};

static CATALOG_JSON: OnceLock<Option<serde_json::Value>> = OnceLock::new();
static ALL_MODELS: OnceLock<Vec<ModelDetails>> = OnceLock::new();
static ALL_PROVIDERS: OnceLock<Vec<ProviderSummary>> = OnceLock::new();

fn get_catalog_data() -> Option<&'static serde_json::Value> {
    CATALOG_JSON.get_or_init(|| {
        let mut candidates = Vec::new();
        if let Ok(p) = std::env::var("CODEWORK_MODELS_FILE") {
            candidates.push(PathBuf::from(p));
        }
        candidates.push(get_codework_dir().join("models.gen.json"));
        candidates.push(PathBuf::from("packages/aikit/models.gen.json"));
        candidates.push(PathBuf::from("../aikit/models.gen.json"));
        candidates.push(PathBuf::from("models.gen.json"));
        candidates.push(PathBuf::from("../models.gen.json"));
        candidates.push(PathBuf::from("../../models.gen.json"));
        candidates.push(PathBuf::from("packages/codework/.codework/models.gen.json"));

        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("packages/aikit/models.gen.json"));
            candidates.push(cwd.join("models.gen.json"));
            candidates.push(cwd.join("../models.gen.json"));
            candidates.push(cwd.join("../../models.gen.json"));
            candidates.push(cwd.join(".codework/models.gen.json"));
            candidates.push(cwd.join("../packages/aikit/models.gen.json"));
        }

        for path in candidates {
            if path.exists() {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                        return Some(val);
                    }
                }
            }
        }
        None
    }).as_ref()
}

pub fn get_all_models() -> &'static [ModelDetails] {
    ALL_MODELS.get_or_init(|| {
        let mut list = Vec::new();
        if let Some(root) = get_catalog_data().and_then(|v| v.as_object()) {
            for (prov_id, prov_val) in root {
                if let Some(models_map) = prov_val.as_object() {
                    for (model_key, model_val) in models_map {
                        let id = model_val
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or(model_key)
                            .to_string();
                        let name = model_val
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&id)
                            .to_string();

                        let (provider_id, provider_name, env_keys) = if let Some(p) = model_val.get("provider").and_then(|v| v.as_object()) {
                            let p_id = p.get("id").and_then(|v| v.as_str()).unwrap_or(prov_id).to_string();
                            let p_name = p.get("name").and_then(|v| v.as_str()).unwrap_or(&p_id).to_string();
                            let env = if let Some(arr) = p.get("env").and_then(|v| v.as_array()) {
                                arr.iter().filter_map(|e| e.as_str().map(|s| s.to_string())).collect()
                            } else {
                                default_env_for_provider(&p_id)
                            };
                            (p_id, p_name, env)
                        } else {
                            (prov_id.to_string(), prov_id.to_string(), default_env_for_provider(prov_id))
                        };

                        let base_url = model_val
                            .get("baseUrl")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());

                        let npm = model_val
                            .get("npm")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());

                        let reasoning = model_val
                            .get("reasoning")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        let input_modalities: Vec<String> = if let Some(arr) = model_val.get("input").and_then(|v| v.as_array()) {
                            arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()
                        } else {
                            vec!["text".to_string()]
                        };

                        let cost = model_val.get("cost").and_then(|c| {
                            let input = c.get("input").and_then(|v| v.as_f64());
                            let output = c.get("output").and_then(|v| v.as_f64());
                            let cache_read = c.get("cacheRead").and_then(|v| v.as_f64());
                            let cache_write = c.get("cacheWrite").and_then(|v| v.as_f64());
                            if input.is_some() || output.is_some() || cache_read.is_some() || cache_write.is_some() {
                                Some(ModelCost { input, output, cache_read, cache_write })
                            } else {
                                None
                            }
                        });

                        let context_window = model_val.get("contextWindow").and_then(|v| v.as_u64());
                        let max_tokens = model_val.get("maxTokens").and_then(|v| v.as_u64());
                        let family = infer_family(&id, &name);
                        let docs_url = Some(docs_url_for_provider(&provider_id, base_url.as_deref()));
                        let released = extract_date(&id).or_else(|| extract_date(&name));
                        let updated = released.clone();

                        list.push(ModelDetails {
                            id,
                            name,
                            provider_id,
                            provider_name,
                            env_keys,
                            base_url,
                            npm,
                            reasoning,
                            input_modalities,
                            cost,
                            context_window,
                            max_tokens,
                            family,
                            status: "active".to_string(),
                            docs_url,
                            released,
                            updated,
                        });
                    }
                }
            }
        }
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    })
}

pub fn get_all_providers() -> &'static [ProviderSummary] {
    ALL_PROVIDERS.get_or_init(|| {
        let models = get_all_models();
        let mut map: std::collections::BTreeMap<String, (String, usize, Vec<String>, Option<String>, Option<String>, Option<String>)> = std::collections::BTreeMap::new();

        for m in models {
            let entry = map.entry(m.provider_id.clone()).or_insert_with(|| {
                (
                    m.provider_name.clone(),
                    0,
                    m.env_keys.clone(),
                    m.base_url.clone(),
                    m.npm.clone(),
                    m.docs_url.clone(),
                )
            });
            entry.1 += 1;
            if entry.3.is_none() && m.base_url.is_some() {
                entry.3 = m.base_url.clone();
            }
            if entry.4.is_none() && m.npm.is_some() {
                entry.4 = m.npm.clone();
            }
        }

        let mut providers = Vec::new();
        for (id, (name, count, env_keys, base_url, npm, docs_url)) in map {
            providers.push(ProviderSummary {
                id,
                name,
                model_count: count,
                env_keys,
                base_url,
                npm,
                docs_url,
            });
        }
        providers.sort_by(|a, b| a.id.cmp(&b.id));
        providers
    })
}

pub fn default_env_for_provider(provider_id: &str) -> Vec<String> {
    match provider_id {
        "google" => vec!["GEMINI_API_KEY".to_string(), "GOOGLE_GENERATIVE_AI_API_KEY".to_string(), "GOOGLE_API_KEY".to_string()],
        "openai" => vec!["OPENAI_API_KEY".to_string()],
        "anthropic" => vec!["ANTHROPIC_API_KEY".to_string()],
        "openrouter" => vec!["OPENROUTER_API_KEY".to_string()],
        "groq" => vec!["GROQ_API_KEY".to_string()],
        "deepseek" => vec!["DEEPSEEK_API_KEY".to_string()],
        "mistral" => vec!["MISTRAL_API_KEY".to_string()],
        "cohere" => vec!["COHERE_API_KEY".to_string()],
        "together" | "together-ai" => vec!["TOGETHER_API_KEY".to_string()],
        "fireworks" | "fireworks-ai" => vec!["FIREWORKS_API_KEY".to_string()],
        "perplexity" | "perplexity-agent" => vec!["PERPLEXITY_API_KEY".to_string()],
        "cerebras" => vec!["CEREBRAS_API_KEY".to_string()],
        "chutes" => vec!["CHUTES_API_KEY".to_string()],
        "baseten" => vec!["BASETEN_API_KEY".to_string()],
        "ai21" => vec!["AI21_API_KEY".to_string()],
        "alibaba" | "alibaba-cn" => vec!["DASHSCOPE_API_KEY".to_string()],
        "abacus" => vec!["ABACUS_API_KEY".to_string()],
        "ollama" => vec!["OLLAMA_API_KEY".to_string()],
        _ => {
            let normalized = provider_id.replace('-', "_").to_uppercase();
            vec![format!("{}_API_KEY", normalized)]
        }
    }
}

pub fn docs_url_for_provider(provider_id: &str, base_url: Option<&str>) -> String {
    match provider_id {
        "anthropic" => "https://docs.anthropic.com".to_string(),
        "openai" => "https://platform.openai.com/docs".to_string(),
        "google" => "https://ai.google.dev/docs".to_string(),
        "abacus" => "https://abacus.ai/help/api".to_string(),
        "groq" => "https://console.groq.com/docs".to_string(),
        "deepseek" => "https://api-docs.deepseek.com".to_string(),
        "mistral" => "https://docs.mistral.ai".to_string(),
        "openrouter" => "https://openrouter.ai/docs".to_string(),
        "cohere" => "https://docs.cohere.com".to_string(),
        "together" | "together-ai" => "https://docs.together.ai".to_string(),
        "fireworks" | "fireworks-ai" => "https://docs.fireworks.ai".to_string(),
        "perplexity" | "perplexity-agent" => "https://docs.perplexity.ai".to_string(),
        "cerebras" => "https://inference-docs.cerebras.net".to_string(),
        "azure" | "azure-cognitive-services" => "https://learn.microsoft.com/azure/ai-services".to_string(),
        "amazon-bedrock" => "https://docs.aws.amazon.com/bedrock".to_string(),
        "cloudflare-workers-ai" | "cloudflare-ai-gateway" => "https://developers.cloudflare.com/workers-ai".to_string(),
        "ollama" => "https://ollama.com".to_string(),
        _ => {
            if let Some(url) = base_url {
                if let Some(host) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
                    let domain = host.split('/').next().unwrap_or(host);
                    return format!("https://{}", domain);
                }
            }
            format!("https://{}.ai", provider_id)
        }
    }
}

pub fn infer_family(id: &str, _name: &str) -> String {
    let lower = id.to_lowercase();
    if lower.contains("claude-3-7") || lower.contains("claude-3.7") {
        "claude-3.7".to_string()
    } else if lower.contains("claude-3-5") || lower.contains("claude-3.5") {
        "claude-3.5".to_string()
    } else if lower.contains("claude") {
        "claude".to_string()
    } else if lower.contains("gpt-4o") {
        "gpt-4o".to_string()
    } else if lower.contains("gpt-4") {
        "gpt-4".to_string()
    } else if lower.contains("gpt-5") {
        "gpt-5".to_string()
    } else if lower.contains("o1") {
        "o1".to_string()
    } else if lower.contains("o3") {
        "o3".to_string()
    } else if lower.contains("gemini-2.5") {
        "gemini-2.5".to_string()
    } else if lower.contains("gemini-2.0") {
        "gemini-2.0".to_string()
    } else if lower.contains("gemini-1.5") {
        "gemini-1.5".to_string()
    } else if lower.contains("gemini") {
        "gemini".to_string()
    } else if lower.contains("qwen") || lower.contains("qwq") {
        "qwen".to_string()
    } else if lower.contains("deepseek") {
        "deepseek".to_string()
    } else if lower.contains("llama") {
        "llama".to_string()
    } else if lower.contains("mistral") || lower.contains("codestral") {
        "mistral".to_string()
    } else if lower.contains("command-r") || lower.contains("cohere") {
        "cohere".to_string()
    } else {
        let first = lower.split(|c| c == '/' || c == '-' || c == ':').next().unwrap_or(&lower);
        first.to_string()
    }
}

pub fn extract_date(s: &str) -> Option<String> {
    for part in s.split(|c| c == '-' || c == '_' || c == '/' || c == '.') {
        if part.len() == 8 && part.starts_with("202") && part.chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("{}-{}-{}", &part[0..4], &part[4..6], &part[6..8]));
        }
    }
    let bytes = s.as_bytes();
    if bytes.len() >= 10 {
        for i in 0..=bytes.len() - 10 {
            if bytes[i] == b'2' && bytes[i + 1] == b'0' && bytes[i + 2] == b'2'
                && bytes[i + 3].is_ascii_digit()
                && bytes[i + 4] == b'-'
                && bytes[i + 5].is_ascii_digit() && bytes[i + 6].is_ascii_digit()
                && bytes[i + 7] == b'-'
                && bytes[i + 8].is_ascii_digit() && bytes[i + 9].is_ascii_digit()
            {
                return Some(s[i..i + 10].to_string());
            }
        }
    }
    None
}

pub fn format_context(tokens: Option<u64>) -> String {
    match tokens {
        None | Some(0) => "-".to_string(),
        Some(t) if t >= 1_000_000 => {
            if t % 1_000_000 == 0 {
                format!("{}M", t / 1_000_000)
            } else if (1_040_000..=1_050_000).contains(&t) {
                "1M".to_string()
            } else if (2_090_000..=2_100_000).contains(&t) {
                "2M".to_string()
            } else if t % 100_000 == 0 {
                format!("{:.1}M", t as f64 / 1_000_000.0)
            } else {
                let m = (t as f64 / 1_000_000.0 * 10.0).round() / 10.0;
                if m.fract() == 0.0 {
                    format!("{:.0}M", m)
                } else {
                    format!("{:.1}M", m)
                }
            }
        }
        Some(t) if t >= 1_000 => {
            format!("{}k", t / 1_000)
        }
        Some(t) => format!("{}", t),
    }
}

pub fn clean_cost(val: Option<f64>) -> String {
    match val {
        None => "-".to_string(),
        Some(v) if v <= 0.0 => "-".to_string(),
        Some(v) if v.fract() == 0.0 => format!("${:.0}", v),
        Some(v) if (v * 10.0).fract() == 0.0 => format!("${:.1}", v),
        Some(v) if (v * 100.0).fract() == 0.0 => format!("${:.2}", v),
        Some(v) => {
            let s = format!("${:.4}", v);
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        }
    }
}

pub fn format_cost_table(cost: Option<&ModelCost>) -> String {
    match cost {
        None => "-/-".to_string(),
        Some(c) => {
            let inp = clean_cost(c.input);
            let out = clean_cost(c.output);
            if inp == "-" && out == "-" {
                "-/-".to_string()
            } else {
                format!("{}/{}", inp, out)
            }
        }
    }
}

pub fn format_rate(cost: Option<f64>) -> String {
    match cost {
        Some(v) if v > 0.0 => {
            let c = clean_cost(Some(v));
            format!("{}/M", c)
        }
        _ => "-".to_string(),
    }
}

pub fn copy_to_clipboard(text: &str) {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        if let Ok(mut child) = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }

    let base64_str = {
        const B64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes = text.as_bytes();
        let mut buf = String::with_capacity((bytes.len() + 2) / 3 * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0];
            let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
            buf.push(B64_CHARS[(b0 >> 2) as usize] as char);
            buf.push(B64_CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
            if chunk.len() > 1 {
                buf.push(B64_CHARS[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
            } else {
                buf.push('=');
            }
            if chunk.len() > 2 {
                buf.push(B64_CHARS[(b2 & 0x3F) as usize] as char);
            } else {
                buf.push('=');
            }
        }
        buf
    };

    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = write!(out, "\x1b]52;c;{}\x07", base64_str);
    let _ = out.flush();
}

pub fn open_browser_url(url: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd").args(["/C", "start", url]).spawn();
    }
}

pub const PROVIDERS: &[ProviderDefinition] = &[
    ProviderDefinition {
        id: "google",
        name: "Google",
        description: "Gemini 2.5 Pro, Flash, and Gemma models",
        env_keys: &["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
        default_model: "gemini-2.5-pro",
    },
    ProviderDefinition {
        id: "openai",
        name: "OpenAI",
        description: "GPT-4o, o1, o3-mini, and GPT-4 Turbo models",
        env_keys: &["OPENAI_API_KEY"],
        default_model: "gpt-4o",
    },
    ProviderDefinition {
        id: "anthropic",
        name: "Anthropic",
        description: "Claude 3.7 Sonnet, 3.5 Sonnet, and Haiku models",
        env_keys: &["ANTHROPIC_API_KEY"],
        default_model: "claude-3-7-sonnet-latest",
    },
    ProviderDefinition {
        id: "openrouter",
        name: "OpenRouter",
        description: "Multi-provider gateway with unified access",
        env_keys: &["OPENROUTER_API_KEY"],
        default_model: "anthropic/claude-3.7-sonnet",
    },
    ProviderDefinition {
        id: "groq",
        name: "Groq",
        description: "Ultra-low latency Llama and Mixtral inference",
        env_keys: &["GROQ_API_KEY"],
        default_model: "llama-3.3-70b-versatile",
    },
    ProviderDefinition {
        id: "deepseek",
        name: "DeepSeek",
        description: "DeepSeek V3 and R1 reasoning models",
        env_keys: &["DEEPSEEK_API_KEY"],
        default_model: "deepseek-chat",
    },
    ProviderDefinition {
        id: "mistral",
        name: "Mistral",
        description: "Mistral Large, Codestral, and Pixtral models",
        env_keys: &["MISTRAL_API_KEY"],
        default_model: "codestral-latest",
    },
    ProviderDefinition {
        id: "ollama",
        name: "Ollama (Local)",
        description: "Local model execution via Ollama runner",
        env_keys: &["OLLAMA_API_KEY"],
        default_model: "qwen2.5-coder:latest",
    },
];

#[allow(dead_code)]
pub fn get_provider(id: &str) -> Option<&'static ProviderDefinition> {
    PROVIDERS.iter().find(|p| p.id == id)
}

#[allow(dead_code)]
pub fn get_models_for_provider(provider_id: &str) -> Vec<ModelEntry> {
    let mut models = match provider_id {
        "google" => vec![
            ModelEntry {
                id: "gemini-2.5-pro".to_string(),
                name: "Gemini 2.5 Pro".to_string(),
                description: Some("State-of-the-art coding and reasoning".to_string()),
                is_default: true,
            },
            ModelEntry {
                id: "gemini-2.5-flash".to_string(),
                name: "Gemini 2.5 Flash".to_string(),
                description: Some("High speed, balanced capability".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "gemini-2.0-flash".to_string(),
                name: "Gemini 2.0 Flash".to_string(),
                description: Some("Fast production-grade model".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "gemini-1.5-pro".to_string(),
                name: "Gemini 1.5 Pro".to_string(),
                description: Some("Deep context window and analysis".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "gemini-1.5-flash".to_string(),
                name: "Gemini 1.5 Flash".to_string(),
                description: Some("Lightweight and cost-efficient".to_string()),
                is_default: false,
            },
        ],
        "openai" => vec![
            ModelEntry {
                id: "gpt-4o".to_string(),
                name: "GPT-4o".to_string(),
                description: Some("Flagship multimodal intelligence".to_string()),
                is_default: true,
            },
            ModelEntry {
                id: "gpt-4o-mini".to_string(),
                name: "GPT-4o Mini".to_string(),
                description: Some("Fast, cost-efficient everyday tasks".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "o1".to_string(),
                name: "o1".to_string(),
                description: Some("Advanced reasoning and deep math".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "o3-mini".to_string(),
                name: "o3-mini".to_string(),
                description: Some("High-speed reasoning and code synthesis".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "gpt-4-turbo".to_string(),
                name: "GPT-4 Turbo".to_string(),
                description: Some("High capability GPT-4 generation".to_string()),
                is_default: false,
            },
        ],
        "anthropic" => vec![
            ModelEntry {
                id: "claude-3-7-sonnet-latest".to_string(),
                name: "Claude 3.7 Sonnet".to_string(),
                description: Some("Hybrid reasoning and coding champion".to_string()),
                is_default: true,
            },
            ModelEntry {
                id: "claude-3-5-sonnet-latest".to_string(),
                name: "Claude 3.5 Sonnet".to_string(),
                description: Some("Industry standard coding model".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "claude-3-5-haiku-latest".to_string(),
                name: "Claude 3.5 Haiku".to_string(),
                description: Some("Ultra-fast intelligent responses".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "claude-3-opus-latest".to_string(),
                name: "Claude 3 Opus".to_string(),
                description: Some("Deep intellectual analysis".to_string()),
                is_default: false,
            },
        ],
        "openrouter" => vec![
            ModelEntry {
                id: "anthropic/claude-3.7-sonnet".to_string(),
                name: "Claude 3.7 Sonnet".to_string(),
                description: Some("Anthropic via OpenRouter".to_string()),
                is_default: true,
            },
            ModelEntry {
                id: "anthropic/claude-3.5-sonnet".to_string(),
                name: "Claude 3.5 Sonnet".to_string(),
                description: Some("Anthropic via OpenRouter".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "openai/gpt-4o".to_string(),
                name: "GPT-4o".to_string(),
                description: Some("OpenAI via OpenRouter".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "deepseek/deepseek-r1".to_string(),
                name: "DeepSeek R1".to_string(),
                description: Some("Open reasoning model".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "meta-llama/llama-3.3-70b-instruct".to_string(),
                name: "Llama 3.3 70B".to_string(),
                description: Some("Meta open weights".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "google/gemini-2.5-pro".to_string(),
                name: "Gemini 2.5 Pro".to_string(),
                description: Some("Google via OpenRouter".to_string()),
                is_default: false,
            },
        ],
        "groq" => vec![
            ModelEntry {
                id: "llama-3.3-70b-versatile".to_string(),
                name: "Llama 3.3 70B Versatile".to_string(),
                description: Some("Ultra-low latency inference".to_string()),
                is_default: true,
            },
            ModelEntry {
                id: "llama-3.1-8b-instant".to_string(),
                name: "Llama 3.1 8B Instant".to_string(),
                description: Some("Fast small parameter model".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "mixtral-8x7b-32768".to_string(),
                name: "Mixtral 8x7B".to_string(),
                description: Some("High throughput mixture of experts".to_string()),
                is_default: false,
            },
        ],
        "deepseek" => vec![
            ModelEntry {
                id: "deepseek-chat".to_string(),
                name: "DeepSeek V3".to_string(),
                description: Some("High-capability reasoning and general coding".to_string()),
                is_default: true,
            },
            ModelEntry {
                id: "deepseek-reasoner".to_string(),
                name: "DeepSeek R1".to_string(),
                description: Some("Deep chain-of-thought reasoning model".to_string()),
                is_default: false,
            },
        ],
        "mistral" => vec![
            ModelEntry {
                id: "codestral-latest".to_string(),
                name: "Codestral".to_string(),
                description: Some("Specialized code completion and synthesis".to_string()),
                is_default: true,
            },
            ModelEntry {
                id: "mistral-large-latest".to_string(),
                name: "Mistral Large".to_string(),
                description: Some("Flagship multilingual model".to_string()),
                is_default: false,
            },
        ],
        "ollama" => vec![
            ModelEntry {
                id: "qwen2.5-coder:latest".to_string(),
                name: "Qwen 2.5 Coder".to_string(),
                description: Some("State-of-the-art open code model".to_string()),
                is_default: true,
            },
            ModelEntry {
                id: "llama3.3:latest".to_string(),
                name: "Llama 3.3".to_string(),
                description: Some("High capability open weights".to_string()),
                is_default: false,
            },
            ModelEntry {
                id: "deepseek-r1:latest".to_string(),
                name: "DeepSeek R1 (Local)".to_string(),
                description: Some("Local reasoning model".to_string()),
                is_default: false,
            },
        ],
        _ => Vec::new(),
    };

    let mut seen: HashSet<String> = models.iter().map(|m| m.id.clone()).collect();

    if let Some(catalog) = get_catalog_data() {
        if let Some(provider_data) = catalog.get(provider_id).and_then(|v| v.as_object()) {
            for (id, info) in provider_data {
                if !seen.contains(id) {
                    let name = info
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(id)
                        .to_string();

                    let description = if let Some(desc) = info.get("description").and_then(|v| v.as_str()) {
                        Some(desc.to_string())
                    } else {
                        let mut parts = Vec::new();
                        if let Some(ctx) = info.get("contextWindow").and_then(|v| v.as_u64()) {
                            if ctx >= 1_000_000 {
                                parts.push(format!("{:.1}M context", ctx as f64 / 1_000_000.0));
                            } else if ctx >= 1_000 {
                                parts.push(format!("{}k context", ctx / 1000));
                            }
                        }
                        if info.get("reasoning").and_then(|v| v.as_bool()).unwrap_or(false) {
                            parts.push("reasoning".to_string());
                        }
                        if !parts.is_empty() {
                            Some(parts.join(" · "))
                        } else {
                            None
                        }
                    };

                    models.push(ModelEntry {
                        id: id.clone(),
                        name,
                        description,
                        is_default: false,
                    });
                    seen.insert(id.clone());
                }
            }
        }
    }

    models
}

#[allow(dead_code)]
pub struct KeyResolution {
    pub key: String,
    pub source: &'static str, // "env" or "store"
}

#[allow(dead_code)]
pub fn resolve_api_key(provider: &ProviderDefinition) -> Option<KeyResolution> {
    for env_key in provider.env_keys {
        if let Ok(val) = std::env::var(env_key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(KeyResolution {
                    key: trimmed.to_string(),
                    source: "env",
                });
            }
        }
    }

    let store = CredentialStore::new();
    if let Some(key) = store.get_api_key(provider.id) {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some(KeyResolution {
                key: trimmed.to_string(),
                source: "store",
            });
        }
    }

    None
}

pub async fn validate_api_key(provider_id: &str, api_key: &str) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() && provider_id != "ollama" {
        return Err("API key cannot be empty".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    match provider_id {
        "google" => {
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models?key={}",
                key
            );
            let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
            if res.status().is_success() {
                Ok(())
            } else {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                Err(format!("Validation failed (HTTP {}): {}", status, body))
            }
        }
        "openai" => {
            let res = client
                .get("https://api.openai.com/v1/models")
                .header("Authorization", format!("Bearer {}", key))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                Ok(())
            } else {
                Err(format!("Invalid OpenAI API key (HTTP {})", res.status()))
            }
        }
        "anthropic" => {
            let res = client
                .get("https://api.anthropic.com/v1/models")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                Ok(())
            } else {
                Err(format!("Invalid Anthropic API key (HTTP {})", res.status()))
            }
        }
        "openrouter" => {
            let res = client
                .get("https://openrouter.ai/api/v1/auth/key")
                .header("Authorization", format!("Bearer {}", key))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                Ok(())
            } else {
                Err(format!("Invalid OpenRouter API key (HTTP {})", res.status()))
            }
        }
        "groq" => {
            let res = client
                .get("https://api.groq.com/openai/v1/models")
                .header("Authorization", format!("Bearer {}", key))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                Ok(())
            } else {
                Err(format!("Invalid Groq API key (HTTP {})", res.status()))
            }
        }
        "deepseek" => {
            let res = client
                .get("https://api.deepseek.com/models")
                .header("Authorization", format!("Bearer {}", key))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                Ok(())
            } else {
                Err(format!("Invalid DeepSeek API key (HTTP {})", res.status()))
            }
        }
        "mistral" => {
            let res = client
                .get("https://api.mistral.ai/v1/models")
                .header("Authorization", format!("Bearer {}", key))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                Ok(())
            } else {
                Err(format!("Invalid Mistral API key (HTTP {})", res.status()))
            }
        }
        "ollama" => Ok(()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_all_models() {
        let google_models = get_models_for_provider("google");
        assert!(google_models.len() >= 20, "Expected >=20 Google models, got {}", google_models.len());

        let openai_models = get_models_for_provider("openai");
        assert!(openai_models.len() >= 40, "Expected >=40 OpenAI models, got {}", openai_models.len());

        let openrouter_models = get_models_for_provider("openrouter");
        assert!(openrouter_models.len() >= 300, "Expected >=300 OpenRouter models, got {}", openrouter_models.len());

        let all_models = get_all_models();
        assert_eq!(all_models.len(), 6001, "Expected 6001 models, got {}", all_models.len());

        let all_providers = get_all_providers();
        assert_eq!(all_providers.len(), 206, "Expected 206 providers, got {}", all_providers.len());

        // Test formatting helpers
        assert_eq!(format_context(Some(32768)), "32k");
        assert_eq!(format_context(Some(1048576)), "1M");
        assert_eq!(format_context(Some(2000000)), "2M");
        assert_eq!(clean_cost(Some(0.4)), "$0.4");
        assert_eq!(clean_cost(Some(15.0)), "$15");
        assert_eq!(clean_cost(Some(0.11)), "$0.11");
    }
}
