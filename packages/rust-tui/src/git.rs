use std::path::Path;
use std::process::Command;

#[allow(dead_code)]
pub fn get_git_branch() -> Option<String> {
    let output = Command::new("git")
        .args(["branch", "--show-current"])
        .output()
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() {
            return Some(branch);
        }
    }
    None
}

#[allow(dead_code)]
pub fn get_repo_name() -> String {
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(name) = cwd.file_name() {
            return name.to_string_lossy().to_string();
        }
    }
    "workspace".to_string()
}

#[allow(dead_code)]
pub fn get_formatted_location() -> String {
    let repo = get_repo_name();
    if let Some(branch) = get_git_branch() {
        format!("{} ({})", repo, branch)
    } else {
        repo
    }
}

pub fn truncate_path(path: &Path, max_len: usize) -> String {
    let s = path.to_string_lossy();
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("...{}", &s[s.len().saturating_sub(max_len - 3)..])
    }
}
