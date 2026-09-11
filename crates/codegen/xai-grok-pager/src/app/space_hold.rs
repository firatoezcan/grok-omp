//! Spacebar-hold push-to-talk: hold the space bar to dictate, release to stop.
//!
//! A bare space key *release* only reaches us on Kitty-protocol terminals
//! (`REPORT_EVENT_TYPES`), so the hold is recognized the way oh-my-pi's TUI
//! does it (`custom-editor.ts`): from the OS key auto-repeat cadence. A held
//! space bar emits a steady stream of space presses at a fixed fast interval;
//! deliberate taps are slower and jittery smashing never stays metronomic. The
//! few spaces typed before the cadence confirms are tracked back out of the
//! prompt, so normal typing is unaffected.
//!
//! Release is an idle gap: once repeated spaces stop arriving for
//! [`SPACE_HOLD_RELEASE`], the bar is up and recording stops. On Kitty-protocol
//! terminals the real `KeyEventKind::Release` ends the hold immediately instead
//! of waiting out the timer.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::app_view::AppView;
use super::dispatch;

/// Auto-repeat floor: real held-key repeats never outrun the OS repeat rate
/// (~60Hz at the fastest setting), while a non-bracketed paste delivers its
/// characters back-to-back. Requiring a minimum gap keeps a pasted run of
/// spaces from masquerading as a held bar — the pager, unlike a line editor,
/// sees unbracketed pastes as individual key events.
const SPACE_REPEAT_MIN_GAP: Duration = Duration::from_millis(10);
/// Max gap between two spaces for the later one to count as OS auto-repeat
/// rather than a deliberate press.
const SPACE_REPEAT_MAX_GAP: Duration = Duration::from_millis(120);
/// Two consecutive inter-space gaps are "mechanical" when both are within
/// [`SPACE_REPEAT_MAX_GAP`] and differ by no more than this absolute jitter
/// floor — or, for slower repeat rates, [`SPACE_REPEAT_JITTER_RATIO`] of the
/// smaller gap. OS key-repeat is metronomic; a human smashing the bar is fast
/// but irregular, so its deltas never stay this steady.
const SPACE_REPEAT_JITTER: Duration = Duration::from_millis(18);
const SPACE_REPEAT_JITTER_RATIO: f64 = 0.35;
/// Consecutive mechanical (fast + steady) deltas that confirm the space bar is
/// held and start recording. Needs a sustained metronomic cadence, so jittery
/// smashing and deliberate taps never reach it.
const SPACE_HOLD_MECHANICAL_RUN: u32 = 2;
/// Idle gap after the last repeated space that counts as the bar being
/// released, ending the recording. Must comfortably exceed the OS repeat
/// interval.
const SPACE_HOLD_RELEASE: Duration = Duration::from_millis(250);

/// Whether two consecutive inter-space gaps look machine-driven: both inside
/// the auto-repeat band and steady enough that a human couldn't keep the
/// cadence. See the constant docs above.
fn gaps_are_mechanical(gap: Duration, prev_gap: Duration) -> bool {
    if gap > SPACE_REPEAT_MAX_GAP || prev_gap > SPACE_REPEAT_MAX_GAP {
        return false;
    }
    if gap < SPACE_REPEAT_MIN_GAP || prev_gap < SPACE_REPEAT_MIN_GAP {
        return false;
    }
    let tolerance =
        SPACE_REPEAT_JITTER.max(gap.min(prev_gap).mul_f64(SPACE_REPEAT_JITTER_RATIO));
    gap.abs_diff(prev_gap) <= tolerance
}

/// What the event loop should do with a key event after [`SpaceHold::pre_route`].
pub(crate) enum SpaceHoldPre {
    /// The hold gesture owns this event; do not route it further.
    Consumed,
    /// Route the space normally, then call [`SpaceHold::post_route`] with the
    /// outcome so the cadence tracker can see whether it landed as text.
    Observe,
    /// Not part of the gesture; route normally with no follow-up.
    Ignore,
}

