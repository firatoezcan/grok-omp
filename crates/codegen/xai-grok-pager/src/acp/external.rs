//! External agent backend: run the ACP agent as a child process over stdio.
//!
//! This is the seam that lets a non-Grok agent drive the pager. The transport is
//! raw ACP (JSON-RPC 2.0, newline-delimited) over the child's stdin/stdout, fed
//! into the same `bridge_channels` client the leader path uses — so the pager's
//! ACP client machinery is reused unchanged, and nothing downstream of
//! `AgentEndpoint` knows which backend it is talking to.
//!
//! Selected with `--agent-command <COMMAND>`. `GROK_ACP_BACKEND_CMD` is an
//! environment override for test harnesses that need to inject a replay agent
//! without threading a flag through a PTY harness; the flag is the supported
//! entry point.

use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::acp::{AgentEndpoint, AgentLocation, ConnectFlags, initialize_connection};
use xai_grok_shell::agent::config::Config as AgentConfig;
use xai_grok_shell::leader::ReconnectPolicy;
use xai_grok_telemetry::process_info::{
    Entrypoint, Interactivity, LeaderMode, ProcessIdentity, set_identity,
};
use xai_grok_telemetry::startup::{self, StartupPhase};

/// Environment override for the external agent command (test harnesses only).
pub const ENV_AGENT_COMMAND: &str = "GROK_ACP_BACKEND_CMD";

/// Resolve the external agent command: the CLI flag wins over the env override.
/// An empty or whitespace-only value is treated as absent.
pub fn resolve_command(flag: Option<&str>) -> Option<String> {
    flag.map(str::to_owned)
        .or_else(|| std::env::var(ENV_AGENT_COMMAND).ok())
        .filter(|command| !command.trim().is_empty())
}

/// Split a command line into argv, honouring single and double quotes.
///
/// Hand-rolled rather than taking a dependency on `shell-words`: adding a line to
/// a Cargo.toml is a merge surface, and this is the whole requirement.
fn split_command(command: &str) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;

    for ch in command.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started {
                    argv.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => {
                current.push(ch);
                started = true;
            }
        }
    }
    if started {
        argv.push(current);
    }
    argv
}

/// Spawn the external agent, bridge its stdio into ACP channels, and initialize.
pub async fn connect(
    command: &str,
    cancel: &CancellationToken,
    flags: ConnectFlags,
) -> Result<crate::acp::AcpConnection> {
    let argv = split_command(command);
    let (program, args) = argv
        .split_first()
        .context("external agent command is empty")?;

    startup::enter(StartupPhase::ConfigLoad);
    let raw_config = xai_grok_shell::config::load_effective_config()
        .map_err(|e| anyhow::anyhow!("Failed to load config: {e}"))?;
    let agent_config = AgentConfig::new_from_toml_cfg(&raw_config)
        .map_err(|e| anyhow::anyhow!("Failed to create agent config: {e}"))?;

    startup::enter(StartupPhase::WorkerSpawn);
    tracing::info!(
        program = %program,
        args = ?args,
        "spawning external ACP agent"
    );
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        // The agent must not outlive the pager.
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("failed to spawn external agent: {command}"))?;

    let mut child_stdin = child.stdin.take().context("external agent stdin unavailable")?;
    let child_stdout = child.stdout.take().context("external agent stdout unavailable")?;

    // child stdout -> bridge inbound; bridge outbound -> child stdin.
    let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<String>();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<String>();

    tokio::spawn(async move {
        let mut lines = BufReader::new(child_stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if inbound_tx.send(line).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(%error, "external agent stdout read failed");
                    break;
                }
            }
        }
    });

    tokio::spawn(async move {
        while let Some(line) = outbound_rx.recv().await {
            // Whole lines only: ACP framing is one JSON object per line, and the
            // bridge assumes line boundaries are preserved.
            let wrote = child_stdin.write_all(line.as_bytes()).await.is_ok()
                && child_stdin.write_all(b"\n").await.is_ok()
                && child_stdin.flush().await.is_ok();
            if !wrote {
                break;
            }
        }
        // Dropping stdin closes the child's input; a well-behaved agent exits on EOF.
    });

    // Reap the child so it never lingers as a zombie after it exits.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    let bridge = crate::acp::leader_bridge::bridge_channels(
        outbound_tx,
        inbound_rx,
        cancel.clone(),
        None,
        ReconnectPolicy::bounded(),
    )?;

    // An external agent has no local credential store. The pager still wants an
    // AuthManager for its own refresh plumbing, so build one the same way the
    // leader path does; the external agent's advertised methods decide what, if
    // anything, is authenticated.
    let auth_manager = Arc::new(xai_grok_login::AuthManager::new_with_proxy_base_url(
        &xai_grok_shell::util::grok_home::grok_home(),
        agent_config.grok_com_config.clone(),
        agent_config.endpoints.proxy_url(),
    ));
    set_identity(ProcessIdentity {
        entrypoint: Entrypoint::Embedded,
        leader: LeaderMode::Standalone,
        interactivity: Interactivity::Interactive,
    });

    let endpoint = AgentEndpoint {
        tx: bridge.channel.tx,
        rx: bridge.channel.rx,
        cancel: bridge.cancel,
        location: AgentLocation::Thread(bridge.thread_handle),
    };
    initialize_connection(endpoint, &flags, auth_manager).await
}

#[cfg(test)]
mod tests {
    use super::split_command;

    #[test]
    fn splits_plain_arguments() {
        assert_eq!(split_command("omp acp"), vec!["omp", "acp"]);
    }

    #[test]
    fn honours_quotes_and_collapses_whitespace() {
        assert_eq!(
            split_command("  /opt/my agent/run   --mode acp  "),
            vec!["/opt/my", "agent/run", "--mode", "acp"]
        );
        assert_eq!(
            split_command(r#""/opt/my agent/run" --flag"#),
            vec!["/opt/my agent/run", "--flag"]
        );
    }

    #[test]
    fn empty_command_yields_no_argv() {
        assert!(split_command("   ").is_empty());
    }
}
