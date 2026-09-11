//! `/vibe` toggles OMP vibe mode (direct persistent fast/good worker sessions).
//! `/vibe on|off` sets it explicitly; `/vibe <prompt>` enters vibe mode and starts a turn.
//!
//! Requires the patched OMP build (branch `grok-omp/vibe-acp`) that exposes
//! `vibe` via `session/set_mode` — see bridge/specs/vibe-mode.md. On stock OMP
//! the set_mode request errors and the mode stays unchanged.

use crate::app::actions::{Action, VibeModeKind};
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand, slash_meta};

pub struct VibeCommand;

impl SlashCommand for VibeCommand {
    slash_meta! {
        name: "vibe",
        description: "Toggle vibe mode (direct persistent fast/good worker sessions)",
        usage: "/vibe [on|off|prompt]",
        takes_args: true,
        session_scoped: true,
        arg_placeholder: "[on|off|prompt]",
    }

    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        let trimmed = args.trim();
        match trimmed {
            "" => CommandResult::Action(Action::SetVibeMode(VibeModeKind::Toggle)),
            "off" | "disable" | "exit" => {
                CommandResult::Action(Action::SetVibeMode(VibeModeKind::Off))
            }
            "on" | "enable" => CommandResult::Action(Action::SetVibeMode(VibeModeKind::On)),
            _ => CommandResult::Action(Action::EnterVibeMode {
                description: Some(trimmed.to_string()),
            }),
        }
    }
}
