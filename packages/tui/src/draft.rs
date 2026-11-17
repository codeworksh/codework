//! Private, local drafts. Each server/thread gets its own file so independent TUIs
//! editing different threads cannot overwrite each other's drafts.
use crate::prompt::Prompt;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Default)]
pub struct DraftStore {
    root: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
struct SavedDraft {
    text: String,
    caret: usize,
}
impl DraftStore {
    pub fn at(home: &Path, endpoint: &str) -> Self {
        Self {
            root: Some(
                home.join("tui/drafts")
                    .join(URL_SAFE_NO_PAD.encode(endpoint)),
            ),
        }
    }
    fn path(&self, key: &str) -> Option<PathBuf> {
        Some(
            self.root
                .as_ref()?
                .join(format!("{}.json", URL_SAFE_NO_PAD.encode(key))),
        )
    }
    pub fn load(&self, key: &str) -> Result<Option<Prompt>, String> {
        let Some(path) = self.path(key) else {
            return Ok(None);
        };
        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Could not read draft: {error}")),
        };
        let saved: SavedDraft = serde_json::from_str(&source)
            .map_err(|error| format!("Could not read draft: {error}"))?;
        Ok(Some(Prompt::restore(&saved.text, saved.caret)))
    }
    pub fn save(&self, key: &str, prompt: &Prompt) -> Result<(), String> {
        let Some(path) = self.path(key) else {
            return Ok(());
        };
        let write = || -> io::Result<()> {
            if prompt.text().is_empty() {
                return match fs::remove_file(&path) {
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                    result => result,
                };
            }
            let parent = path.parent().unwrap();
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(parent)?;
            let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            serde_json::to_writer(
                &mut file,
                &SavedDraft {
                    text: prompt.text().to_string(),
                    caret: prompt.caret(),
                },
            )?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            drop(file);
            fs::rename(temporary, path)?;
            Ok(())
        };
        write().map_err(|error| format!("Could not save draft: {error}"))
    }
}
