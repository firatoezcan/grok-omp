//! `FEATURES` is the source of truth and the operator tables are hand-maintained mirrors with no compile-time check of their own.
//! This test is that check.
//!
//! Upstream pins against `docs/internal/25-enterprise.md` and `docs/internal/22-environment-variables.md`,
//! which are not synced to this fork. The fork's operator-facing surface is the user guide's config
//! reference, so the assertions below pin `spec.path` and `spec.env` there instead.

use xai_grok_shell::agent::config::FEATURES;

const CONFIG_REFERENCE: &str = include_str!("../docs/user-guide/26-config-reference.md");

#[test]
fn every_registered_feature_reaches_the_operator() {
    for spec in FEATURES {
        assert!(
            CONFIG_REFERENCE.contains(&format!("`{}`", spec.path)),
            "{} has no row in the 26-config-reference.md pinning table",
            spec.path,
        );
        assert!(
            CONFIG_REFERENCE.contains(&format!("`{}`", spec.env)),
            "{} is undocumented in 26-config-reference.md",
            spec.env,
        );
    }
}
