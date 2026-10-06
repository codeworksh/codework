use std::fs;
use std::path::PathBuf;
use crate::credentials::get_codework_dir;
use crate::types::ModelConfig;
use crate::ui::theme;

pub struct ConfigManager {
    file_path: PathBuf,
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigManager {
    pub fn new() -> Self {
        let dir = get_codework_dir();
        Self {
            file_path: dir.join("config.json"),
        }
    }

    pub fn load(&self) -> Option<ModelConfig> {
        if let Ok(content) = fs::read_to_string(&self.file_path) {
            let config: Option<ModelConfig> = serde_json::from_str(&content).ok();
            if let Some(cfg) = &config {
                if let Some(id) = &cfg.theme {
                    if let Some(idx) = theme::by_id(id) {
                        theme::set_active(idx);
                    }
                }
            }
            config
        } else {
            None
        }
    }

    pub fn save(&self, config: &ModelConfig) -> std::io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(config).unwrap_or_else(|_| "{}".to_string());
        fs::write(&self.file_path, data)?;
        Ok(())
    }
}
