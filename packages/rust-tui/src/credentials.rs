use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

pub fn get_codework_dir() -> PathBuf {
    if let Ok(home) = std::env::var("CODEWORK_HOME") {
        PathBuf::from(home)
    } else if let Some(home) = dirs::home_dir() {
        home.join(".codework")
    } else {
        PathBuf::from(".codework")
    }
}

pub struct CredentialStore {
    file_path: PathBuf,
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore {
    pub fn new() -> Self {
        let dir = get_codework_dir();
        Self {
            file_path: dir.join("credentials.json"),
        }
    }

    fn ensure_dir(&self) -> std::io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            }
        }
        Ok(())
    }

    pub fn read_all(&self) -> HashMap<String, String> {
        if let Ok(content) = fs::read_to_string(&self.file_path) {
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            HashMap::new()
        }
    }

    pub fn get_api_key(&self, provider_id: &str) -> Option<String> {
        self.read_all().get(provider_id).cloned()
    }

    pub fn set_api_key(&self, provider_id: &str, api_key: &str) -> std::io::Result<()> {
        self.ensure_dir()?;
        let mut all = self.read_all();
        all.insert(provider_id.to_string(), api_key.to_string());
        let data = serde_json::to_string_pretty(&all).unwrap_or_else(|_| "{}".to_string());
        fs::write(&self.file_path, data)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.file_path, fs::Permissions::from_mode(0o600));
        }

        Ok(())
    }
}
