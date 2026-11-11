# Architecture

Fruitctl separates the agent protocol, the shared desktop controller, and the
human indication shown on a target. The public producer owns these interfaces;
fleet configuration and deployment belong to each consumer.

## Components

| Component | Responsibility | Platform |
| --- | --- | --- |
| Agent adapter | Configure MCP and install the shared skill | Harness-dependent |
| Shared relay | Forward agent requests and observations | Node.js 24 |
| Darwin broker | Own target profiles, credentials, control leases, and native transport | macOS |
| Native VNC client | Decode target pixels and send remote input | Apple Silicon macOS 15+ baseline |
| SSH bridge | Attach a Linux seat to the Darwin controller | Linux client to Darwin |
| Target indicator | Show the human an active control session | Optional macOS app |
| Filtered capture | Exclude the indicator from qualified observations | Optional macOS ScreenCaptureKit path |

The control path is `MCP → relay → Darwin broker → native VNC → target`.
The indicator/capture path is separate. Existing `vnc_command`, `action_queue`,
and completion tool names remain compatible while their implementation is
refactored. See the [MCP schemas](../tools/index.js) for actual action names.

The current-source SSH relay stops admitting clients when shutdown begins.
Its directly spawned SSH child and local listener share one monotonic retirement
cutoff, with a two-second default; inherited timeouts, deadlines and cancellation
can only shorten retirement. Success requires both the child's drained `close`
event and the listener's close callback. Abort, deadline expiry or unknown
closure returns sticky `release_unconfirmed`, including during startup cleanup
or bridge loss; late closure cannot revise that result or replay input. This
source repair is newer than immutable alpha.7 and is not installed-runtime or
Home Manager delivery qualification.