/// Spacebar-hold push-to-talk state machine, owned by the event loop.
///
/// Spaces are forwarded to the prompt optimistically; only once
/// [`SPACE_HOLD_MECHANICAL_RUN`] consecutive inter-space gaps look mechanical
/// does the gesture confirm, delete the spaces it typed, and start recording.
/// While active, further repeats are swallowed and the release deadline is
/// re-armed off each one's arrival time.
#[derive(Default)]
pub(crate) struct SpaceHold {
    /// True while a recognized hold owns the mic.
    active: bool,
    /// Spaces actually inserted by the current run; tracked back out on confirm.
    run_inserted: u32,
    /// Consecutive mechanical deltas so far in this run.
    mechanical_run: u32,
    /// Whether the space currently being routed had a mechanical gap. Set in
    /// `pre_route` (which sees `arrived_at`), consumed in `post_route` (which
    /// sees whether the space landed as text).
    pending_mechanical: bool,
    /// Prompt text length before the in-flight space was routed.
    run_before_len: Option<usize>,
    /// Previous inter-space gap, compared against the next to judge steadiness.
    last_gap: Option<Duration>,
    /// Arrival time of the last space, to measure the gap to the next one.
    last_space_at: Option<Instant>,
    /// Idle-gap deadline after the latest held-space repeat; the event loop
    /// sleeps until it and calls [`Self::expire`].
    release_at: Option<Instant>,
}

impl SpaceHold {
    /// True while a recognized hold owns the mic (recording or cold-start).
    pub(crate) fn active(&self) -> bool {
        self.active
    }

    /// The idle-gap deadline after the latest held-space repeat, for the event
    /// loop's release timer. `None` unless a hold is active.
    pub(crate) fn release_deadline(&self) -> Option<Instant> {
        self.release_at
    }

    /// End the hold if its release deadline has passed (the event loop's timer
    /// arm). Returns true when a hold actually ended, so the caller can stop
    /// the recording.
    pub(crate) fn expire(&mut self, now: Instant) -> bool {
        if self.active && self.release_at.is_some_and(|at| now >= at) {
            self.end_hold();
            return true;
        }
        false
    }

    /// First pass over a key event, before normal routing.
    ///
    /// A bare-space release during an active hold is consumed here — before the
    /// voice-chord intercept can claim it as a Ctrl+Space release — and ends
    /// the hold. Any other key ends the hold too but is left for normal
    /// routing, matching oh-my-pi's "stop recording, then let the key through".
    pub(crate) fn pre_route(
        &mut self,
        ke: &KeyEvent,
        arrived_at: Instant,
        app: &AppView,
    ) -> SpaceHoldPre {
        let is_space = ke.code == KeyCode::Char(' ') && ke.modifiers.is_empty();
        if self.active {
            match ke.kind {
                // Kitty terminals report the real release: end the hold now
                // instead of waiting out the idle-gap timer.
                KeyEventKind::Release if is_space => {
                    self.end_hold();
                    return SpaceHoldPre::Consumed;
                }
                // Auto-repeat while held: swallow it and keep the release
                // timer alive.
                KeyEventKind::Press | KeyEventKind::Repeat if is_space => {
                    self.arm_release(arrived_at);
                    return SpaceHoldPre::Consumed;
                }
                KeyEventKind::Release => return SpaceHoldPre::Ignore,
                _ => {
                    self.end_hold();
                    return SpaceHoldPre::Ignore;
                }
            }
        }
        if !is_space || ke.kind == KeyEventKind::Release {
            self.reset_run();
            return SpaceHoldPre::Ignore;
        }
        if !self.gesture_enabled(app) {
            self.reset_run();
            return SpaceHoldPre::Ignore;
        }
        let gap = self
            .last_space_at
            .map(|last| arrived_at.saturating_duration_since(last));
        self.pending_mechanical = match (gap, self.last_gap) {
            (Some(gap), Some(prev)) => gaps_are_mechanical(gap, prev),
            _ => false,
        };
        self.last_gap = gap;
        self.last_space_at = Some(arrived_at);
        self.run_before_len = dispatch::space_hold_prompt_len(app);
        SpaceHoldPre::Observe
    }

