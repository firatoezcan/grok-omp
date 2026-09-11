//! Advisor note block: a note injected by OMP's advisor (a second model that
//! passively reviews each turn). Renders as a labeled, severity-tinted text
//! block — distinct from both user prompts and agent messages.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::appearance::AppearanceConfig;
use crate::render::wrapping::word_wrap_lines;
use crate::scrollback::block::BlockContent;
use crate::scrollback::types::{AccentStyle, BlockContext, BlockLine, BlockOutput};
use crate::theme::Theme;

/// Advisor note severity, as stamped by the bridge (`x.ai/advisor` meta).
/// `nit` is informational, `concern` interrupts, `blocker` demands a fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvisorSeverity {
    Nit,
    Concern,
    Blocker,
}

impl AdvisorSeverity {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "nit" => Some(Self::Nit),
            "concern" => Some(Self::Concern),
            "blocker" => Some(Self::Blocker),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Nit => "nit",
            Self::Concern => "concern",
            Self::Blocker => "blocker",
        }
    }

    pub(crate) fn color(self, theme: Theme) -> ratatui::style::Color {
        match self {
            Self::Nit => theme.gray,
            Self::Concern => theme.warning,
            Self::Blocker => theme.accent_error,
        }
    }
}

/// A single advisor note. `advisor` is the advisor name when the note came from
/// a named advisor (multi-advisor setups); `severity` defaults to `Nit` when
/// the wire omits it.
#[derive(Debug, Clone)]
pub struct AdvisorBlock {
    pub advisor: Option<String>,
    pub severity: AdvisorSeverity,
    pub text: String,
}

impl AdvisorBlock {
    pub fn new(
        advisor: Option<String>,
        severity: Option<AdvisorSeverity>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            advisor,
            severity: severity.unwrap_or(AdvisorSeverity::Nit),
            text: text.into(),
        }
    }
}

impl BlockContent for AdvisorBlock {
    fn output(&self, ctx: &BlockContext) -> BlockOutput {
        let theme = Theme::current();
        let severity_color = self.severity.color(theme);

        // Header: "Advisor" in the severity color, then the advisor name and
        // severity in muted parens — e.g. `Advisor (main · concern)`.
        let mut header_spans = vec![Span::styled(
            "Advisor",
            Style::default()
                .fg(severity_color)
                .add_modifier(Modifier::BOLD),
        )];
        let mut qualifier = String::new();
        if let Some(name) = &self.advisor {
            qualifier.push_str(name);
        }
        if self.severity != AdvisorSeverity::Nit {
            if !qualifier.is_empty() {
                qualifier.push_str(" · ");
            }
            qualifier.push_str(self.severity.label());
        }
        if !qualifier.is_empty() {
            header_spans.push(Span::styled(
                format!(" ({qualifier})"),
                theme.muted(),
            ));
        }

        let mut lines = vec![BlockLine::styled(Line::from(header_spans)).with_selection_range(Some(0))];

        // Body: the note text, muted, word-wrapped like a system message.
        let body_style = theme.muted();
        let styled_lines: Vec<Line<'static>> = self
            .text
            .lines()
            .map(|line| Line::from(Span::styled(line.to_string(), body_style)))
            .collect();
        for line in word_wrap_lines(styled_lines, ctx.width as usize) {
            lines.push(BlockLine::styled(line).with_selection_range(Some(0)));
        }

        BlockOutput { lines }
    }

    fn accent(&self, _ctx: &BlockContext) -> Option<AccentStyle> {
        Some(AccentStyle::static_color(
            self.severity.color(Theme::current()),
        ))
    }

    fn has_vpad_for(&self, _appearance: &AppearanceConfig) -> bool {
        false // compact, like system messages
    }

    fn is_foldable(&self) -> bool {
        false // notes are short
    }

    fn is_selectable(&self) -> bool {
        false
    }

    fn is_groupable(&self) -> bool {
        true
    }
}