As a service, the relay keeps its listener when the bridge drops. It answers
clients with a typed bridge error and reconnects with capped, jittered backoff.
A successor SSH child starts only after its predecessor drained `close`. Lost
work is never replayed. If a lost child cannot be confirmed closed, the relay
exits with status 3 and does not start a successor. `fruitctl relay --once`
keeps the single-link behaviour. See
[Linux SSH controller](home-manager.md#linux-ssh-controller).

## Backend capabilities

Current source advertises a bounded native action list at readiness and includes
`capabilities: { known, actions }` in MCP health results. Missing metadata from an
older controller remains `known: false`; its existing compatible actions still
work. An explicitly empty native list advertises no supported native actions.
Capabilities describe supported routes, not desktop, permission or input-mapping
qualification. The experimental helper reports its wrapper routes separately
from the native list and requires qualified mapping for input.

Known unsupported actions reject the whole batch before action writes or helper
activity acquisition. A healthy owner's lease and queued compatible work remain
available. Discovering capabilities can start the configured backend; this does
not promise zero initial startup. Failures after admission still retire uncertain
execution, and remote or forged refusal codes cannot bypass cleanup. These source
changes are newer than immutable alpha.7.

## Session and credential ownership

One broker owns each target's live control state. The operator selects a named
profile that fixes the target and credential provider. Tool arguments cannot
redirect that profile. A Linux bridge carries requests and observations without
receiving the target secret. Credentials never become command-line arguments,
adoption receipts, or public configuration.

Use one profile per desktop. Before opening its socket, the broker rejects
known overlaps in VNC endpoints, helper SSH hosts, and explicit `targetId`
values. The operator may assign that stable physical identity when different
addresses name the same machine. Fruitctl does not guess DNS or SSH aliases;
the operator must resolve those aliases and keep one controller owner for the
desktop.

The broker binds a target lease to the connected relay client. Each accepted
execute request from that owner renews the default 60-second lease; another
client is rejected while it is owned or releasing. `task_complete` and
`task_failed` release control, as do disconnect and lease expiry. Release cancels
pending input, releases held native input, and closes the executor before a
successor may acquire the target. Unconfirmed cleanup blocks the target until
the operator reconciles it. An unused native executor also has a five-minute
idle cleanup deadline.

Reconnect requires a new observation and cannot replay previous input. The
optional target app has its own short-lived indicator lease and local stop
control. In the experimental helper path, the executor starts target activity
on the task's first admitted non-health request and renews it every 500
milliseconds across requests and agent thinking gaps. It ends activity on explicit task release,
completion, failure, disconnect, or the broker's 60-second ownership expiry.
Input requires a current ready acknowledgement and independently
qualified mapping. The helper-backed source additionally binds each permit to
the native controller's own challenge, monotonic deadline, helper session, and
current display/framebuffer generation. The native writer checks that permit
before admitting each VNC input event, independently of broker scheduling.
Renewal controls bypass the action queue; expired required permits cannot be
revived by a later acknowledgement or image. Controllers without this private
capability refuse helper-backed input. Loss of the helper, acknowledgement, or
permit retires the executor; uncertain input is never replayed.

Owned synthetic tests cover a responsive native writer while its broker
producer is suspended. They do not qualify a real target, input mapping, or
physical indicator. Neutralizing held-key/button releases may follow expiry;
an already blocked native write or a suspended native process remains outside
the responsive-writer timing proof. The broker's 60-second ownership lease
alone does not prove that the human indicator is active.

### Display wake hold

A target profile may opt in to a display wake hold:

```json
"wake": { "ssh": "alex@office-desktop", "enabled": true }
```

While a client owns that target's lease, the broker runs
`ssh -tt -o BatchMode=yes … -- alex@office-desktop caffeinate -d -u` from a
fixed argument vector, with no local shell. The remote terminal makes the
connection's end hang up `caffeinate`, so it does not outlive the hold. Lease
renewal reuses the running hold. Explicit release, task completion or failure,
disconnect, lease expiry and broker shutdown terminate it. A Host Stop ends it
when the broker retires that lease: on the next refused request, or at the
lease's expiry. The destination uses the same character set as the helper and doctor SSH
validators and an invalid `wake` profile stops the broker before it opens its
socket. `enabled: false` turns the hold off without deleting the destination.

The hold is advisory. Spawn or exit failures are logged on the broker's
stderr, backed off for 30 seconds, and reported in each `health` result as
`wake: { configured, state, failures, last_error?, last_stop? }` with state
`holding`, `idle` or `failed`. They never fail the lease or its input. A hold
that is running is not proof the display is awake; capture freshness still
decides.

`display_asleep` is the stable error code for an asleep display. The broker
never infers sleep from pixel colour. It raises the code from two explicit
signals: the desktop-state sentinel below reporting the main display asleep
(before input), and a native error whose `data.reason` is `display_asleep`.
The native daemon does not emit that signal yet, so without a sentinel an
asleep display surfaces as `stale_screen` or another capture failure.

### Desktop-state sentinel

Before a batch that contains input, the broker reads the target's desktop
state with one fixed, read-only script over the profile's SSH destination
(`desktopState.ssh`, else `wake.ssh`, else `hostHelper.sshHost`) and refuses
the batch before it starts or uses the VNC executor when the state is known
to block input: `target_locked` for the lock screen or login window,
`display_asleep` for an asleep main display, and `human_consent_required` for
an on-screen window of a consent or system dialog owner. These are broker
string codes; numeric JSON-RPC codes stay with the native controller. The refusal is pre-admission: nothing is sent, the executor is
not retired and the lease is kept. The journal records it as `refused`. The
script shares doctor's probe fragments and parsers; it reads no window titles
or pixels and never answers a dialog (D16). Results are cached for about 2 s.
Health and screenshot results carry `desktop_state`; a screenshot never waits
for a probe and reports a cached sample only while it is fresh (else `unknown`,
`stale`), and health waits at most 1.5 s, within its deadline, for one already
running. Before input the probe gets at most half of the batch's remaining
budget. An unreachable, slow or unconfigured sentinel is `unknown` and refuses
nothing.
Fields and codes: [target profile](target-profile.md#desktop-state-sentinel).

### Action journal

The broker appends a hash-chained JSONL journal for each client session, one
file per session UUID under its state directory: `journal/<session>.jsonl` in
`~/Library/Application Support/fruitctl/state` on macOS, or
`$XDG_STATE_HOME/fruitctl` (default `~/.local/state/fruitctl`) elsewhere.
`FRUITCTL_STATE_DIR` overrides the state directory. The directory is private
`0700` and each file `0600`. Configure it at the top level of the broker
config:

```json
"journal": { "dir": "/absolute/path", "enabled": true }
```

The journal is on by default; `enabled: false` turns it off.

Each requested action becomes one `fruitctl.journal.v1` record: `seq`, `ts`,
`session`, `target`, `method`, `params`, a bounded `result` summary with its
`outcome` (`ok`, `error`, `failed`, `not_run`, `refused` or `not_admitted`),
`frame_sha256` of the decoded returned image, any executor `provenance`, then
`prev_hash` and `hash`. The hash is SHA-256 of the record's canonical JSON
(sorted keys) without `hash`; the first record's `prev_hash` is 64 zeros.
Images are never stored, only their digests. `type_secret` stores its `ref`,
`x`, `y`, the provider kind and a `length_class`, and replaces every other
parameter with `[redacted]` ([secret providers](secrets.md)). Any parameter whose name
looks like a credential (password, secret, token, credential, API or private
key, OTP, PIN code, auth) is redacted for every action. Text is cut to 256
characters. A `key_type` that paste routing sent through the clipboard records
`kind: "paste"` in its result summary. A `clipboard_read` record holds only
whether the text was withheld, never the text.

Journal writes are queued after the result is known. A write failure is logged
and counted, and never fails or delays a returned action. A broken existing
file is never extended. Verify a file with:

```sh
fruitctl journal verify ~/.local/state/fruitctl/journal/<session>.jsonl
```

It prints JSON and exits 1 at the first record that breaks the chain, naming
the line and reason (`record hash mismatch`, `previous hash mismatch`,
`sequence gap or reorder`, `session mismatch` or `truncated final record`).
The chain detects edits, insertions, deletions and reordering within a file. It
cannot detect deleting the whole file or its newest records together with
their successors; keep copies elsewhere when that matters.

## Observation contract

A successful capture contains a complete frame with current dimensions,
coordinate mapping, and a frame identifier. A changing test target is necessary
to qualify action-to-observation behavior. A static screenshot cannot prove a
fresh frame, and a partial update cannot be reported as complete pixels.

The raw-VNC daemon asks for each observation with a non-incremental
FramebufferUpdateRequest (RFC 6143 section 7.5.3). While that capture is
pending, the daemon's own message loop adds no incremental request. LibVNC
0.9.15 still writes its own incremental request after every
FramebufferUpdate it processes (`rfbclient.c:2564`), before the completion
callback. Any update that arrives during a pending capture therefore leaves
an incremental request outstanding at the server. Every screen observation
still requires new full pixel coverage and a completed update on the same
allocation within that capture's original deadline: 10000 ms on a server
detected as Apple, 5000 ms otherwise, or `--capture-timeout-ms` (1000 to
20000; profile `vnc.captureTimeoutMs`). The request's `deadline_ms` budget,
stamped by the Node executor, caps it, so the capture fails typed before the
30 s tool deadline. A complete cached mirror,
server silence, partial pixels or a metadata-only update cannot establish
current pixels or authorize further input. Static-screen behavior on macOS
Screen Sharing still requires native and attended qualification.

A failed observation returns JSON-RPC code `-32010` (`stale_screen`). Its
message keeps the prefix `No fresh complete framebuffer update within` for
deadline failures, followed by that capture's deadline (`5 seconds` by default
on servers other than Apple, `10 seconds` on Apple), and `data.reason` is one of `server_silent`,
`metadata_only`, `incomplete_coverage`, `late_complete` (every pixel arrived,
but only at or after the deadline), `allocation_changed`, `disconnected`,
`request_failed`, `capture_busy` or `cancelled`. `data.diagnostics` carries
only control-flow counters, including the inferred
`unanswered_full_requests`, `unanswered_incremental_requests`,
`auto_rearm_observed` and `request_gate_leaks`. RFB requests carry no
identifier, so the unanswered counts err high, never low: a full request is
retired one at a time, only by an update whose own rectangles cover the whole
allocation, and an update carrying any rectangle retires every outstanding
incremental request. A server that answers several full requests with one
update leaves the full count high for the rest of the connection. The MCP
server keeps this code and data in the tool result's structured `error` object
(`{code, message, data}`, the shape every failed result uses) beside the
compatible error text and the D7 `route` and `indicator` labels; a failed
`action_queue` reports its first failure in the same object.

Input refusals use code `-32011` with `data.reason` and are returned before
any event of the refused request. Mouse holds (D27) are batch-scoped: the
executor that runs one `action_queue` batch assigns it one private
`hold_scope`, carries it on every native request of that batch and ends the
batch with `release_holds`. `mouse_down`/`mouse_up` without that scope are
refused (`hold_outside_batch`); any native request from outside the batch
force-releases a live hold first; abort or shutdown releases it through the
existing held-input release. The scope is not an MCP field. Before the first
input of each connection generation the native client writes one release-only
key-up per Shift/Control/Alt/Meta/Super keysym. It is deferred from connect so
an observation-only connection still writes no input.

Observation conditions that fresh captures did not meet fail with JSON-RPC
code `-32012`. `data.reason` is `stable_timeout` (`wait_for_stable`, or a queue
step's `expect.stable_ms`) or `change_not_observed` (a queue step's
`expect.change_in`), with `elapsed_ms` and `captures`. Every compared frame
was fresh. A capture failure inside the wait stays `-32010` `stale_screen`.
`wait_for_stable`, `zoom` and region `diff_check` never compare or return a
cached frame. A queue step's `expect` runs in the same executor operation as
the step, as private native methods: `expect_baseline` before the step, then
`expect_change` and `wait_for_stable` after it. An unmet expectation therefore
stops the batch before the next step's input. `wait_for_stable` and the
expectation methods return no image, so they keep the request's prior input
authorization only while the display identity is unchanged and never grant
one; `zoom`, like `screenshot`, adopts its frame.

The Host route answers `screenshot` from its own ScreenCaptureKit image. It
refuses every observation computed from raw VNC pixels before admission:
`cursor_crop`, `diff_check`, `set_baseline`, `detect_elements`, `zoom`,
`wait_for_stable` and the queue expectation methods. The refusal carries the
string code `unsupported_on_route`. Actions a backend does not offer at all
keep `unsupported_action`.

`--rfb-wire-ledger` writes one stderr line per framebuffer request: message
type, incremental flag, length and monotonic milliseconds, never payloads.
The daemon's own requests are listed after LibVNC reports them sent. LibVNC
also reports success without writing when the server's SupportedMessages
bitmap or a pending resize excludes a message; such a request is listed with
origin `suppressed`, and a suppressed observation request fails as
`request_failed` instead of being awaited. LibVNC's initial request and
post-update re-arm are inferred; its SetPixelFormat, SetEncodings and resize
requests are not listed, so a header-only packet capture remains the wire
authority. Input is coalesced: each run of key, pointer and clipboard
messages becomes one `type=input` line, written just before the next request
line or at disconnect, naming only the message types. The ledger never
records how many input messages were sent, when each was sent or how long
clipboard text was.

`--rfb-request-mode on-demand` is opt-in; `stream` stays the default. After
the connection initializes, the daemon clears LibVNC's FramebufferUpdateRequest
bit in the client-to-server capability bitmap (`client2server[0] & 0x08`).
While that bit is clear, LibVNC reports success without writing its own
post-update re-arm or resize request (`rfbclient.c:1497`). The daemon opens
the bit only around its own whole-screen request, for an observation or for
missing pixels after a resize, and never writes an incremental request. Its
first missing-pixel refresh after connecting waits one second behind
`rfbInitConnection`'s own request, so the two are never outstanding together.
A server SupportedMessages rectangle can rewrite the bitmap and leak one
re-arm before any callback runs. The daemon counts that as
`request_gate_leaks` (kept across framebuffer reallocations), closes the bit
again, marks the pending observation `ordered_after_prior_input: false` and
counts the leaked re-arm as outstanding until an update answers it. A target
profile selects the mode with
`"vnc": { "requestMode": "on-demand" }`. Whether Apple's server needs this
mode, or keeps an idle connection without an outstanding request responsive,
remains unqualified until an attended probe records it.

In the default `stream` mode the daemon also holds that bit clear from an
observation's own whole-screen request until the observation resolves, then
restores it and the stream resumes. Without the hold, LibVNC re-arms an
incremental request after every update, including an update already in
flight when the whole-screen request was written. Apple's server answers the
newest request: while the screen animates (on PZM, after typing into the
System Settings search field) that re-arm superseded the whole-screen request
on about one capture in five, and only partial updates arrived until the
capture failed as `stale_screen` `incomplete_coverage` (TIN-5509, 2026-10-16).
The hold changes only what is written. A capture still succeeds only when
rectangles received after its own request, then FinishedUpdate, cover the
whole allocation; it reports `requests.incremental: 0` unless a server
SupportedMessages rectangle leaks a re-arm, which is counted in
`request_gate_leaks` as on demand.

Each successful observation result carries `provenance`: `source`
(`in_session`), `coverage` (`complete_received_after_request`),
`request_mode`, the full and incremental `requests` written while it was
pending, `prior_unanswered_requests` (the full and incremental requests
believed outstanding when its own request was admitted),
`ordered_after_prior_input`, `elapsed_ms` and `elicited_input`, which is
always `null` because no input is written to obtain an observation.
`ordered_after_prior_input` is `true` only when no request was believed
outstanding at admission and no request leaked through the on-demand gate
while the observation was pending. Only then must every update that completed
it answer a request written after any earlier input. Stream mode usually has
LibVNC's re-arm or a poll outstanding, so it usually reports `false`; an
observation admitted right after another, before the stream resumes, can
find nothing outstanding.

On Apple's server the daemon writes Command as `Super_L`/`Super_R` and Option
as `Meta_L`/`Meta_R`; the `cmd` and `alt`/`option` key names are unchanged.
The Option mapping remains pending native and attended verification.

### Input readiness after connect

Apple's `screensharingd` silently drops all RFB input, pointer and key, for
about 2.5 s after the viewer authenticates, and LibVNC still reports each
write as sent (see [Compatibility](compatibility.md#apple-input-settle-time)).
The daemon therefore records a monotonic timestamp when ServerInit completes
on each connection generation and holds input until the settle time has
elapsed. A reconnect is a new generation and restarts it.

- `--input-settle-ms N` sets the time (0 to 10000). The default is 3000 when
  the server is detected as Apple (the same ARD credential request that turns
  on the Option and Command keysym mapping) and 0 otherwise.
- The first input of a generation waits out the remaining time; later input
  is not delayed. Waiting is preferred to refusing, and no event is written
  early. Every write on the native queue rechecks the gate, including
  release-only writes, the per-generation modifier sync, clipboard text for
  `paste` and held-input release after an error or abort.
- The wait ends at once on cancellation or abort. The Node executor passes each
  request a private `deadline_ms` budget, a little shorter than its own
  deadline. If the remaining settle time does not fit in it, or in the native
  input permit's lease on the Host route, the request fails before any event
  with JSON-RPC code `-32013`, `data.reason` `input_not_ready` and
  `data.remaining_ms`. The Host route waits out the settle time itself before
  adopting the observation and requesting the permit, so the lease is never
  spent waiting.
- Observation is never delayed: `screenshot`, `health` and the other screen
  methods run during the settle time. `health` reports `input_ready`,
  `input_settle_remaining_ms` and `input_settle_ms`.

Input and capture failures are distinct. If an input's execution is uncertain,
report that uncertainty and avoid replay. If capture fails after known input,
report both facts and stop until a complete observation is available.

In the experimental Host path, a capture refusal preserves its stable reason
and, when available, the failed capture phase, recognized Apple error domain
symbol and signed 32-bit code. A locally generated request ID correlates the refusal.
Localized descriptions, paths, arbitrary domains and underlying errors are
discarded. If retirement cannot confirm release, the failing request still
reports `release_unconfirmed`, with the sanitized Host cause for diagnosis;
the target stays revoked and requires operator reconciliation. These source
diagnostics do not qualify capture or grant macOS permission.

A Host-only target holds no VNC connection, credential or input process, so
its executor can prove its own release (#159). The Host ends a lease when that
lease's connection closes. After a failure the broker waits for its own SSH
child to exit. It then opens one fresh attachment that sends only `health`.
Release is confirmed when that reply shows no lease, indicator or capture
readiness. Only this executor's own lease may still be draining, for at most
the Host's 3-second expiry. Any other session's lease keeps the target latched.
The probe's own SSH child must exit too. The failure is still reported and the
executor is never reused. The next owner gets a new executor.

When a latch remains, `fruitctl reconcile --target PROFILE` asks the running
broker to repeat that proof and clear the latch in place. It prints a JSON
receipt with `reconciled`, the first cause and the Host's readback, and exits
1 when the proof fails. A lane with queued work refuses with
`reconcile_refused`. A VNC lane refuses with `reconcile_unsupported`, because
its native process needs the reconciled broker restart.

A VNC lane with Host capture can prove its release the same way when no VNC
input it sent may still be held (TIN-5385). An input call is unsettled from
its send until its own successful reply. Inside a hold scope only the
confirmed `release_holds` settles it. A pointer move outside a hold scope
presses nothing, so it is never unsettled. When the lane fails with its input
settled, as on a missed Host receipt deadline for an AX call, the broker also
waits for the VNC child to exit before the Host probe. A clean probe then
releases the lane without a latch. A failure with unsettled input, or a VNC
client that reports no exit, still answers `reconcile_unsupported`.

The receipt for such a lane adds `native` with `input_settled`,
`exit_observed` and `delivery_proven`. The last is always false. A settled
call had its own reply from the VNC daemon, but RFB has no input
acknowledgement, so that reply means only that the daemon wrote the bytes to
its socket. The failure path also ends the daemon with a signal, without its
shutdown handshake. A key-up still queued on that socket can be lost, and
the proof would not see it. On a loopback tunnel this is unlikely. When a
key or button seems stuck after a reconcile, check the target before the
next session.

## Host input route

A Host-only target whose profile sets `hostInput` lets FruitctlHost post the
VNC schema's pointer and key actions itself (#157). The actions are
`mouse_click`, `mouse_double_click`, `triple_click`, `mouse_move`, `hover`,
`mouse_drag`, `scroll`, `key_tap`, `key_combo` and `key_type`, plus
`activate_app`. Coordinates are in the agent's screenshot space. The broker maps
each one to the centre of a framebuffer pixel, and the Host maps that pixel to a
global point. `paste`, `type_secret`, holds and `clipboard_read` stay refused
on this route.

`mouse_drag` also takes `modifiers: ["shift"]`, held for the whole drag, for a
plug-in's fine mode (#180). Other modifiers are refused: they turn a drag into
another command, and with Escape, which cancels an interrupted drag, they can
form a system shortcut. Instead of `toX` and `toY` a drag can take `fine_dx`
and `fine_dy`: the end as an offset from the start in framebuffer pixels, from
-64 to 64, not both zero. On a 2x display one framebuffer pixel is half a
point, finer than one screenshot pixel. Whether a plug-in reads a movement under
one point is up to the plug-in; check the readback frame. The VNC route refuses both with
`unsupported_on_route`, because its daemon takes modifiers only on clicks.

```json
{ "transport": "host-only", "targetId": "neo", "hostHelperFile": "/private/binding.json",
  "hostInput": { "applications": ["com.apple.logic10"], "operatorInput": "yield", "operatorIdleMs": 1000 } }
```

| Gate | Where | Refusal |
| --- | --- | --- |
| Operator policy names the app | broker | `input_target_not_allowed` |
| Local "Enable agent input" opt-in | Host, before every event | `input_disabled` |
| Accessibility grant (`CGPreflightPostEventAccess`) | Host | `input_permission_required` |
| Live lease, fresh indicator heartbeat, unchanged display, no Stop | Host, before every event | the lease error ends the action |
| `IsSecureEventInputEnabled`, or a focused secure text field | Host, before every event | `secure_input_active` |
| Frontmost app is the target; optional pid and window title | Host, before every event | `input_target_mismatch` |
| Window under each press and each drop belongs to the target, its Save or Open panel, or the menu bar outside the Apple menu. An AU hosting process for the target also qualifies when the target's own window lies directly beneath it (#172). A window in front of the one the system says a mouse-down would hit does not count (#186). The Host's own status item and menu are refused | Host | `input_window_mismatch` |
| Key combinations macOS or the Dock handle: app and Space switching, Spotlight, input sources, force quit, lock, log out | Host | `input_system_shortcut` |
| No pointer position, including every point of a drag, within 12 points of an active hot corner or within 4 points of the Dock's edge (#178). A corner is active when `com.apple.dock` `wvous-*-corner` is above 1 or unreadable; an absent bottom-right key is macOS's default Quick Note. The Dock's edge counts whether or not it hides, because a full-screen window reveals it | Host, before the first event | `input_screen_edge` |
| Typing needs a readable focused text input of the target. A newline or tab ends its request. Focus held by the target's AU hosting process (an out-of-process plug-in view) admits keys, and admits typing of 1 to 16 digits, signs, points or commas into a field AX cannot read (#179). Those characters are also Logic key commands (screensets, transport), as with `key_tap`: click into the field first and check the readback frame | Host | `input_focus_unavailable` |
| Consent and authorization dialog owners | Host | `human_consent_required` |
| Operator input: `yield` refuses or stops, `assert` continues and counts. `yield` needs a live event tap, and the keyboard tap for key and text input | Host | `operator_input_detected`, `operator_input_monitor_unavailable` |
| The local Fruitctl menu is open | Host, every event | the action stops |
| `activate_app` waits for 2 s of operator idle under either policy | Host | `operator_input_detected` |

The Host asks AppKit which window a mouse-down at the point would hit
(`NSWindow.windowNumber(at:belowWindowWithWindowNumber:)`). Any window in front of
that one does not take the click and is looked through (#186). On neo a full-screen
Notification Center window stays at layer 21 while clicks reach Logic beneath it.
A window the system does hit, such as an alert banner, still refuses, and the
refusal names it. When AppKit gives no answer, or the window list does not show
its answer at the point, the list alone decides.

The window check also looks through the Host's click-through indicator panels and the
Window Server's software cursor (#172). That cursor is an unnamed window at the
cursor level, at most 256 by 256 points, around the pointer. Once the pointer
reaches the point, it is the topmost window there and receives no events. The
owner must be the Window Server by its Apple-anchored signing identifier
`com.apple.WindowServer`, not by name, and window names must be readable
through the Screen Recording grant. The menu bar is identified the same way.

An AU hosting process is an Apple-anchored
`com.apple.audio.AUHostingService.arm64e` or `.x86-64`, or a helper of the
target: a child process that is not a regular application and runs an
executable inside the target's bundle. Its window acts for the target only when
the window directly below it in front-to-back order is the target's, at the
same layer, and contains it. A remote view is ordered that way over its host's
window. Logic's main window, at another layer, does not qualify. Keyboard focus
in an Apple AU hosting service counts by the same window rule (#185), because
the service also hosts other applications' views.

`input_window_mismatch` names the window that refused it (#182), as `window` in
the refusal's data, and in `input_interrupted` when it stopped an action. It
carries the owner's pid, process name, bundle ID and Apple signing ID, whether
it is the Window Server, the window's level and bounds in points, the owner of
the window directly below it, and the frontmost pid. It never carries a title
or pixels.

A refusal before the first event keeps the lease and is that action's error
response. A stop after some events releases every button and key the Host
pressed, then reports `input_interrupted` with the count it posted and a
readback frame. A drag in progress is cancelled with Escape and released at its
press point, never dropped where the pointer is. Escape is sent only while the
target is frontmost. Stop and Quit release held input at once; for a drag that
means up to four events, which move the pointer back to the press point. When the lease
itself ends mid-action, the reply names the count and the lane retires. Nothing
is replayed. A completed action returns one fresh Host frame, taken at least
150 ms after its last event, as its readback.

### Activity after the agent stops

A Host-only executor releases the Host activity (lease, indicator and element
refs) 10 s after the agent's last request ends (#177). The lane keeps its owner
and executor. The next request begins a new activity, which takes about half a
second, so refs from before the gap are stale: take a new `ax_snapshot`. The
target profile's `hostActivityIdleMs` sets the period: 0 keeps the activity
until the lane releases, otherwise 1000 to 600000 ms. FruitctlHost itself ends
an activity whose owner sends no agent request for 660 s; every broker batch
counts, through a marked renewal when the batch does not reach the Host. When the agent's broker
connection closes, the lane releases at once, through the same path as a
`close` frame. Before this, a stalled or vanished agent kept the indicator up
until the 60 s owner lease ended. A VNC target keeps its activity for the lane's
lifetime, because its native input permits follow the Host lease. If another
session takes the Host's lease during the gap, the next batch is refused per
call with `host_busy`, nothing is sent, and the lane is kept. A refused request
and a health check do not hold the activity.

Events come from a private event source and carry a Host tag. A listen-only
session event tap counts input without that tag as operator input. Without
Input Monitoring the tap sees pointer events only, and keyboard events fall
back to event times compared with the Host's own latest post of the same kind.
A tap that macOS disabled stops counting, and the fallback covers every kind.
Health reports which method runs as `operator_input_monitor`. The fallback
cannot tell operator keys from the Host's own during typing, so `yield` refuses
key and text input without the keyboard tap. Qualification of the tap, timing and
Space behaviour on a live desktop is an attended gate.

### Element values

`enter_element_value {ref, value, app?}` is for a control whose own value is not
settable and which has an editable readout beside it, such as a Logic mixer fader
(#181). `ref` names the readout, an `AXTextField` in the latest snapshot. The
broker reads the readout's parent at depth 1 for its current frame, double-clicks
its centre, types the number, presses Return and reads the parent again. `value` is
at most 16 characters of a plain number in the readout's displayed unit. Each step
is ordinary Host input, under every gate in the table above. Each read keeps only
that parent's refs, so refs elsewhere go stale: one entry per strip, then a new
snapshot.

Logic reports no value on the readout and puts the figure in its label, as
`volume fader level, -6.0 dB`. A field that shows other text, such as a strip's
name, refuses before input with `ax_action_unsupported`. The entry is verified only
when the figure shows the number within its displayed decimals. Logic shows no
figure on some strips, such as Master and the buses. There the result is
`input_interrupted` with `reason: "value_not_verified"` and `slider_moved`, and the
agent decides from `slider_before` and `slider_after`. A refused read keeps its own
code as the reason. In every such case the number may have been entered.

The broker waits 500 milliseconds after the double-click, and asks again for up to
1.5 seconds while the Host refuses typing with `input_focus_unavailable`, which
posts nothing. A returned stop reports `entry_step` and
leaves any open field as it is. A lost lease or a deadline retires the lane without
naming a step, and the field may still be open. The Host gates do not prove the
focused field is the readout, so check the readback frame after a first use.

`set_element_value {ref, value, app?}` sets one element's `AXValue`, and
`step_element {ref, steps, app?}` performs `AXIncrement` or `AXDecrement` up to
10 times (#161). They need the same `hostInput` policy, local opt-in, live
lease, secure-input check, frontmost target and `yield` idle time as posted
input. The element must be an `AXSlider`, `AXTextField`, `AXIncrementor` or
`AXComboBox` that is enabled, with a settable value or the step action. Its
owner must be the target, or the target's AU hosting process reached through
the target's own snapshot. The Host sets a
number for an element whose value is a number, and text otherwise. It then
reads the value back within 250 milliseconds for a set and 120 milliseconds
for each step. The reply carries `value_before`, `value_after`, `owner`,
`steps_performed` and `verified`. A refusal before the first AX call keeps the
lease. Under `yield` the Host refuses with `operator_input_monitor_unavailable`
when only event times are available. After the first AX call, any stop ends
the batch as `input_interrupted` with the calls that ran and the readback:

- `value_unverified`: the value did not read back.
- `ax_indeterminate`: a call may still act later.
- `operator_input_detected`, Stop or a target change between steps.
- `budget_exhausted`: no step starts after 1.2 seconds, counted from the first read.

`verified: false` can still mean the control changed, for example to a rounded
value. Read `value_after` before acting again. When the lease itself ends after
an AX call, the lane retires with the count. Nothing is retried. A numeric value
outside the element's `AXMinValue` and `AXMaxValue` is not sent.

## Host capture scope

Host captures leave out windows the agent should not see (#163). A Host-only
target with `hostInput` captures only its input applications by default. Each
image keeps the display's full geometry and every other window is black, so
coordinates and AX frames map unchanged. The target's Save or Open panel
service is kept with it. A display capture always leaves out FruitctlHost and a
fixed private list: Messages, Mail, Passwords, Keychain Access, common password
managers and chat apps. The profile can add more:

```json
"hostCapture": { "scope": "target", "applications": ["com.apple.logic10"] }
"hostCapture": { "scope": "display", "exclude": ["com.cmuxterm.app"] }
```

A target scope fails closed with `capture_scope_unsupported` on a Host that
does not report `capture_scope`. When no target application is running, the
screenshot is a per-call `capture_target_unavailable` and the lease stays. The
image metadata names the filter in `capture_filter` and the kept applications
in `capture_scope_bundle_ids`. The begin-activity and idle-reference captures
use the display scope.

## Error codes

The native daemon, FruitctlHost, the Darwin broker, the Linux relay and the
MCP server share one error `code` field. Numeric codes are JSON-RPC and belong
to the native processes; the broker only relays them, except that the Host
route raises `-32013` itself with the daemon's meaning. Broker codes are
strings. This table is the register: a new code is added here in the same
change that raises it, and `test/fruitctl-error-codes.test.js` fails on a code
in `lib/`, `ClaudeKVM-Daemon/` or `FruitctlHost/` that is missing. `-32001` to
`-32009`, `-32015` to `-32019` and `-32021` upward are unassigned.

| Code | Raised by | Meaning |
| --- | --- | --- |
| `-32700` | daemon | Request line is not JSON |
| `-32600` | daemon, Host | Invalid request, including one over the line limit |
| `-32601` | daemon, Host | Unknown method (Host: `unsupported_host_action`) |
| `-32602`, `-32603` | Host-route diagnostics | Native reply codes retained in fixed first-cause metadata. Emission by the shipped controller remains unverified |
| `-32000` | daemon, Host | Untyped failure; no `data` |
| `-32010` | daemon | `stale_screen`: no fresh complete frame; `data.reason`, `data.diagnostics` |
| `-32011` | daemon | Input refused before any event; `data.reason` |
| `-32012` | daemon | Observation condition unmet: `stable_timeout`, `change_not_observed` |
| `-32013` | daemon, Host route | `input_not_ready`: settle time does not fit the deadline; no event written |
| `-32014` | daemon | `clipboard_unavailable`: `clipboard_read` failed or is off; `data.reason` |
| `-32020` | Host route | A per-call Host refusal on the wire; its typed code is `data.code`, which MCP reports as the error code |
| `unsupported_action` | broker, MCP | The backend does not offer the action |
| `unsupported_on_route` | broker | The action exists only on the other route |
| `unsupported_expectation` | MCP | The step cannot carry the requested `expect` |
| `invalid_deadline` | broker | `timeoutMs` is not a positive number of milliseconds |
| `target_idle_retiring` | broker | The owner's idle connection is closing; retry |
| `clipboard_read_disabled` | broker | `clipboard.read` is off for this target |
| `invalid_secret_request` | broker, relay | `type_secret` is not `{ref, x?, y?}` |
| `secret_ref_not_allowed` | broker | The ref is not in this target's `secrets` allowlist |
| `secret_unavailable` | broker | A provider failed; `data.reason`, `data.ref`, `data.provider` |
| `human_stop_latched` | broker, Host route | The human Stop is latched |
| `human_consent_required` | sentinel, Host | A consent or system dialog is on screen; `data.owner`, `data.kind` |
| `target_locked` | sentinel | Locked screen or login window; `data.console` |
| `display_asleep` | sentinel, wake | The target display is asleep |
| `accessibility_permission_required` | Host route, Host | FruitctlHost lacks the Accessibility grant |
| `stale_ref` | Host route, Host | The element ref is not in the latest `ax_snapshot` |
| `ax_unreachable` | Host | The element can no longer be reached |
| `ax_action_unsupported` | Host | The element does not offer the action |
| `capture_target_unavailable` | Host | A target-scoped capture found none of its applications running; nothing was captured |
| `capture_scope_unsupported` | broker | The profile asks for target-only capture and this FruitctlHost cannot apply it |
| `accessibility_root_unavailable` | Host | The `ax_snapshot` root (focused window or open menu) is absent; nothing was read |
| `credential_unavailable` | broker | The VNC credential provider failed at startup |
| `release_unconfirmed` | broker, relay, executors | Release is unconfirmed; the target stays revoked until reconciled |
| `invalid_input` | broker | A Host input action's coordinates, keys, text or scroll are invalid; nothing was sent |
| `host_busy` | broker | After an idle release, another session holds the Host's lease; nothing was sent and the lane is kept |
| `agent_idle_released` | Host | The Host ended the activity after 660 s with no agent request (#177). The lane retires. The next call fails with this code, and the call after it begins a new lane |
| `input_target_not_allowed` | broker | The action's `app` is not one of the target's `hostInput.applications` |
| `input_disabled` | broker, Host | The FruitctlHost menu's agent input opt-in is off |
| `input_permission_required` | broker, Host | FruitctlHost may not post events; it lacks the Accessibility grant |
| `secure_input_active` | Host | Secure event input is on, or the focused element is a password field |
| `input_target_mismatch` | Host | The frontmost application, process or window is not the requested target |
| `input_window_mismatch` | Host | The window under the pointer belongs to another process |
| `operator_input_detected` | Host | Operator input arrived within the yield window |
| `operator_input_monitor_unavailable` | Host | `yield` with key or text input needs an event tap that sees keys (Input Monitoring) |
| `input_focus_unavailable` | Host | Typing needs a readable focused text input owned by the target |
| `input_system_shortcut` | Host | The key combination belongs to macOS or the Dock, not the target |
| `input_screen_edge` | Host | The pointer would reach an active hot corner or the auto-hidden Dock's edge; nothing was sent |
| `input_interrupted` | Host route | A Host input action stopped after posting some events; `data.reason`, `data.posted_events` |
| `reconcile_refused` | broker | `fruitctl reconcile` found the lane closing, busy or changed |
| `reconcile_unsupported` | broker | The latched lane cannot prove its own release; restart the reconciled broker |
| `operation_failed` | broker | Any other error crossing the broker socket |
| `broker_unavailable` | client | The broker socket is not reachable |
| `bridge_unreachable`, `bridge_auth_refused`, `bridge_host_key`, `bridge_command_missing`, `bridge_attach_failed`, `bridge_broker_unavailable` | relay | The SSH bridge (D20) did not deliver the request |
| `bridge_protocol`, `bridge_lost`, `bridge_unconfirmed` | relay | The bridge failed with work in flight; nothing is replayed |
| `relay_config`, `relay_listener_failed` | relay | The relay could not start |

"Host route" is the broker's host-helper executor; "Host" is FruitctlHost
itself. A string code raised by the broker before admission (lane, secret,
clipboard, sentinel or a Host route check) means nothing was sent and the
lease is kept. The same code in a FruitctlHost reply, or `display_asleep`
from an executor, follows an admitted request and retires the lane. Four
FruitctlHost `ax_action` reasons are the exception: `stale_ref`,
`ax_unreachable`, `ax_action_unsupported` and `human_consent_required`. The
Host raises them before any Accessibility call that may have acted, and keeps
its lease. The broker returns them as that action's error response and stops
the batch there. The lane, lease and executor stay (#159). A Host that predates
this change ends its lease with the refusal. The broker reads that state from
`health` and begins a new activity on the next batch. Secret providers run
only after every pre-admission refusal has passed.

## FuzzyBot spell

Fruitctl Host remains an unqualified source prototype. Public runtime previews
include no Host binary, installer, background service or generated helper
mapping. Its signed development copies remain private until the exact capture
mode passes exclusion, input mapping, lifecycle and permission qualification.
Signing or notarization cannot enable this feature or supply macOS consent.

Future Host rollout requires launching the app bundle through LaunchServices in
the logged-in GUI session, checking the app returned by
[NSWorkspace](https://developer.apple.com/documentation/appkit/nsworkspace/openapplication%28at%3Aconfiguration%3Acompletionhandler%3A%29),
and verifying the privacy-responsible code and capture permission. In an attended
trial, direct `Contents/MacOS` execution over SSH was attributed to the remote
service; the Host's existing grant did not establish that invocation's access.
Apple's [responsibility-tracking guidance](https://developer.apple.com/forums/thread/125438)
explains the attribution boundary. Host capture and privacy qualification remain pending,
and no automatic permission grant is provided.

Permission provisioning is a separate, attended step. Apple's
[PPPC schema](https://raw.githubusercontent.com/apple/device-management/release/mdm/profiles/com.apple.TCC.configuration-profile-policy.yaml)
does not allow a profile to silently grant Screen Capture. A user-approved MDM
policy may let a standard user configure that service with
`AllowStandardUserToSetSystemService`; this authorizes the user's choice rather
than granting recording access. Accessibility and event-posting policies are
separate permissions, not substitutes for Screen Capture approval.

Managed alert suppression is another separate policy. Apple's
[Restrictions schema](https://raw.githubusercontent.com/apple/device-management/release/mdm/profiles/com.apple.applicationaccess.yaml)
defines `forceBypassScreenCaptureAlert` from macOS 15.1; it suppresses presentation
of a capture alert and is unavailable through manual profile installation or
User Enrollment. It does not supply the Screen Capture grant described above.
The ordinary Host capture path still requires the target user's attended
permission choice; managed policy belongs to the device-management owner.

Apple's [Persistent Content Capture entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
is available from macOS 14.4 for VNC applications. It requires Apple permission
and the approved capability in the app's Xcode profile. This is a reviewed
capability route, not an ordinary TCC bypass or a headless grant. Fruitctl's
public preview supplies neither that approval nor Screen Capture provisioning.

The [macOS permissions guide](permissions.md) carries the unmanaged consent
procedure, managed-device prerequisites, signed-identity verification and
Account Holder request checklist. Its
[standard-user policy template](permissions/fruitctl-standard-user.mobileconfig.example)
contains only the Screen Capture policy that lets the user choose; an MDM
administrator must bind it to the exact signed app before deployment.

The target-side indicator draws an edge-feathered deep purple pulse with the
centered message: “Machine under FuzzyBot spell, courtesy xoxd.ai)”. It accepts
no pointer or keyboard input and respects a reduced-motion setting. Human stop
remains available through an accessible local control.
Local Stop revokes agent control for the running FruitctlHost session and stays
in force through controller reconnect or wake. Restarting FruitctlHost allows
control again; Stop is not persisted across app restarts. Capture opt-in,
macOS capture consent and fresh controller lease checks remain separate
requirements.
The intended animation has a 72 BPM pulse cycle. Qualification records physical
pulse rate and timing uncertainty; reduced-motion static indication is a
separate case. A renderer timer or a ready acknowledgement alone cannot prove
what the person sees.

The indicator must remain absent from every frame delivered to the agent while
remaining visible to a person at the machine. Window sharing flags alone are
not proof that VNC excludes it. The qualification lane uses filtered
ScreenCaptureKit observations and records a simultaneous human-display and
agent-frame comparison. Raw VNC mode does not enable the overlay until that
mode passes the same exclusion proof. Hiding the overlay during capture or
masking its pixels is outside the capture contract.

The helper attaches over SSH to an already installed, resident target app
through its `--stdio` interface. That attachment does not launch the app, grant
macOS consent, or install it. Helper screenshots use owned filtered capture;
input remains on the VNC client and requires a measured mapping between those
observations and the VNC desktop. Until the installed path has an exclusion and
mapping receipt, treat it as an unqualified preview.

Current Host source obtains one `CMSampleBuffer` from
`SCScreenshotManager.captureSampleBuffer`, copies its bounded BGRA pixels into
owned storage and encodes the requested image from that copy: PNG when the
request names no `format`, or JPEG at quality 0.85 for model-facing frames
(D38). The accompanying
`native_frame_timing` metadata retains that sample's presentation time, optional
WindowServer display time, and separate request/completion brackets from the
CoreMedia host clock. Integer timestamp values and epochs are decimal strings
so JSON consumers can preserve their precision.

These fields support capture qualification; they do not establish frame
freshness. Metadata explicitly reports `freshness: unknown`, an unverified
native-to-host clock relation and unverified WindowServer display-time units.
RPC completion time is not the acquisition time, and the CoreMedia host clock
must not be equated with the Host's process-relative `ContinuousClock` Stop
diagnostics. A separate pure
classifier can reject stale, future or nonadvancing samples only after a
qualification establishes the actual clock relation. Ordinary static capture
does not use that classifier. This source change supplies no signed Host
release or physical capture acceptance.

## Compatibility and release boundary

Keep legacy executable aliases and the compatible signed application identity
during the refactor. Publish signed bytes with exact source revision, checksums,
and provenance. Consumers do not modify or re-sign those artifacts. macOS user
consent remains separate from code-signing and notarization.

The shared broker, Linux bridge, and optional target app are preview
implementation lanes. Their source and offline checks do not constitute a
qualified runtime release. This architecture states their contract; the
[compatibility matrix](compatibility.md) limits claims to released and qualified
combinations.