    /// Second pass, after an `Observe`d space was routed. The space only counts
    /// toward the cadence when it actually landed as a character in the prompt a
    /// hold would dictate into (a modal eating the keystroke must not arm the
    /// gesture).
    /// Returns true when the cadence confirmed a hold: the caller should start
    /// recording (`Action::EnableVoiceMode`, hold-owned).
    pub(crate) fn post_route(&mut self, app: &mut AppView) -> bool {
        let landed = match (self.run_before_len, dispatch::space_hold_prompt_len(app)) {
            (Some(before), Some(after)) => after == before + 1,
            _ => false,
        };
        if !landed {
            self.reset_run();
            return false;
        }
        self.run_inserted += 1;
        if !self.pending_mechanical {
            return false;
        }
        self.mechanical_run += 1;
        if self.mechanical_run < SPACE_HOLD_MECHANICAL_RUN {
            return false;
        }
        // Cadence confirmed: a held bar, not typing. Track back the spaces
        // already typed and start recording.
        self.delete_inserted_spaces(app);
        let at = self.last_space_at.unwrap_or_else(Instant::now);
        self.active = true;
        self.reset_run();
        self.arm_release(at);
        tracing::debug!("space-hold push-to-talk started");
        true
    }

    /// The gesture is a text-composition shortcut, so it needs the same gates
    /// as the voice chord plus a prompt the spaces can actually land in.
    fn gesture_enabled(&self, app: &AppView) -> bool {
        app.voice_mode_enabled
            && xai_grok_voice::AUDIO_SUPPORTED
            && app.current_ui.voice_keybind_enabled.unwrap_or(true)
            && dispatch::space_hold_prompt_len(app).is_some()
    }

