//! Git daemon DTOs and review state. Paths and patches come from the server's active
//! space so the client works with remote machines and sandboxes too.
use crate::{
    diff::{self, RenderedDiff, View},
    theme::Palette,
};
use serde::{Deserialize, Serialize};
use std::cell::Cell;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Change {
    Added,
    Deleted,
    Modified,
}
impl Change {
    pub fn label(self) -> &'static str {
        match self {
            Self::Added => "A",
            Self::Deleted => "D",
            Self::Modified => "M",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct File {
    pub file: String,
    pub status: Change,
    pub additions: u64,
    pub deletions: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Status {
    #[serde(rename = "spaceId")]
    pub space_id: String,
    #[serde(rename = "observedAt")]
    pub observed_at: u64,
    pub available: bool,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub files: Vec<File>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FileDiff {
    pub file: String,
    pub patch: String,
    pub status: Change,
    pub additions: u64,
    pub deletions: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Diff {
    pub files: Vec<FileDiff>,
    #[serde(default)]
    pub cached: bool,
    #[serde(default)]
    pub truncated: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub enum GitEvent {
    Status(Status),
    Connected,
    Disconnected(String),
}

#[derive(Default)]
pub struct Git {
    pub space_id: Option<String>,
    pub status: Option<Status>,
    pub open: bool,
    pub patch_focus: bool,
    pub selected: Option<String>,
    pub diff: Option<Diff>,
    pub loading: bool,
    pub error: Option<String>,
    pub connection_error: Option<String>,
    pub scroll: usize,
    pub max_scroll: Cell<usize>,
    pub width: Cell<usize>,
    pub view: View,
    pub request: u64,
}
impl Git {
    pub fn for_space(space_id: String) -> Self {
        Self {
            space_id: Some(space_id),
            ..Self::default()
        }
    }
    pub fn apply_status(&mut self, mut status: Status) -> bool {
        if self.space_id.as_deref() != Some(&status.space_id)
            || self
                .status
                .as_ref()
                .is_some_and(|held| held.observed_at > status.observed_at)
        {
            return false;
        }
        status.files.sort_by(|a, b| a.file.cmp(&b.file));
        let previous = self.selected.clone();
        if !status.available {
            status.files.clear();
        }
        if !self
            .selected
            .as_ref()
            .is_some_and(|selected| status.files.iter().any(|file| &file.file == selected))
        {
            self.selected = status.files.first().map(|file| file.file.clone());
        }
        if self.selected != previous {
            self.scroll = 0;
        }
        self.status = Some(status);
        self.diff = None;
        self.error = None;
        self.loading = false;
        self.request += 1;
        true
    }
    pub fn select(&mut self, delta: isize) {
        let Some(status) = &self.status else {
            return;
        };
        if status.files.is_empty() {
            return;
        }
        let at = status
            .files
            .iter()
            .position(|file| Some(&file.file) == self.selected.as_ref())
            .unwrap_or(0);
        let next = (at as isize + delta).clamp(0, status.files.len() as isize - 1) as usize;
        if at != next {
            self.selected = Some(status.files[next].file.clone());
            self.diff = None;
            self.error = None;
            self.scroll = 0;
        }
    }
    pub fn branch_label(&self) -> Option<String> {
        let status = self.status.as_ref().filter(|status| status.available)?;
        let branch = status
            .branch
            .as_deref()
            .unwrap_or(if status.head.is_some() {
                "detached"
            } else {
                "unborn"
            });
        Some(format!("{branch} · {} changed", status.files.len()))
    }
    pub fn rendered(&self, width: usize, palette: &Palette) -> RenderedDiff {
        let patch = self
            .diff
            .as_ref()
            .and_then(|diff| {
                diff.files
                    .iter()
                    .find(|file| Some(&file.file) == self.selected.as_ref())
            })
            .map(|file| file.patch.as_str())
            .unwrap_or("");
        diff::render_view(patch, width, 0, palette, self.view)
    }
    pub fn scroll_by(&mut self, delta: isize) {
        self.scroll = if delta < 0 {
            self.scroll.saturating_sub(delta.unsigned_abs())
        } else {
            self.scroll
                .saturating_add(delta as usize)
                .min(self.max_scroll.get())
        };
    }
    pub fn jump_hunk(&mut self, forward: bool, palette: &Palette) {
        let rendered = self.rendered(self.width.get(), palette);
        let target = if forward {
            rendered.hunks.iter().find(|row| **row > self.scroll)
        } else {
            rendered.hunks.iter().rev().find(|row| **row < self.scroll)
        };
        if let Some(row) = target {
            self.scroll = (*row).min(self.max_scroll.get());
        }
    }
}
