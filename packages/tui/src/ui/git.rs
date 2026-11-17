//! Git review uses the same patch renderer as inline edit tools, with an independent viewport.
use super::text::{elide, width};
use crate::{app::App, git::Git};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Paragraph, Wrap},
    Frame,
};

pub fn draw(app: &App, frame: &mut Frame) {
    let area = frame.area();
    let palette = app.theme;
    frame.render_widget(
        Block::default().style(Style::default().bg(palette.bg)),
        area,
    );
    if area.width < 12 || area.height < 6 {
        return;
    }
    let [heading, summary, body, notice, hints] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(2),
        Constraint::Length(1),
    ])
    .areas(area);
    let git = &app.git;
    let mut title = "Git Changes".to_string();
    if let Some(status) = &git.status {
        if status.available {
            title.push_str(&format!(
                " · {} · {}",
                status
                    .branch
                    .as_deref()
                    .unwrap_or(if status.head.is_some() {
                        "detached HEAD"
                    } else {
                        "unborn branch"
                    }),
                status
                    .head
                    .as_deref()
                    .map(|head| head.chars().take(8).collect::<String>())
                    .unwrap_or_else(|| "no commits".into())
            ));
        }
    }
    frame.render_widget(
        Paragraph::new(title).style(Style::default().fg(palette.brand)),
        heading,
    );
    let counts = git
        .status
        .as_ref()
        .map(|status| {
            format!(
                "{} files · +{} -{} · working tree vs HEAD",
                status.files.len(),
                status.files.iter().map(|f| f.additions).sum::<u64>(),
                status.files.iter().map(|f| f.deletions).sum::<u64>()
            )
        })
        .unwrap_or_else(|| "Working-tree review".into());
    frame.render_widget(
        Paragraph::new(counts).style(Style::default().fg(palette.text_muted)),
        summary,
    );
    if area.width >= 90 {
        let [files, patch] = Layout::horizontal([
            Constraint::Length((area.width / 3).clamp(28, 42)),
            Constraint::Fill(1),
        ])
        .areas(body);
        draw_files(git, frame, files, palette);
        draw_patch(git, frame, patch, palette);
    } else if git.patch_focus {
        draw_patch(git, frame, body, palette);
    } else {
        draw_files(git, frame, body, palette);
    }
    let mut notes = Vec::new();
    if let Some(error) = &git.connection_error {
        notes.push(format!("Git status disconnected: {error}"));
    }
    if let Some(diff) = &git.diff {
        if diff.cached {
            notes.push("cached · server snapshot; the space is not mounted".into());
        }
        if diff.truncated {
            notes.push("truncated · some patches or files were omitted by the server".into());
        }
    }
    frame.render_widget(
        Paragraph::new(notes.join("\n")).style(Style::default().fg(palette.warning())),
        notice,
    );
    frame.render_widget(
        Paragraph::new(
            "↑↓ move/scroll · tab focus · [] files · n/p hunks · v view · r refresh · esc back",
        )
        .style(Style::default().fg(palette.text_muted)),
        hints,
    );
}

fn message(frame: &mut Frame, area: Rect, text: &str, palette: &crate::theme::Palette) {
    frame.render_widget(
        Paragraph::new(text)
            .wrap(Wrap { trim: false })
            .style(Style::default().fg(palette.text_secondary)),
        area,
    );
}
fn draw_files(git: &Git, frame: &mut Frame, area: Rect, palette: &crate::theme::Palette) {
    let block = Block::bordered()
        .title(" Files ")
        .border_style(Style::default().fg(if git.patch_focus {
            palette.border_subtle
        } else {
            palette.brand
        }));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(status) = &git.status else {
        message(frame,inner,"Git status is not available yet. The server publishes it when the space is mounted by a run.",palette);
        return;
    };
    if !status.available {
        let reason = status
            .message
            .as_deref()
            .unwrap_or(match status.reason.as_deref() {
                Some("not-a-repository") => "This directory is not a Git repository.",
                Some("git-missing") => "Git is unavailable on the server.",
                _ => "Git status could not be read.",
            });
        message(frame, inner, reason, palette);
        return;
    }
    if status.files.is_empty() {
        message(frame, inner, "Working tree clean", palette);
        return;
    }
    let selected = status
        .files
        .iter()
        .position(|file| Some(&file.file) == git.selected.as_ref())
        .unwrap_or(0);
    let start = selected.saturating_sub(inner.height as usize / 2);
    for (row, file) in status
        .files
        .iter()
        .skip(start)
        .take(inner.height as usize)
        .enumerate()
    {
        let active = Some(&file.file) == git.selected.as_ref();
        let counts = format!(" +{} -{}", file.additions, file.deletions);
        let room = (inner.width as usize).saturating_sub(width(&counts) + 4);
        let path = elide(&file.file, room);
        let line = Line::from(vec![
            Span::styled(
                if active { "❯ " } else { "  " },
                Style::default().fg(palette.brand),
            ),
            Span::styled(
                format!("{} ", file.status.label()),
                Style::default().fg(palette.text_muted),
            ),
            Span::styled(
                path,
                Style::default().fg(if active {
                    palette.text
                } else {
                    palette.text_secondary
                }),
            ),
            Span::styled(counts, Style::default().fg(palette.text_muted)),
        ]);
        frame.render_widget(
            Paragraph::new(line).style(Style::default().bg(if active {
                palette.surface_2
            } else {
                palette.bg
            })),
            Rect {
                y: inner.y + row as u16,
                height: 1,
                ..inner
            },
        );
    }
}
fn draw_patch(git: &Git, frame: &mut Frame, area: Rect, palette: &crate::theme::Palette) {
    let title = format!(
        " {} · {} ",
        git.selected.as_deref().unwrap_or("Patch"),
        git.view.label()
    );
    let block = Block::bordered()
        .title(elide(&title, area.width.saturating_sub(2) as usize))
        .border_style(Style::default().fg(if git.patch_focus {
            palette.brand
        } else {
            palette.border_subtle
        }));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    git.width.set(inner.width as usize);
    if git.loading {
        message(frame, inner, "Loading patch…", palette);
        return;
    }
    if let Some(error) = &git.error {
        message(frame, inner, error, palette);
        return;
    }
    if git.selected.is_none() {
        message(
            frame,
            inner,
            "Select a changed file to review its patch.",
            palette,
        );
        return;
    }
    if git.diff.is_none() {
        message(frame, inner, "Press r to load the selected patch.", palette);
        return;
    }
    let rendered = git.rendered(inner.width as usize, palette);
    git.max_scroll
        .set(rendered.lines.len().saturating_sub(inner.height as usize));
    if rendered.lines.is_empty() {
        message(
            frame,
            inner,
            if git.diff.as_ref().is_some_and(|diff| diff.truncated) {
                "Text patch unavailable; the server response is truncated."
            } else {
                "No text hunks available (binary, metadata-only, or omitted patch)."
            },
            palette,
        );
        return;
    }
    let start = git.scroll.min(git.max_scroll.get());
    frame.render_widget(
        Paragraph::new(
            rendered
                .lines
                .into_iter()
                .skip(start)
                .take(inner.height as usize)
                .collect::<Vec<_>>(),
        ),
        inner,
    );
}