    /// Remove the spaces this run typed into the bound prompt. They sit
    /// immediately before the caret; if the caret or text moved mid-run, only
    /// the trailing spaces are removed rather than deleting the user's
    /// characters. Routed through `handle_key` so undo history and chip
    /// bookkeeping see ordinary backspaces.
    fn delete_inserted_spaces(&mut self, app: &mut AppView) {
        let Some(prompt) = dispatch::space_hold_prompt_mut(app) else {
            return;
        };
        let text = prompt.text();
        let cursor = prompt.cursor().min(text.len());
        let removable = text[..cursor]
            .chars()
            .rev()
            .take(self.run_inserted as usize)
            .take_while(|c| *c == ' ')
            .count();
        for _ in 0..removable {
            prompt.handle_key(&KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
        }
    }

    fn arm_release(&mut self, at: Instant) {
        self.release_at = Some(at + SPACE_HOLD_RELEASE);
    }

    fn end_hold(&mut self) {
        self.active = false;
        self.release_at = None;
        self.reset_run();
    }

    fn reset_run(&mut self) {
        self.run_inserted = 0;
        self.mechanical_run = 0;
        self.pending_mechanical = false;
        self.run_before_len = None;
        self.last_gap = None;
        self.last_space_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mechanical_gaps_accept_steady_auto_repeat() {
        // ~30ms metronomic repeat with small jitter
        assert!(gaps_are_mechanical(
            Duration::from_millis(30),
            Duration::from_millis(33)
        ));
        // Slow repeat rate: proportional tolerance still passes
        assert!(gaps_are_mechanical(
            Duration::from_millis(80),
            Duration::from_millis(100)
        ));
    }

    #[test]
    fn mechanical_gaps_reject_taps_smashing_and_paste() {
        // Deliberate double-tap: too slow
        assert!(!gaps_are_mechanical(
            Duration::from_millis(200),
            Duration::from_millis(180)
        ));
        // Fast but jittery smashing: inside the band, never steady
        assert!(!gaps_are_mechanical(
            Duration::from_millis(30),
            Duration::from_millis(90)
        ));
        // Non-bracketed paste: back-to-back delivery under the repeat floor
        assert!(!gaps_are_mechanical(
            Duration::from_millis(0),
            Duration::from_millis(1)
        ));
        // One side of the pair under the floor is enough to reject
        assert!(!gaps_are_mechanical(
            Duration::from_millis(30),
            Duration::from_millis(2)
        ));
    }

    fn key(code: KeyCode, kind: KeyEventKind) -> KeyEvent {
        KeyEvent::new_with_kind(code, KeyModifiers::NONE, kind)
    }

    #[test]
    fn space_release_consumed_and_ends_active_hold() {
        // Kitty-protocol terminals report the real release; it must end the
        // hold immediately and be consumed so the voice-chord intercept can't
        // also see it.
        let mut hold = SpaceHold::default();
        let app = crate::app::app_view::tests::test_app();
        let t0 = Instant::now();
        hold.active = true;
        hold.arm_release(t0);

        let pre = hold.pre_route(&key(KeyCode::Char(' '), KeyEventKind::Release), t0, &app);
        assert!(matches!(pre, SpaceHoldPre::Consumed));
        assert!(!hold.active());
        assert_eq!(hold.release_deadline(), None);
    }

    #[test]
    fn held_space_repeat_rearms_release_deadline() {
        let mut hold = SpaceHold::default();
        let app = crate::app::app_view::tests::test_app();
        let t0 = Instant::now();
        hold.active = true;
        hold.arm_release(t0);

        let later = t0 + Duration::from_millis(40);
        let pre = hold.pre_route(&key(KeyCode::Char(' '), KeyEventKind::Repeat), later, &app);
        assert!(matches!(pre, SpaceHoldPre::Consumed));
        assert_eq!(hold.release_deadline(), Some(later + SPACE_HOLD_RELEASE));
    }

    #[test]
    fn other_key_ends_hold_but_is_forwarded() {
        // "Stop recording, then let the key through": a non-space key ends the
        // hold yet still routes normally.
        let mut hold = SpaceHold::default();
        let app = crate::app::app_view::tests::test_app();
        hold.active = true;
        hold.arm_release(Instant::now());

        let pre = hold.pre_route(
            &key(KeyCode::Char('x'), KeyEventKind::Press),
            Instant::now(),
            &app,
        );
        assert!(matches!(pre, SpaceHoldPre::Ignore));
        assert!(!hold.active());
    }

    #[test]
    fn stray_release_without_hold_is_ignored() {
        // A bare space release while no hold is active must fall through so the
        // voice-chord intercept can still claim it for a Ctrl+Space hold.
        let mut hold = SpaceHold::default();
        let app = crate::app::app_view::tests::test_app();
        let pre = hold.pre_route(
            &key(KeyCode::Char(' '), KeyEventKind::Release),
            Instant::now(),
            &app,
        );
        assert!(matches!(pre, SpaceHoldPre::Ignore));
    }

    #[test]
    fn expire_only_ends_an_active_hold_past_deadline() {
        let mut hold = SpaceHold::default();
        let t0 = Instant::now();
        assert!(!hold.expire(t0 + Duration::from_secs(10)));

        hold.active = true;
        hold.arm_release(t0);
        assert_eq!(hold.release_deadline(), Some(t0 + SPACE_HOLD_RELEASE));
        assert!(!hold.expire(t0 + SPACE_HOLD_RELEASE - Duration::from_millis(1)));
        assert!(hold.active());
        assert!(hold.expire(t0 + SPACE_HOLD_RELEASE));
        assert!(!hold.active());
        assert_eq!(hold.release_deadline(), None);
    }
}
