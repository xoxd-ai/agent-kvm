---
name: fruitctl
description: Install, diagnose, or use Fruitctl MCP to observe and control an operator-configured VNC desktop from an agent. Use for Fruitctl desktop workflows, not generic browser automation or unrelated host administration.
---

# Fruitctl

Use the operator-configured target profile and the installed Fruitctl MCP
server. Read [installation](references/installation.md) for setup, upgrade,
diagnosis, or removal. Read [operation](references/operation.md) when controlling
the desktop. [contract.toon](references/contract.toon) is the compact shared
contract; it describes the workflow, not a replacement MCP wire protocol.

The real MCP tools are `vnc_command`, `action_queue`, `task_complete`,
`task_failed`, and, from builds that include it, `computer`. Use their
discovered schemas. Frontends may prefix these names. Do not invent other
computer-use tools or infer capabilities from another agent.

## Doctor

Before controlling a macOS target, run `fruitctl doctor --macos --target
<profile>`, or add `--target-ssh <user@host>` for a raw VNC profile. It runs
read-only checks of the target over SSH.

- Any typed `targetPreflight.failures` entry means stop and report it. Examples
  are a macOS version other than 26.6.1+ or 27, Screen Sharing off, observe-only
  access, a High Performance session, the login window or a locked screen.
- Report each `warnings` entry and each `unknowns` entry as-is. Do not change
  target settings or grants yourself.
- `remote_input_owner_other` names another remote desktop host on the target.
  Each Mac should have one input owner; ask the operator before acting.
- Target profile warnings (Stage Manager, smart quotes, input source and
  similar) explain why windows may move or typed text may change. Expect that
  behaviour and verify each result with a fresh screenshot.

## Control

Observe with `vnc_command` action `health`, then `screenshot`. Every result's
`route` and `indicator` say which route answered. The raw route always reports
`indicator: absent`. A failed result adds an `error` object with `message` and,
for typed failures, `code` and `data`; code `-32010` (`stale_screen`) means no
fresh pixels were captured. Take one more screenshot before acting; Apple Screen
Sharing can pause for several seconds right after UI-heavy input, and the retry
usually succeeds. Input stays refused until a screenshot succeeds. On Apple
Screen Sharing input is held for about 3 s after each connect, because the
server ignores earlier input; the controller waits for you, and `health`
reports `input_ready` and `input_settle_remaining_ms`. Code `-32013`
(`input_not_ready`) means the request's deadline was shorter than
`data.remaining_ms`. No input was sent, so retry once that time has passed. Code
`-32011` is a typed input refusal written before any event, for example
`mouse_down` outside one `action_queue` batch; see
[operation](references/operation.md) for the input actions. Code
`unsupported_on_route` means the action (for example `ax_snapshot` or
`click_element`) needs the Host route.

macOS dialogs, the lock screen and display sleep can block input. Results
may carry `desktop_state`, and input is refused before anything is sent when
one is in the way. Code `human_consent_required` means a consent or
system dialog is on screen; `data.owner` and `data.kind` name it. Never click,
type into or dismiss it yourself, and never use a stored secret for it: ask
the human to answer it, wait, then take a screenshot before continuing. Code
`target_locked` means the lock screen or login window: ask the
human to unlock; never type a password. `display_asleep` means no current
pixels exist: report it and ask; do not wake the Mac with input.

From a Linux seat the MCP server reaches the Mac through an SSH relay. Codes
`bridge_lost`, `bridge_protocol` and `bridge_unconfirmed` mean the link failed
while work may have been in flight: input was not replayed, and whether it ran
is unknown, so take a screenshot before repeating anything. Any other
`bridge_*` code, or `broker_unavailable`, means the request was not
delivered. That MCP session stays failed; report the code and ask for the
server to be reconnected rather than retrying in a loop.

Inspect the current
image and its scaled coordinates, perform authorized bounded input, and obtain
a new screenshot to verify the result. OCR, a process health response, or an
input acknowledgement alone does not prove that the requested desktop change
occurred.

Observations are always fresh captures. Use `zoom` to read small detail at
native resolution, `diff_check` with `regions`/`ignore` to see what changed, and
`wait_for_stable` instead of fixed waits after an action. In `action_queue`, a
step's `expect` (`change_in`, `stable_ms`) is checked after the step. An unmet
condition fails as code `-32012` and stops the batch. On the Host route these
raw-pixel observations are refused as `unsupported_on_route`.

