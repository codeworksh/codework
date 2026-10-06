use std::time::Instant;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

use crate::catalog::{
    format_context, format_cost_table, format_rate, get_all_models,
    get_all_providers,
};
use crate::types::{FocusedPanel, ModelDetails, ModelSortMode, ProviderSummary};
use crate::ui::spinner::Spinner;
use crate::ui::theme::Theme;

#[derive(Debug, Clone)]
pub struct ModelBrowserState {
    pub focused_panel: FocusedPanel,
    pub provider_index: usize,
    pub provider_scroll_offset: usize,
    pub provider_search: String,
    pub model_index: usize,
    pub model_scroll_offset: usize,
    pub model_search: String,
    pub search_query: String,
    pub is_searching: bool,
    pub sort_mode: ModelSortMode,
    pub show_help: bool,
    pub status_notification: Option<(String, Instant)>,

    // API key entry modal (when model selected requires key)
    pub api_key_modal_open: bool,
    pub api_key_input: String,
    pub pending_model: Option<ModelDetails>,
    pub validating: bool,
    pub validation_error: Option<String>,
}

impl Default for ModelBrowserState {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelBrowserState {
    pub fn new() -> Self {
        Self {
            focused_panel: FocusedPanel::Models,
            provider_index: 0,
            provider_scroll_offset: 0,
            provider_search: String::new(),
            model_index: 0,
            model_scroll_offset: 0,
            model_search: String::new(),
            search_query: String::new(),
            is_searching: false,
            sort_mode: ModelSortMode::Id,
            show_help: false,
            status_notification: None,
            api_key_modal_open: false,
            api_key_input: String::new(),
            pending_model: None,
            validating: false,
            validation_error: None,
        }
    }

    pub fn set_notification(&mut self, msg: String) {
        self.status_notification = Some((msg, Instant::now()));
    }

    pub fn active_notification(&self) -> Option<&str> {
        if let Some((msg, time)) = &self.status_notification {
            if time.elapsed().as_secs() < 3 {
                return Some(msg);
            }
        }
        None
    }

    pub fn filtered_providers(&self) -> Vec<&'static ProviderSummary> {
        let all = get_all_providers();
        let q = self.provider_search.trim().to_lowercase();
        if q.is_empty() {
            all.iter().collect()
        } else {
            all.iter()
                .filter(|p| {
                    p.id.to_lowercase().contains(&q)
                        || p.name.to_lowercase().contains(&q)
                })
                .collect()
        }
    }

    pub fn selected_provider_id(&self) -> Option<&str> {
        let filtered = self.filtered_providers();
        if self.provider_index == 0 {
            None
        } else {
            filtered.get(self.provider_index - 1).map(|p| p.id.as_str())
        }
    }

    pub fn filtered_models(&self) -> Vec<&'static ModelDetails> {
        let all = get_all_models();
        let selected_prov = self.selected_provider_id();
        let q = if !self.model_search.trim().is_empty() {
            self.model_search.trim().to_lowercase()
        } else {
            self.search_query.trim().to_lowercase()
        };

        let mut models: Vec<&'static ModelDetails> = all
            .iter()
            .filter(|m| {
                if let Some(prov_id) = selected_prov {
                    if m.provider_id != prov_id {
                        return false;
                    }
                }
                if q.is_empty() {
                    true
                } else {
                    m.id.to_lowercase().contains(&q)
                        || m.name.to_lowercase().contains(&q)
                        || m.provider_id.to_lowercase().contains(&q)
                        || m.family.to_lowercase().contains(&q)
                }
            })
            .collect();

        match self.sort_mode {
            ModelSortMode::Id => {
                models.sort_by(|a, b| a.id.cmp(&b.id));
            }
            ModelSortMode::Provider => {
                models.sort_by(|a, b| a.provider_id.cmp(&b.provider_id).then_with(|| a.id.cmp(&b.id)));
            }
            ModelSortMode::Context => {
                models.sort_by(|a, b| {
                    b.context_window
                        .unwrap_or(0)
                        .cmp(&a.context_window.unwrap_or(0))
                        .then_with(|| a.id.cmp(&b.id))
                });
            }
            ModelSortMode::Cost => {
                models.sort_by(|a, b| {
                    let cost_a = a.cost.as_ref().and_then(|c| c.input).unwrap_or(999999.0);
                    let cost_b = b.cost.as_ref().and_then(|c| c.input).unwrap_or(999999.0);
                    cost_a
                        .partial_cmp(&cost_b)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| a.id.cmp(&b.id))
                });
            }
        }

        models
    }

    pub fn current_model(&self) -> Option<&'static ModelDetails> {
        let models = self.filtered_models();
        models.get(self.model_index).copied()
    }

    pub fn provider_for_details(&self) -> Option<&'static ProviderSummary> {
        let providers = get_all_providers();
        if let Some(prov_id) = self.selected_provider_id() {
            providers.iter().find(|p| p.id == prov_id)
        } else if let Some(m) = self.current_model() {
            providers.iter().find(|p| p.id == m.provider_id)
        } else {
            providers.first()
        }
    }
}