On the Host route, `ax_snapshot` returns element refs. `click_element {ref}`
and `focus_element {ref}` act on a ref from the latest snapshot. The result's
`ax_action.path` names how the action was done: `ax_press`, `ax_show_menu`,
`ax_focus` or `ax_raise` (an Accessibility action), or `vnc_click` (one click at
the element's centre). `verified` reports whether the element's state then
changed or it took focus. `verified: false` means no change was observed, not
that the action failed; take a screenshot before acting again. Never repeat a
click to get `verified: true`. Code `stale_ref` means the ref is not in the
latest snapshot, or its element is gone; take a new `ax_snapshot`.
`ax_unreachable` means a system-owned view (some popovers, sheets and system
prompts) did not respond to Accessibility and no click was guessed.
`ax_action_unsupported` means no action applies and no click was safe. For
both, report the failure, or ask the operator before clicking by coordinates.
`human_consent_required` means the element belongs to a consent or system
dialog; a human must answer it, so report it and do not click it by coordinates.
These four codes end the batch, but the session keeps its lease: take a new
`ax_snapshot` and continue. If a target reports `release_unconfirmed`, the
operator runs `fruitctl reconcile --target PROFILE` on the broker host. A
Host-only target clears there. So does a VNC target with Host capture whose
input was settled when it failed. Otherwise `reconcile_unsupported` means a
reconciled broker restart.
Use `menu_extras: true` on `ax_snapshot` to reach menu-bar extras and Control
Center. When a large window fills the node budget, read one subtree instead:
`ax_snapshot {root: "menu"}` for an open menu or popup,
`{root: "focused_window"}`, or `{root: <ref>}`, with `max_nodes` to keep the call
small. Refs from the subtree work with the element actions. To open a nested
submenu, try `show_menu_element {ref}`. If the menu does not open, use the
hover route: `mouse_move` to the centre of the item's `display_frame`, then
take a new `ax_snapshot {root: "menu"}`.

On a Host-only target with `hostInput`, `mouse_click`, `mouse_double_click`,
`triple_click`, `mouse_move`, `hover`, `mouse_drag`, `scroll`, `key_tap`,
`key_combo` and `key_type` run in FruitctlHost. Their coordinates are the
screenshot's. Call `activate_app` first when the target is not frontmost.
Each result carries a fresh readback frame; inspect it before the next step.
`input_target_mismatch` means another app or window is in front.
`secure_input_active` means a password field is focused; never work around it.
`operator_input_detected` means the operator is using the machine; wait and
take a new screenshot. `input_interrupted` reports how many events were posted
before the stop; do not repeat the action blindly.

For a knob that moves too far per pixel, add `modifiers: ["shift"]` to
`mouse_drag` when the plug-in has a Shift fine mode. Shift is the only drag
modifier. Or replace `toX` and `toY`
with `fine_dx` and `fine_dy`, an end offset in framebuffer pixels from -64 to
64, which is finer than one screenshot pixel. Check the readback frame after
each drag.

The Host activity ends 10 s after your last request, so the purple indicator
does not stay up while you think. The next action restarts it; take a new
`ax_snapshot` first, because older refs are stale.

To change a slider, text field, stepper or combo box, prefer
`set_element_value {ref, value}` over dragging. Use the value the snapshot
reports: a Logic plug-in slider holds a raw integer, such as 18 for a ratio
shown as 2.1:1. `step_element {ref, steps}` performs `AXIncrement` for positive
steps and `AXDecrement` for negative ones, up to 10. Read `value_after` and
`verified` in the result. A stop is `input_interrupted` with the calls that ran.
`verified: false` does not mean nothing happened: the control may have moved,
to a rounded value for example, or may still act later. Never repeat the call
to get `verified: true`. Take a new `ax_snapshot` and compare `value_after`
first.

A Logic mixer fader or send knob reports a value that is not settable, so
`set_element_value` and `step_element` refuse with `ax_action_unsupported`. Use
`enter_element_value {ref, value}` with the ref of its readout, the `AXTextField`
such as `volume fader level`, and the number in dB. It double-clicks the readout,
types the number, presses Return and reports `value_after`, `slider_before` and
`slider_after`. Check the readback frame the first time, because a missed
double-click would type into whatever text field has focus. `value_not_verified`
means the number may have gone in: some strips, such as Master and the buses, show
no figure, so weigh `slider_moved` and do not repeat the entry blindly. Refs outside
that strip go stale, so take a new `ax_snapshot` before the next strip. Until that action is on your broker, send `mouse_double_click`, `key_type` and `key_tap`
`return` yourself. A knob without a readout takes `mouse_drag`.

## Computer-use alias

`computer` accepts the Anthropic `computer` tool and OpenAI `computer_call`
action shapes. It translates each call into the actions above and runs it as
one bounded batch. Results carry the same `route`/`indicator` labels and an
`alias` record of the Fruitctl actions that ran. An action the backend does
not advertise fails before input with `code: "unsupported_action"`. Examples
are `triple_click`, `hold_key`, modifier clicks, `cursor_position`, `zoom` and
multi-point drags. Report the refusal; do not emulate the action.
`left_mouse_down`/`left_mouse_up` are always refused because a hold cannot span
calls. Key text uses xdotool names, and `ctrl` means Control, not Command. See
[operation](references/operation.md#computer-use-alias) for the mapping.

If target identity, pixels, geometry, or an input outcome is uncertain, pause
input and report what remains unverified. Never replay uncertain input
automatically. A target change belongs to operator configuration, not tool
arguments. Credentials belong to the controller's configured provider; never
put them in prompts, MCP arguments, generated config, logs, or receipts. To
fill a password field, use `type_secret {ref}` with a ref the operator
allowlisted for the target; ask the operator for the ref name, not the value.
Do not use it for macOS privacy (TCC), administrator or keychain prompts.

The purple human indicator is optional and available only on qualified modes.
Do not claim it is running or excluded from captures without evidence. Finish
the owned session with `task_complete` or `task_failed`; report any unconfirmed
release. Provide a concise observed result and any incomplete part of the
user's request.