pub fn render_model_browser(
    f: &mut Frame,
    area: Rect,
    state: &ModelBrowserState,
    spinner: &Spinner,
) {
    if area.width < 50 || area.height < 15 {
        // Fallback for extremely cramped terminal
        let msg = Paragraph::new("Terminal too small for AI Model Browser (min 50x15)");
        f.render_widget(msg, area);
        return;
    }

    let cursor_visible = spinner.cursor_visible();

    // 1. Header (1 line)
    let header_area = Rect::new(area.x, area.y, area.width, 1);
    let mut header_spans = vec![
        Span::styled("models", Style::default().fg(Theme::sky()).add_modifier(Modifier::BOLD)),
        Span::styled(" - AI Model Browser", Style::default().fg(Theme::text_muted())),
    ];

    if state.is_searching {
        header_spans.push(Span::raw("    "));
        let search_target = match state.focused_panel {
            FocusedPanel::Providers => "providers",
            FocusedPanel::Models => "models",
        };
        let current_query = match state.focused_panel {
            FocusedPanel::Providers => &state.provider_search,
            FocusedPanel::Models => {
                if !state.model_search.is_empty() {
                    &state.model_search
                } else {
                    &state.search_query
                }
            }
        };
        header_spans.push(Span::styled(format!("/ search {}: ", search_target), Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD)));
        header_spans.push(Span::styled(current_query, Style::default().fg(Theme::text_primary())));
        header_spans.push(if cursor_visible {
            Span::styled("█", Style::default().fg(Theme::activity()))
        } else {
            Span::raw(" ")
        });
        header_spans.push(Span::styled("  (Enter: browse, Esc: clear)", Style::default().fg(Theme::text_muted())));
    } else {
        let mut filter_tags = Vec::new();
        if !state.provider_search.is_empty() {
            filter_tags.push(format!("Provider: \"{}\"", state.provider_search));
        }
        let m_query = if !state.model_search.is_empty() {
            &state.model_search
        } else {
            &state.search_query
        };
        if !m_query.is_empty() {
            filter_tags.push(format!("Model: \"{}\"", m_query));
        }

        if !filter_tags.is_empty() {
            header_spans.push(Span::raw("    "));
            header_spans.push(Span::styled(format!("[Filter: {}]", filter_tags.join(", ")), Style::default().fg(Theme::activity())));
        } else if let Some(msg) = state.active_notification() {
            header_spans.push(Span::raw("    "));
            header_spans.push(Span::styled(format!("✓ {}", msg), Style::default().fg(Theme::success())));
        }
    }
    f.render_widget(Paragraph::new(Line::from(header_spans)), header_area);

    // 2. Footer (1 line at bottom)
    let footer_area = Rect::new(area.x, area.y + area.height.saturating_sub(1), area.width, 1);
    let yellow = Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD);
    let muted = Style::default().fg(Theme::text_muted());

    let footer_line = Line::from(vec![
        Span::styled("q", yellow), Span::styled(" quit   ", muted),
        Span::styled("↑/↓", yellow), Span::styled(" nav   ", muted),
        Span::styled("Tab", yellow), Span::styled(" switch   ", muted),
        Span::styled("/", yellow), Span::styled(" search   ", muted),
        Span::styled("s", yellow), Span::styled(" sort   ", muted),
        Span::styled("c", yellow), Span::styled(" copy (prov/model)   ", muted),
        Span::styled("Enter", yellow), Span::styled(" select", muted),
        Span::raw(" ".repeat((area.width as usize).saturating_sub(76))),
        Span::styled("? help", yellow),
    ]);
    f.render_widget(Paragraph::new(footer_line), footer_area);

    // 3. Body Layout: split vertically into Top (Providers, Models) and Bottom (Provider, Details)
    let body_area = Rect::new(area.x, area.y + 1, area.width, area.height.saturating_sub(2));

    // Dynamic bottom height based on total terminal height
    let total_h = body_area.height;
    let bottom_height = if total_h >= 34 {
        13u16
    } else if total_h >= 28 {
        12u16
    } else if total_h >= 22 {
        10u16
    } else {
        (total_h * 40 / 100).clamp(7, 9)
    };
    let top_height = total_h.saturating_sub(bottom_height);

    let top_area = Rect::new(body_area.x, body_area.y, body_area.width, top_height);
    let bottom_area = Rect::new(body_area.x, body_area.y + top_height, body_area.width, bottom_height);

    // Responsive left column width based on total terminal width
    let total_w = body_area.width;
    let left_width = if total_w >= 160 {
        (total_w * 26 / 100).clamp(36, 46)
    } else if total_w >= 120 {
        (total_w * 28 / 100).clamp(32, 40)
    } else if total_w >= 90 {
        (total_w * 30 / 100).clamp(28, 34)
    } else {
        (total_w * 32 / 100).clamp(22, 28)
    };
    let right_width = total_w.saturating_sub(left_width);

    let top_left_area = Rect::new(top_area.x, top_area.y, left_width, top_area.height);
    let top_right_area = Rect::new(top_area.x + left_width, top_area.y, right_width, top_area.height);

    let bottom_left_area = Rect::new(bottom_area.x, bottom_area.y, left_width, bottom_area.height);
    let bottom_right_area = Rect::new(bottom_area.x + left_width, bottom_area.y, right_width, bottom_area.height);

    // ----------------------------------------------------
    // Panel 1: Providers (Top-Left)
    // ----------------------------------------------------
    let providers_focused = state.focused_panel == FocusedPanel::Providers;
    let prov_border_style = if providers_focused {
        Style::default().fg(Theme::sky())
    } else {
        Style::default().fg(Theme::border_box())
    };
    let prov_title_style = if providers_focused {
        Style::default().fg(Theme::sky()).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Theme::text_secondary())
    };

    let all_providers = get_all_providers();
    let filtered_providers = state.filtered_providers();
    let total_models = get_all_models().len();

    let prov_title = if !state.provider_search.is_empty() {
        format!(" Providers ({}/{}) [\"{}\"] ", filtered_providers.len(), all_providers.len(), state.provider_search)
    } else {
        format!(" Providers ({}) ", all_providers.len())
    };

    let prov_block = Block::default()
        .title(Span::styled(prov_title, prov_title_style))
        .borders(Borders::ALL)
        .border_style(prov_border_style);
    f.render_widget(prov_block, top_left_area);

    let prov_inner = Rect::new(
        top_left_area.x + 1,
        top_left_area.y + 1,
        top_left_area.width.saturating_sub(2),
        top_left_area.height.saturating_sub(2),
    );

    let total_provider_items = 1 + filtered_providers.len();
    let visible_prov_rows = prov_inner.height as usize;

    let mut prov_lines = Vec::new();
    let prov_start = state.provider_scroll_offset;
    let prov_end = (prov_start + visible_prov_rows).min(total_provider_items);
    let prov_inner_w = prov_inner.width as usize;

    if filtered_providers.is_empty() && !state.provider_search.is_empty() {
        let is_selected = state.provider_index == 0;
        let prefix = if is_selected { "> " } else { "  " };
        prov_lines.push(Line::from(vec![
            Span::styled(prefix, if is_selected { Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD) } else { Style::default().fg(Theme::text_muted()) }),
            Span::styled("All", if is_selected { Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD) } else { Style::default().fg(Theme::text_primary()) }),
            Span::raw(" "),
            Span::styled(format!("({})", total_models), if is_selected { Style::default().fg(Theme::activity()) } else { Style::default().fg(Theme::text_muted()) }),
        ]));
        prov_lines.push(Line::from(Span::styled(
            format!("  (no providers match \"{}\")", state.provider_search),
            Style::default().fg(Theme::text_muted()),
        )));
    } else {
        for idx in prov_start..prov_end {
            let is_selected = idx == state.provider_index;
            let (prefix, id_str, count_str) = if idx == 0 {
                let pfx = if is_selected { "> " } else { "  " };
                (pfx, "All".to_string(), format!("({})", total_models))
            } else {
                let p = &filtered_providers[idx - 1];
                let pfx = if is_selected { "> " } else { "  " };
                (pfx, p.id.clone(), format!("({})", p.model_count))
            };

            // Ensure the count (e.g. "(103)") is NEVER clipped! Truncate ID with "..." if needed
            let avail_id_w = prov_inner_w.saturating_sub(prefix.len() + count_str.len() + 1);
            let display_id = if id_str.len() > avail_id_w && avail_id_w >= 4 {
                format!("{}...", &id_str[..avail_id_w.saturating_sub(3)])
            } else {
                id_str
            };

            let name_style = if is_selected {
                Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Theme::text_primary())
            };

            let count_style = if is_selected {
                Style::default().fg(Theme::activity())
            } else {
                Style::default().fg(Theme::text_muted())
            };

            prov_lines.push(Line::from(vec![
                Span::styled(prefix, if is_selected { Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD) } else { Style::default().fg(Theme::text_muted()) }),
                Span::styled(display_id, name_style),
                Span::raw(" "),
                Span::styled(count_str, count_style),
            ]));
        }
    }
    f.render_widget(Paragraph::new(prov_lines), prov_inner);

    // ----------------------------------------------------
    // Panel 2: Models (Top-Right)
    // ----------------------------------------------------
    let models_focused = state.focused_panel == FocusedPanel::Models;
    let models_border_style = if models_focused {
        Style::default().fg(Theme::sky())
    } else {
        Style::default().fg(Theme::border_box())
    };
    let models_title_style = if models_focused {
        Style::default().fg(Theme::sky()).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Theme::text_secondary())
    };

    let filtered_models = state.filtered_models();
    let sort_tag = match state.sort_mode {
        ModelSortMode::Id => "",
        ModelSortMode::Provider => " [sorted by provider]",
        ModelSortMode::Context => " [sorted by context]",
        ModelSortMode::Cost => " [sorted by cost]",
    };
    let models_title = if let Some(p_id) = state.selected_provider_id() {
        format!(" Models ({}: {}){} ", p_id, filtered_models.len(), sort_tag)
    } else {
        format!(" Models ({}){} ", filtered_models.len(), sort_tag)
    };

    let models_block = Block::default()
        .title(Span::styled(models_title, models_title_style))
        .borders(Borders::ALL)
        .border_style(models_border_style);
    f.render_widget(models_block, top_right_area);

    let models_inner = Rect::new(
        top_right_area.x + 1,
        top_right_area.y + 1,
        top_right_area.width.saturating_sub(2),
        top_right_area.height.saturating_sub(2),
    );

    // Exact responsive column width allocation without any horizontal overflow
    let inner_w = models_inner.width as usize;
    let prefix_w = 2usize;
    let (prov_w, cost_w, ctx_w) = if inner_w >= 115 {
        (24usize, 16usize, 8usize)
    } else if inner_w >= 95 {
        (20usize, 15usize, 8usize)
    } else if inner_w >= 75 {
        (16usize, 14usize, 8usize)
    } else if inner_w >= 60 {
        (14usize, 12usize, 7usize)
    } else {
        (11usize, 10usize, 6usize)
    };

    // Exactly 3 spaces between the 4 columns: [prefix:2][ID] [Prov] [Cost] [Ctx]
    let non_id_w = prefix_w + 3 + prov_w + cost_w + ctx_w;
    let id_w = inner_w.saturating_sub(non_id_w).max(10);

    let mut model_lines = Vec::new();

    // Table Header
    let table_header = format!(
        "  {:<id_w$} {:<prov_w$} {:>cost_w$} {:>ctx_w$}",
        "Model ID",
        "Provider",
        "Cost",
        "Context",
        id_w = id_w,
        prov_w = prov_w,
        cost_w = cost_w,
        ctx_w = ctx_w,
    );
    model_lines.push(Line::from(Span::styled(
        table_header,
        Style::default().fg(Theme::text_muted()),
    )));

    // Model rows
    let visible_model_rows = models_inner.height.saturating_sub(1) as usize;
    let model_start = state.model_scroll_offset;
    let model_end = (model_start + visible_model_rows).min(filtered_models.len());

    for idx in model_start..model_end {
        if let Some(m) = filtered_models.get(idx) {
            let is_selected = idx == state.model_index;
            let prefix = if is_selected { "> " } else { "  " };

            // Truncate Model ID if longer than column
            let mut id_display = m.id.clone();
            if id_display.len() > id_w {
                id_display = format!("{}...", &id_display[..id_w.saturating_sub(3)]);
            }

            // Truncate Provider if longer than column
            let mut prov_display = m.provider_id.clone();
            if prov_display.len() > prov_w {
                prov_display = format!("{}...", &prov_display[..prov_w.saturating_sub(3)]);
            }

            let cost_display = format_cost_table(m.cost.as_ref());
            let context_display = format_context(m.context_window);

            if is_selected {
                let row_str = format!(
                    "{}{:<id_w$} {:<prov_w$} {:>cost_w$} {:>ctx_w$}",
                    prefix,
                    id_display,
                    prov_display,
                    cost_display,
                    context_display,
                    id_w = id_w,
                    prov_w = prov_w,
                    cost_w = cost_w,
                    ctx_w = ctx_w,
                );
                model_lines.push(Line::from(Span::styled(
                    row_str,
                    Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD),
                )));
            } else {
                model_lines.push(Line::from(vec![
                    Span::raw(prefix),
                    Span::styled(format!("{:<id_w$}", id_display, id_w = id_w), Style::default().fg(Theme::text_primary())),
                    Span::raw(" "),
                    Span::styled(format!("{:<prov_w$}", prov_display, prov_w = prov_w), Style::default().fg(Theme::text_muted())),
                    Span::raw(" "),
                    Span::styled(format!("{:>cost_w$}", cost_display, cost_w = cost_w), Style::default().fg(Theme::text_muted())),
                    Span::raw(" "),
                    Span::styled(format!("{:>ctx_w$}", context_display, ctx_w = ctx_w), Style::default().fg(Theme::text_secondary())),
                ]));
            }
        }
    }
    f.render_widget(Paragraph::new(model_lines), models_inner);

    // ----------------------------------------------------
    // Panel 3: Provider (Bottom-Left)
    // ----------------------------------------------------
    let prov_bottom_block = Block::default()
        .title(Span::styled(" Provider ", Style::default().fg(Theme::text_secondary())))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Theme::border_box()));
    f.render_widget(prov_bottom_block, bottom_left_area);

    let bottom_left_inner = Rect::new(
        bottom_left_area.x + 1,
        bottom_left_area.y + 1,
        bottom_left_area.width.saturating_sub(2),
        bottom_left_area.height.saturating_sub(2),
    );

    let prov_info = state.provider_for_details();
    let mut prov_detail_lines = Vec::new();
    let bottom_left_w = bottom_left_inner.width as usize;
    let bottom_left_h = bottom_left_inner.height as usize;

    if let Some(p) = prov_info {
        prov_detail_lines.push(Line::from(Span::styled(
            &p.name,
            Style::default().fg(Theme::sky()).add_modifier(Modifier::BOLD),
        )));

        if bottom_left_h >= 8 {
            prov_detail_lines.push(Line::raw(""));
        }

        let max_field_val_w = bottom_left_w.saturating_sub(7);

        let truncate_field = |val: &str| -> String {
            if val.len() > max_field_val_w && max_field_val_w > 4 {
                format!("{}...", &val[..max_field_val_w.saturating_sub(3)])
            } else {
                val.to_string()
            }
        };

        let docs = p.docs_url.as_deref().unwrap_or("-");
        prov_detail_lines.push(Line::from(vec![
            Span::styled("Docs: ", Style::default().fg(Theme::text_muted())),
            Span::styled(truncate_field(docs), Style::default().fg(Theme::text_secondary())),
        ]));

        let api = p.base_url.as_deref().unwrap_or("-");
        prov_detail_lines.push(Line::from(vec![
            Span::styled("API:  ", Style::default().fg(Theme::text_muted())),
            Span::styled(truncate_field(api), Style::default().fg(Theme::text_secondary())),
        ]));

        let npm = p.npm.as_deref().unwrap_or("-");
        prov_detail_lines.push(Line::from(vec![
            Span::styled("NPM:  ", Style::default().fg(Theme::text_muted())),
            Span::styled(truncate_field(npm), Style::default().fg(Theme::text_secondary())),
        ]));

        let env = if !p.env_keys.is_empty() {
            p.env_keys.join(", ")
        } else {
            "-".to_string()
        };
        prov_detail_lines.push(Line::from(vec![
            Span::styled("Env:  ", Style::default().fg(Theme::text_muted())),
            Span::styled(truncate_field(&env), Style::default().fg(Theme::text_secondary())),
        ]));

        if bottom_left_h >= 8 {
            prov_detail_lines.push(Line::raw(""));
        }

        prov_detail_lines.push(Line::from(vec![
            Span::styled("o", yellow),
            Span::styled(" open docs   ", muted),
            Span::styled("c", yellow),
            Span::styled(" copy env", muted),
        ]));
    }
    f.render_widget(Paragraph::new(prov_detail_lines), bottom_left_inner);

    // ----------------------------------------------------
    // Panel 4: Details (Bottom-Right)
    // ----------------------------------------------------
    let details_block = Block::default()
        .title(Span::styled(" Details ", Style::default().fg(Theme::text_secondary())))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Theme::border_box()));
    f.render_widget(details_block, bottom_right_area);

    let details_inner = Rect::new(
        bottom_right_area.x + 1,
        bottom_right_area.y + 1,
        bottom_right_area.width.saturating_sub(2),
        bottom_right_area.height.saturating_sub(2),
    );

    let details_inner_w = details_inner.width as usize;
    let details_inner_h = details_inner.height as usize;
    let col1_w = (details_inner_w / 2).clamp(24, 38);

    let mut details_lines = Vec::new();
    if let Some(m) = state.current_model() {
        // Line 0: Name (ID) with safe truncation
        let id_tag = format!("({})", m.id);
        let id_avail = details_inner_w.saturating_sub(m.name.len() + 3);
        let id_display = if id_tag.len() > id_avail && id_avail > 6 {
            format!("({}...)", &m.id[..id_avail.saturating_sub(5)])
        } else {
            id_tag
        };
        details_lines.push(Line::from(vec![
            Span::styled(&m.name, Style::default().fg(Theme::text_primary()).add_modifier(Modifier::BOLD)),
            Span::raw("  "),
            Span::styled(id_display, Style::default().fg(Theme::text_muted())),
        ]));

        // Line 1: Provider & Family aligned in grid
        details_lines.push(Line::from(vec![
            Span::styled("Provider: ", Style::default().fg(Theme::text_muted())),
            Span::styled(&m.provider_id, Style::default().fg(Theme::sky())),
            Span::raw(" ".repeat(col1_w.saturating_sub(10 + m.provider_id.len()).max(2))),
            Span::styled("Family: ", Style::default().fg(Theme::text_muted())),
            Span::styled(&m.family, Style::default().fg(Theme::text_primary())),
        ]));

        // Line 2: Status
        details_lines.push(Line::from(vec![
            Span::styled("Status:   ", Style::default().fg(Theme::text_muted())),
            Span::styled("active", Style::default().fg(Theme::success())),
        ]));

        if details_inner_h >= 11 {
            details_lines.push(Line::raw(""));
        }

        // Line 4: Context, Input Limit, Output Limit with clean column spacing
        let ctx_str = format_context(m.context_window);
        let out_limit_str = format_context(m.max_tokens);
        let c1_context = format!("Context: {:<7} Input: -", ctx_str);
        let c1_context_pad = col1_w.saturating_sub(c1_context.len()).max(2);
        details_lines.push(Line::from(vec![
            Span::styled("Context: ", Style::default().fg(Theme::text_muted())),
            Span::styled(format!("{:<7} ", ctx_str), Style::default().fg(Theme::text_primary())),
            Span::styled("Input: ", Style::default().fg(Theme::text_muted())),
            Span::styled("-", Style::default().fg(Theme::text_primary())),
            Span::raw(" ".repeat(c1_context_pad)),
            Span::styled("Output: ", Style::default().fg(Theme::text_muted())),
            Span::styled(out_limit_str, Style::default().fg(Theme::text_primary())),
        ]));

        // Line 5: Input & Output Pricing with clean column spacing
        let in_rate = format_rate(m.cost.as_ref().and_then(|c| c.input));
        let out_rate = format_rate(m.cost.as_ref().and_then(|c| c.output));
        let in_rate_str = format!("Input: {}", in_rate);
        let in_rate_pad = col1_w.saturating_sub(in_rate_str.len()).max(2);
        details_lines.push(Line::from(vec![
            Span::styled("Input: ", Style::default().fg(Theme::text_muted())),
            Span::styled(in_rate, Style::default().fg(Theme::text_primary())),
            Span::raw(" ".repeat(in_rate_pad)),
            Span::styled("Output: ", Style::default().fg(Theme::text_muted())),
            Span::styled(out_rate, Style::default().fg(Theme::text_primary())),
        ]));

        // Line 6: Cache Read & Write with clean column spacing (no more glue!)
        let cache_r_rate = format_rate(m.cost.as_ref().and_then(|c| c.cache_read));
        let cache_w_rate = format_rate(m.cost.as_ref().and_then(|c| c.cache_write));
        let cr_str = format!("Cache Read: {}", cache_r_rate);
        let cr_pad = col1_w.saturating_sub(cr_str.len()).max(2);
        details_lines.push(Line::from(vec![
            Span::styled("Cache Read: ", Style::default().fg(Theme::text_muted())),
            Span::styled(cache_r_rate, Style::default().fg(Theme::text_primary())),
            Span::raw(" ".repeat(cr_pad)),
            Span::styled("Cache Write: ", Style::default().fg(Theme::text_muted())),
            Span::styled(cache_w_rate, Style::default().fg(Theme::text_primary())),
        ]));

        if details_inner_h >= 11 {
            details_lines.push(Line::raw(""));
        }

        // Line 8: Capabilities
        let caps = if m.reasoning {
            "reasoning, tools, temperature"
        } else {
            "tools, temperature"
        };
        details_lines.push(Line::from(vec![
            Span::styled("Capabilities: ", Style::default().fg(Theme::text_muted())),
            Span::styled(caps, Style::default().fg(Theme::text_primary())),
        ]));

        // Line 9: Modalities
        let modalities_str = if m.input_modalities.len() > 1 {
            format!("{} -> text", m.input_modalities.join(", "))
        } else {
            "text -> text".to_string()
        };
        details_lines.push(Line::from(vec![
            Span::styled("Modalities:   ", Style::default().fg(Theme::text_muted())),
            Span::styled(modalities_str, Style::default().fg(Theme::text_primary())),
        ]));

        // Line 10: Released & Knowledge with clean spacing
        let rel = m.released.as_deref().unwrap_or("-");
        let rel_str = format!("Released: {}", rel);
        let rel_pad = col1_w.saturating_sub(rel_str.len()).max(2);
        details_lines.push(Line::from(vec![
            Span::styled("Released:     ", Style::default().fg(Theme::text_muted())),
            Span::styled(rel, Style::default().fg(Theme::text_primary())),
            Span::raw(" ".repeat(rel_pad)),
            Span::styled("Knowledge: ", Style::default().fg(Theme::text_muted())),
            Span::styled("-", Style::default().fg(Theme::text_primary())),
        ]));

        // Line 11: Updated
        let upd = m.updated.as_deref().unwrap_or("-");
        details_lines.push(Line::from(vec![
            Span::styled("Updated:      ", Style::default().fg(Theme::text_muted())),
            Span::styled(upd, Style::default().fg(Theme::text_primary())),
        ]));
    }
    f.render_widget(Paragraph::new(details_lines), details_inner);

    // ----------------------------------------------------
    // Overlay: API Key Configuration Modal
    // ----------------------------------------------------
    if state.api_key_modal_open {
        let card_w = 66u16.min(area.width.saturating_sub(4));
        let card_h = 13u16.min(area.height.saturating_sub(2));
        let modal_x = (area.width.saturating_sub(card_w)) / 2;
        let modal_y = (area.height.saturating_sub(card_h)) / 2;
        let modal_area = Rect::new(modal_x, modal_y, card_w, card_h);

        f.render_widget(Clear, modal_area);

        let prov_name = state.pending_model.as_ref().map(|m| m.provider_name.as_str()).unwrap_or("Provider");
        let modal_block = Block::default()
            .title(Span::styled(
                format!(" Configure API Key: {} ", prov_name),
                Style::default().fg(Theme::accent()).add_modifier(Modifier::BOLD),
            ))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Theme::border()));
        f.render_widget(modal_block, modal_area);

        let modal_inner = Rect::new(
            modal_area.x + 2,
            modal_area.y + 1,
            modal_area.width.saturating_sub(4),
            modal_area.height.saturating_sub(2),
        );

        let mut lines = Vec::new();
        if let Some(m) = &state.pending_model {
            lines.push(Line::from(vec![
                Span::styled("Model: ", Style::default().fg(Theme::text_muted())),
                Span::styled(&m.name, Style::default().fg(Theme::text_primary()).add_modifier(Modifier::BOLD)),
                Span::styled(format!(" ({})", m.id), Style::default().fg(Theme::text_muted())),
            ]));
            let env_desc = if !m.env_keys.is_empty() {
                m.env_keys.join(" or ")
            } else {
                "API key".to_string()
            };
            lines.push(Line::from(vec![
                Span::styled("Environment key: ", Style::default().fg(Theme::text_muted())),
                Span::styled(env_desc, Style::default().fg(Theme::accent())),
            ]));
            lines.push(Line::raw(""));
        }

        if state.validating {
            lines.push(Line::from(vec![
                Span::styled(format!("{} ", spinner.current()), Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD)),
                Span::styled("Validating API key with provider...", Style::default().fg(Theme::activity())),
            ]));
        } else {
            lines.push(Line::from(Span::styled("Enter your API key below:", Style::default().fg(Theme::text_primary()))));
            let masked = "•".repeat(state.api_key_input.len());
            lines.push(Line::from(vec![
                Span::styled("API Key: ", Style::default().fg(Theme::accent()).add_modifier(Modifier::BOLD)),
                Span::styled(masked, Style::default().fg(Theme::text_primary())),
                if cursor_visible {
                    Span::styled("█", Style::default().fg(Theme::accent()))
                } else {
                    Span::raw(" ")
                },
            ]));

            if let Some(err) = &state.validation_error {
                lines.push(Line::from(vec![
                    Span::styled("✗ ", Style::default().fg(Theme::error()).add_modifier(Modifier::BOLD)),
                    Span::styled(err, Style::default().fg(Theme::error())),
                ]));
            } else {
                lines.push(Line::raw(""));
            }

            lines.push(Line::from(Span::styled("Press Enter to validate & save, Esc to cancel", Style::default().fg(Theme::text_muted()))));
        }

        f.render_widget(Paragraph::new(lines), modal_inner);
    }

    // ----------------------------------------------------
    // Overlay: Help Modal
    // ----------------------------------------------------
    if state.show_help {
        let help_w = 64u16.min(area.width.saturating_sub(4));
        let help_h = 16u16.min(area.height.saturating_sub(2));
        let help_x = (area.width.saturating_sub(help_w)) / 2;
        let help_y = (area.height.saturating_sub(help_h)) / 2;
        let help_area = Rect::new(help_x, help_y, help_w, help_h);

        f.render_widget(Clear, help_area);

        let help_block = Block::default()
            .title(Span::styled(" AI Model Browser - Help ", Style::default().fg(Theme::accent()).add_modifier(Modifier::BOLD)))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Theme::border()));
        f.render_widget(help_block, help_area);

        let help_inner = Rect::new(
            help_area.x + 2,
            help_area.y + 1,
            help_area.width.saturating_sub(4),
            help_area.height.saturating_sub(2),
        );

        let shortcuts = [
            ("Tab / Shift+Tab", "Switch focus between Providers and Models"),
            ("↑ / ↓ (or k / j)", "Navigate items in the focused list"),
            ("PgUp / PgDn", "Scroll list by page"),
            ("/", "Filter providers or models depending on focus"),
            ("s", "Cycle sort mode: ID, Provider, Context, Cost"),
            ("c", "Copy selected model ID or provider env key to clipboard"),
            ("o", "Open active provider documentation in browser"),
            ("Enter", "Select model (validates credentials & updates active model)"),
            ("q / Esc", "Exit browser / cancel search"),
        ];

        let mut lines = Vec::new();
        for (key_str, desc) in shortcuts {
            lines.push(Line::from(vec![
                Span::styled(format!("{:<18}", key_str), Style::default().fg(Theme::activity()).add_modifier(Modifier::BOLD)),
                Span::styled(desc, Style::default().fg(Theme::text_primary())),
            ]));
        }
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled("Press any key or Esc to close help", Style::default().fg(Theme::text_muted()))));

        f.render_widget(Paragraph::new(lines), help_inner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn test_model_browser_filtering_and_sorting() {
        let mut state = ModelBrowserState::new();
        let initial_models = state.filtered_models();
        assert_eq!(initial_models.len(), 6001, "Expected all 6001 models by default");

        // Filter by search query
        state.search_query = "claude-3-7-sonnet".to_string();
        let claude_models = state.filtered_models();
        assert!(!claude_models.is_empty(), "Expected claude models to match");
        for m in &claude_models {
            assert!(
                m.id.to_lowercase().contains("claude-3-7-sonnet")
                    || m.name.to_lowercase().contains("claude-3-7-sonnet")
            );
        }

        // Test sorting by context
        state.search_query.clear();
        state.sort_mode = ModelSortMode::Context;
        let sorted_by_ctx = state.filtered_models();
        let first_ctx = sorted_by_ctx.first().unwrap().context_window.unwrap_or(0);
        let last_ctx = sorted_by_ctx.last().unwrap().context_window.unwrap_or(0);
        assert!(first_ctx >= last_ctx, "Expected descending context window");
    }

    #[test]
    fn test_model_browser_provider_details() {
        let mut state = ModelBrowserState::new();
        // Index 0 is "All", provider_for_details should match first model's provider
        let prov = state.provider_for_details();
        assert!(prov.is_some(), "Expected provider details to be present");

        // Set provider_index to 1 (first alphabetically sorted provider)
        state.provider_index = 1;
        let prov1 = state.provider_for_details().unwrap();
        let all_provs = get_all_providers();
        assert_eq!(prov1.id, all_provs[0].id);
    }

    #[test]
    fn test_render_model_browser_no_panic() {
        let resolutions = [(60, 18), (80, 24), (100, 30), (120, 35), (140, 40), (180, 50)];
        let state = ModelBrowserState::new();
        let spinner = Spinner::new();

        for (w, h) in resolutions {
            let backend = TestBackend::new(w, h);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal
                .draw(|f| {
                    render_model_browser(f, f.area(), &state, &spinner);
                })
                .unwrap();
        }
    }

    #[test]
    fn test_provider_search_filtering() {
        let mut state = ModelBrowserState::new();
        assert_eq!(state.filtered_providers().len(), 206);

        // Search for anthropic
        state.provider_search = "anthropic".to_string();
        let filtered = state.filtered_providers();
        assert!(!filtered.is_empty());
        assert!(filtered.iter().any(|p| p.id == "anthropic"));
        for p in &filtered {
            assert!(
                p.id.to_lowercase().contains("anthropic")
                    || p.name.to_lowercase().contains("anthropic")
            );
        }

        // When provider_index is set to the index of anthropic
        let anthropic_idx = filtered.iter().position(|p| p.id == "anthropic").unwrap() + 1;
        state.provider_index = anthropic_idx;
        assert_eq!(state.selected_provider_id(), Some("anthropic"));

        // Models should only contain anthropic models
        let models = state.filtered_models();
        assert!(!models.is_empty());
        for m in &models {
            assert_eq!(m.provider_id, "anthropic");
        }

        // Non-existent search
        state.provider_search = "nonexistent_provider_xyz".to_string();
        assert!(state.filtered_providers().is_empty());
        assert_eq!(state.selected_provider_id(), None);
    }
}

