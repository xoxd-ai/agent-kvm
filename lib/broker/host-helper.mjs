// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { crc32, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { NdjsonParser, ResponseBudget, responseMetadata } from '../mcp/protocol.js';
import { retirementDeadline } from '../deadlines.mjs';
// Host element actions are not VNC input; they have their own route below.
import { nativeCapabilities, preAdmissionRefusal, VNC_INPUT_ACTIONS as INPUT_ACTIONS, clipboardReadRefusal,
  CLIPBOARD_UNAVAILABLE_CODE, HUMAN_CONSENT_REQUIRED_CODE, hostOnlyDragOptions } from '../mcp/capabilities.js';

// Reads of native input state, meaningful only once input mapping is qualified.
const MAPPED_READ_ACTIONS = new Set(['cursor_position']);
const HOLD_ACTIONS = new Set(['mouse_down', 'mouse_up']);
// TIN-5385: a VNC pointer move outside a hold scope presses no button or key.
const POINTER_MOVES = new Set(['mouse_move', 'hover']);
// Native reads that need neither pixels nor the input mapping (D8). The
// native executor applies the target's clipboard policy and redaction.
const NATIVE_READ_ACTIONS = new Set(['clipboard_read']);
// Observations computed from raw VNC pixels. The Host route answers screenshot
// from its own ScreenCaptureKit image and never falls back to VNC pixels for
// these, so it refuses them before admission as unsupported_on_route.
const RAW_OBSERVATION_ACTIONS = new Set(['cursor_crop', 'diff_check', 'set_baseline', 'detect_elements',
  'zoom', 'wait_for_stable', 'expect_baseline', 'expect_change']);
// Served by the Host itself rather than the native VNC executor.
const HOST_ACTIONS = new Set(['screenshot', 'ax_snapshot', 'click_element', 'focus_element', 'show_menu_element',
  'set_element_value', 'step_element', 'enter_element_value']);
// #161: element value actions. The Host sets AXValue, or steps it with
// AXIncrement or AXDecrement, on a value control of a hostInput application.
const HOST_VALUE_ACTIONS = new Set(['set_element_value', 'step_element', 'enter_element_value']);
// #181: what the Host accepts as a short numeric entry, without its comma.
const HOST_ENTRY_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const HOST_ENTRY_MAX_TEXT = 16;
// A channel strip's direct children, read at depth 1.
const HOST_ENTRY_STRIP_NODES = 256;
// A readout opens after its double-click. The lane's manual route left 1 to 4 s.
const HOST_ENTRY_OPEN_SETTLE_MS = 500;
const HOST_ENTRY_OPEN_RETRY_MS = 1500;
const HOST_ENTRY_OPEN_POLL_MS = 250;
const HOST_VALUE_MAX_STEPS = 10;
const HOST_VALUE_MAX_TEXT = 256;
// The Host refuses these before its first AX call that could change the
// element, and keeps its lease.
const HOST_VALUE_REFUSALS = new Set(['input_disabled', 'secure_input_active', 'input_target_mismatch',
  'operator_input_detected', 'operator_input_monitor_unavailable', 'stale_ref', 'ax_unreachable',
  'ax_action_unsupported', HUMAN_CONSENT_REQUIRED_CODE]);
const HOST_VALUE_OWNERS = new Set(['target', 'au_hosting_service', 'target_child']);
// #157: VNC-schema input actions the Host posts itself on a Host-only
// target, and the Host input kind for each. activate_app exists only here.
const HOST_INPUT_ACTIONS = new Map([['mouse_click', 'click'], ['mouse_double_click', 'double_click'],
  ['triple_click', 'triple_click'], ['mouse_move', 'move'], ['hover', 'move'], ['mouse_drag', 'drag'],
  ['scroll', 'scroll'], ['key_tap', 'key'], ['key_combo', 'key'], ['key_type', 'type'], ['activate_app', 'activate']]);
// The Host refuses these before it posts any event, and keeps its lease.
const HOST_INPUT_REFUSALS = new Set(['input_disabled', 'input_permission_required', 'secure_input_active',
  'input_target_mismatch', 'input_window_mismatch', 'operator_input_detected', 'operator_input_monitor_unavailable',
  'input_focus_unavailable', 'input_system_shortcut', 'input_screen_edge', HUMAN_CONSENT_REQUIRED_CODE]);
// After a newline or tab moves focus, the next text request waits this long
// so the Host re-reads focus and secure input once the app has handled it.
const HOST_INPUT_FOCUS_SETTLE_MS = 150;
// The readback frame follows the last event by at least this long.
const HOST_INPUT_READBACK_SETTLE_MS = 150;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// One Host input request plans at most 1.6 s of events and the Host answers
// within 2.5 s or drops the connection.
const HOST_INPUT_TIMEOUT_MS = 2400;
// key_type text is sent in chunks the Host accepts (64 characters).
const HOST_INPUT_TEXT_CHUNK = 32;
// The Host accepts at most 256 UTF-16 units per request; one grapheme may use
// at most 64 of them (review N3).
const HOST_INPUT_TEXT_UNITS = 200;
const HOST_INPUT_GRAPHEME_UNITS = 64;
const MAX_HOST_INPUT_TEXT = 4096;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;
const HOST_KEY_NAME = /^(?:[a-z][a-z0-9]{0,15}|[\x21-\x7e])$/i;
const HOST_MODIFIERS = new Set(['shift', 'rshift', 'ctrl', 'control', 'rctrl', 'alt', 'option', 'opt', 'ralt',
  'cmd', 'command', 'meta', 'super', 'rcmd']);

/** #163: which windows Host captures keep. `target` keeps only the named
 * applications (default: the hostInput applications); `display` keeps the
 * display minus the Host's fixed private list and `exclude`. */
export function normalizeHostCapturePolicy(policy, hostInput) {
  const keys = ['scope', 'applications', 'exclude'];
  const list = value => value === undefined || (Array.isArray(value) && value.length > 0 && value.length <= 16 &&
    value.every(app => typeof app === 'string' && app.length <= 255 && BUNDLE_ID.test(app)) &&
    new Set(value).size === value.length);
  if (policy !== undefined && (!object(policy) || Object.keys(policy).some(key => !keys.includes(key)) ||
      (policy.scope !== undefined && !['target', 'display'].includes(policy.scope)) ||
      !list(policy.applications) || !list(policy.exclude) ||
      (policy.scope === 'display' && policy.applications !== undefined) ||
      (policy.scope !== 'display' && policy.exclude !== undefined))) {
    throw new Error('Invalid Host-only hostCapture policy');
  }
  const applications = policy?.applications ?? hostInput?.applications;
  const scope = policy?.scope ?? (applications ? 'target' : 'display');
  if (scope === 'target' && !applications) throw new Error('Invalid Host-only hostCapture policy');
  return Object.freeze(scope === 'target' ? { scope, applications: Object.freeze([...applications]) }
    : { scope, ...(policy?.exclude ? { exclude: Object.freeze([...policy.exclude]) } : {}) });
}

/** The operator's Host input policy for a Host-only target (#157). */
export function normalizeHostInputPolicy(policy) {
  if (policy === undefined) return undefined;
  const keys = ['applications', 'operatorInput', 'operatorIdleMs'];
  if (!object(policy) || Object.keys(policy).some(key => !keys.includes(key)) ||
      !Array.isArray(policy.applications) || !policy.applications.length || policy.applications.length > 16 ||
      policy.applications.some(app => typeof app !== 'string' || app.length > 255 || !BUNDLE_ID.test(app)) ||
      new Set(policy.applications).size !== policy.applications.length ||
      (policy.operatorInput !== undefined && !['yield', 'assert'].includes(policy.operatorInput)) ||
      (policy.operatorIdleMs !== undefined && (!Number.isSafeInteger(policy.operatorIdleMs) ||
        policy.operatorIdleMs < 0 || policy.operatorIdleMs > 10000))) {
    throw new Error('Invalid Host-only hostInput policy');
  }
  return Object.freeze({ applications: Object.freeze([...policy.applications]),
    operatorInput: policy.operatorInput ?? 'yield', operatorIdleMs: policy.operatorIdleMs ?? 1000 });
}

// Ref-addressed element actions and the Host's AX action kind for each.
const AX_ELEMENT_ACTIONS = new Map([['click_element', 'press'], ['focus_element', 'focus'],
  ['show_menu_element', 'show_menu']]);
const AX_PATHS = { press: new Set(['ax_press', 'ax_show_menu']), focus: new Set(['ax_focus', 'ax_raise']),
  show_menu: new Set(['ax_show_menu']) };
const AX_FALLBACK_PATH = 'vnc_click_required';
const AX_SURFACES = new Set(['control_center', 'menu_extra', 'menu', 'menu_bar', 'popover', 'sheet', 'window',
  'application']);
const HELPER_TIMEOUT_MS = 500;
// The first request also pays SSH connection setup and the remote exec,
// measured at 0.5-0.9 s over a tailnet; warm round trips take milliseconds.
const HELPER_CONNECT_TIMEOUT_MS = 5000;
// begin_activity takes an excluded-app snapshot and shows the overlay before
// it answers: 490-535 ms on PZM, before any link latency.
const HELPER_BEGIN_TIMEOUT_MS = 2000;
// An observation carries a freshly encoded PNG: 1-3.5 s at 1080p over SSH,
// and longer on a slow link. Its first byte must arrive within the stall
// window (the Host finishes or drops a request within 2.5 s), and the reply
// must keep arriving with no gap longer than that, up to the hard cap.
const HELPER_OBSERVATION_STALL_MS = 3000;
const HELPER_OBSERVATION_TIMEOUT_MS = 20000;
// Asked of a Host that reports reply_parts, so a renewal reply can travel
// between the parts of a large image on a slow link.
const HELPER_REPLY_PART_BYTES = 65536;
const RENEW_INTERVAL_MS = 500;
// #177: a Host-only executor releases the Host activity (indicator, lease and
// element refs) this long after the last agent request ends, so a stalled or
// vanished agent does not keep the target indicated. The next request begins
// a new activity. The lane keeps its owner and executor.
const HOST_ACTIVITY_IDLE_MS = 10000;
const IDLE_RELEASE_TIMEOUT_MS = 2000;
const INPUT_PERMIT_MS = 1000;
const MAX_LEASE_MS = 3000;
const NATIVE_PERMIT_PROTOCOL = 'fruitctl.native-input-permit.v1';
const NATIVE_GEOMETRY_FIELDS = ['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight',
  'connectionGeneration', 'allocation'];
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const MAX_ISSUED_CHALLENGES = 128;
const CAPTURE_REASONS = new Set(['capture_not_enabled', 'screen_capture_permission_required', 'capture_target_unavailable',
  'configured_display_unavailable', 'own_application_exclusion_unavailable',
  'incomplete_capture', 'capture_failed', 'image_encoding_failed']);
// Host refusals an agent can act on keep their reason as the error code. An
// element owned by a consent or system dialog is refused by the Host with the
// desktop-state sentinel's own code, even when the sentinel read nothing.
const AX_TYPED_REASONS = new Set(['accessibility_permission_required', 'stale_ref', 'ax_unreachable',
  'ax_action_unsupported', HUMAN_CONSENT_REQUIRED_CODE, 'accessibility_root_unavailable', 'capture_target_unavailable']);
// #158: a snapshot root the Host could not resolve; nothing was read.
const AX_SNAPSHOT_REFUSALS = new Set(['stale_ref', 'accessibility_root_unavailable']);
const HOST_INPUT_REASONS = ['input_disabled', 'input_permission_required', 'secure_input_active',
  'input_target_mismatch', 'input_window_mismatch', 'operator_input_detected', 'operator_input_monitor_unavailable',
  'input_focus_unavailable', 'input_system_shortcut', 'input_screen_edge'];
const REFUSAL_REASONS = new Set([...CAPTURE_REASONS, ...AX_TYPED_REASONS, ...HOST_INPUT_REASONS, 'host_busy',
  'agent_idle_released', 'accessibility_application_unavailable']);
// The Host raises these before any Accessibility call that may have acted.
// They end the batch as a per-call error and keep the lane, lease and
// executor (#159). A missing grant is refused before admission instead.
const AX_PRE_ACT_REFUSALS = new Set(['stale_ref', 'ax_unreachable', 'ax_action_unsupported',
  HUMAN_CONSENT_REQUIRED_CODE]);
// Responses this module built from a pending-matched pre-act refusal. Only
// they end a batch without retiring it; a native or forged error never does.
const perCallRefusals = new WeakSet();
// A per-call refusal travels as this JSON-RPC integer with its typed reason
// in data.code, so MCP clients that accept only integer codes still read it.
export const PER_CALL_REFUSAL_CODE = -32020;
const CAPTURE_PHASES = new Set(['shareable_content', 'capture_image']);
const APPLE_ERROR_DOMAINS = new Set(['SCStreamErrorDomain', 'NSCocoaErrorDomain',
  'NSPOSIXErrorDomain', 'NSOSStatusErrorDomain']);
const CAPTURE_DIAGNOSTIC_FIELDS = new Set(['schema', 'phase', 'apple_domain', 'apple_code']);
const sanitizedRefusals = new WeakMap();
// Only this module's pending-matched native replies and local call sites can
// brand a cause. Mutable Error fields and remote free text never become one.
const failureCauses = new WeakMap();
const failurePhases = new Set(['operation', 'host_helper', 'host_activity', 'native_permit_begin',
  'native_permit_grant', 'mapping_capture', 'mapping_health', 'observation_adopt', 'native_input', 'native_read']);
const failureReasons = new Set(['unknown', 'permit_expired', 'permit_terminal', 'deadline', 'cancelled',
  'challenge_budget', 'transport', 'protocol', 'receipt_mismatch', 'geometry_mismatch', 'context_changed',
  'native_refused', 'input_not_ready', 'grant_rejected', 'sequence_rejected', 'held_input_unconfirmed', 'helper_refused']);
const nativeErrorCodes = new Set([-32700, -32600, -32601, -32602, -32603, -32000, -32010, -32013]);
const nativeRefusalReasons = new Map([
  ['Observed display changed; take a new screenshot before input', 'context_changed'],
  ['External observation does not match the current VNC allocation', 'context_changed'],
  ['Pointer coordinates outside current framebuffer', 'geometry_mismatch'],
  ['Native input permit expired', 'permit_expired'],
  ['Native input permit expired before grant', 'permit_expired'],
  ['Native input permit is terminal; reconcile this owned session', 'permit_terminal'],
  ['Native input permit challenge deadline exceeded', 'deadline'],
  ['Native input permit grant binding or challenge deadline failed', 'grant_rejected'],
  ['Native input permit challenge sequence was replayed or remains pending', 'sequence_rejected'],
  ['Native input permit owner or geometry changed', 'geometry_mismatch'],
  ['Native input permit adopted coordinate mapping changed', 'geometry_mismatch'],
  ['Native input permit does not match the adopted coordinate mapping', 'context_changed'],
  ['Native input permit is ungranted or does not match the observed allocation', 'context_changed'],
  ['Previous input release is unconfirmed; reconcile the target before continuing', 'held_input_unconfirmed'],
  ['Batch-scoped mouse hold release could not be confirmed', 'held_input_unconfirmed'],
]);
const localFailureReasons = new Map([
  ['Host-helper input permit expired', 'permit_expired'],
  ['Host-helper transport ended', 'transport'],
  ['Host-helper transport exited', 'transport'],
  ['Host-helper transport failed', 'transport'],
  ['Host-helper input failed', 'transport'],
  ['Invalid host-helper protocol', 'protocol'],
  ['Host-helper receipt deadline exceeded', 'deadline'],
  ['Native input-permit control deadline exceeded', 'deadline'],
  ['Native input-permit grant deadline exceeded', 'deadline'],
  ['Host-helper operation deadline exceeded', 'deadline'],
  ['Native input-permit control cancelled', 'cancelled'],
  ['Host-helper operation cancelled', 'cancelled'],
  ['Host-helper observation challenge budget exceeded', 'challenge_budget'],
]);
function tagFailure(error, phase, reason, nativeCode) {
  if (!error || typeof error !== 'object') error = new Error('Host operation failed');
  if (!failureCauses.has(error)) failureCauses.set(error, Object.freeze({
    phase: failurePhases.has(phase) ? phase : 'operation', reason: failureReasons.has(reason) ? reason : 'unknown',
    ...(nativeErrorCodes.has(nativeCode) ? { native_code: nativeCode } : {}) }));
  return error;
}
export function hostHelperFailureCause(error) { return failureCauses.get(error); }
function nativeFailure(phase, nativeError, message) {
  // The verified native controller wraps sendFailed with this fixed prefix.
  const text = typeof nativeError?.message === 'string' ? nativeError.message : '';
  const prefix = 'Failed to send VNC event: ';
  const detail = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  const reason = nativeError?.code === -32013 && nativeError?.data?.reason === 'input_not_ready'
    ? 'input_not_ready' : nativeRefusalReasons.get(detail) ?? 'native_refused';
  return tagFailure(new Error(message), phase, reason, nativeError?.code);
}

const inflateAsync = promisify(inflate);
const integer = (value, minimum = 1) => Number.isSafeInteger(value) && value >= minimum;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sameBounds = (left, right) => object(left) && object(right) &&
  ['x', 'y', 'width', 'height'].every(key => Number.isFinite(left[key]) && left[key] === right[key]);
// The Host canonicalizes CoreGraphics display UUIDs to uppercase.
const DISPLAY_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const validScale = value => Number.isFinite(value) && value >= 1 && value <= 8;
const AX_SCHEMA = 'fruitctl.ax-snapshot.v1';
const AX_MAX_NODES = 1500;
const AX_MAX_DEPTH = 12;
// A subtree snapshot extends its root's path (#158): up to 32 parts, 128 bytes.
const AX_REF = /^ax:[0-9]{1,10}:0(\.[0-9]{1,3}){0,32}$/;
const validRef = ref => typeof ref === 'string' && ref.length <= 128 && AX_REF.test(ref);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Only locally constructed, pending-matched refusals and the broker's own
// fixed failure strings can accompany a broker cleanup failure. Keep the
// validated text separate from mutable Error fields.
export function hostHelperRefusalMessage(error) {
  return sanitizedRefusals.get(error);
}

// A failure this module detected itself, such as a missed deadline or a lost
// transport. Its text is a literal from this file, never remote content.
function localFailure(message) {
  const error = new Error(message);
  sanitizedRefusals.set(error, message);
  return tagFailure(error, 'host_helper', localFailureReasons.get(message) ?? 'unknown');
}

// #182: what the window under the pointer was when the Host refused. System
// facts only: identifiers, level and bounds, never a title or pixels.
const WINDOW_DETAIL_SCHEMA = 'fruitctl.host-window-refusal.v1';
const WINDOW_DETAIL_KEYS = new Set(['schema', 'owner_pid', 'owner_name', 'owner_bundle_id', 'owner_code_id',
  'window_server', 'layer', 'bounds', 'parent_owner_pid', 'frontmost_pid']);
export function windowRefusalDetail(data) {
  const optionalInteger = value => value === undefined || value === null || Number.isSafeInteger(value);
  const optionalName = value => value === undefined || value === null ||
    (typeof value === 'string' && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value));
  const optionalBundle = value => value === undefined || value === null ||
    (typeof value === 'string' && value.length <= 255 && BUNDLE_ID.test(value));
  const bounds = data?.bounds;
  if (!object(data) || data.schema !== WINDOW_DETAIL_SCHEMA ||
      Object.keys(data).some(key => !WINDOW_DETAIL_KEYS.has(key)) || !optionalInteger(data.owner_pid) ||
      !optionalName(data.owner_name) || !optionalBundle(data.owner_bundle_id) || !optionalBundle(data.owner_code_id) ||
      typeof data.window_server !== 'boolean' || !optionalInteger(data.layer) ||
      !optionalInteger(data.parent_owner_pid) || !optionalInteger(data.frontmost_pid) ||
      (bounds !== undefined && !(object(bounds) && Object.keys(bounds).length === 4 &&
        ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key]))))) return undefined;
  const { schema: _schema, ...detail } = data;
  return Object.freeze(detail);
}

function helperRefusal(error, requestId) {
  const prefix = 'Host helper refused request';
  // Correlation comes only from our locally generated, pending-matched UUID.
  // Neither remote free text nor an arbitrary error object crosses this seam.
  if (!REFUSAL_REASONS.has(error.message) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return tagFailure(new Error(prefix), 'host_helper', 'helper_refused');
  }
  const parts = [`${prefix}: ${error.message}`];
  const data = error.data;
  if (object(data) && data.schema === 'fruitctl.host-capture-error.v1' &&
      CAPTURE_PHASES.has(data.phase) && Object.keys(data).length <= 4 &&
      Object.keys(data).every(key => CAPTURE_DIAGNOSTIC_FIELDS.has(key)) &&
      (!Object.hasOwn(data, 'apple_domain') || APPLE_ERROR_DOMAINS.has(data.apple_domain)) &&
      (!Object.hasOwn(data, 'apple_code') ||
        (Object.hasOwn(data, 'apple_domain') && Number.isInteger(data.apple_code) &&
          data.apple_code >= -2147483648 && data.apple_code <= 2147483647))) {
    parts.push(`phase=${data.phase}`);
    if (Object.hasOwn(data, 'apple_domain')) parts.push(`apple_domain=${data.apple_domain}`);
    if (Object.hasOwn(data, 'apple_code')) parts.push(`apple_code=${data.apple_code}`);
  }
  parts.push(`request=${requestId}`);
  const message = parts.join('; ');
  const refusal = new Error(message.length <= 320 ? message : prefix);
  // A typed code never exempts the lane from retirement; only local
  // pre-admission refusals carry that brand.
  if (AX_TYPED_REASONS.has(error.message) || HOST_INPUT_REASONS.includes(error.message)) refusal.code = error.message;
  if (error.message === HUMAN_CONSENT_REQUIRED_CODE) refusal.data = { reason: HUMAN_CONSENT_REQUIRED_CODE };
  // #177: another session holds the Host's lease; the executor decides.
  if (error.message === 'host_busy') refusal.code = 'host_busy';
  // #185: the Host ended an activity whose owner sent no agent request for 660 s.
  if (error.message === 'agent_idle_released') refusal.code = 'agent_idle_released';
  if (error.message === 'input_window_mismatch') {
    const window = windowRefusalDetail(error.data);
    if (window) refusal.data = { window };
  }
  sanitizedRefusals.set(refusal, refusal.message);
  return tagFailure(refusal, 'host_helper', 'helper_refused');
}

// A display is named by its ID, its CoreGraphics UUID, or both. The UUID
// survives display-ID changes across reconnects; the Host resolves it.
export function normalizeHostHelperConfiguration(config) {
  if (!object(config) || typeof config.sshHost !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@:[\]-]{0,255}$/.test(config.sshHost) ||
      !Array.isArray(config.command) || config.command.length !== 2 ||
      typeof config.command[0] !== 'string' || !config.command[0].startsWith('/') ||
      !config.command[0].endsWith('/FruitctlHost') ||
      /[\x00-\x1f\x7f]/.test(config.command[0]) || config.command[1] !== '--stdio' ||
      (config.displayId !== undefined && !integer(config.displayId)) ||
      (config.displayUuid !== undefined && (typeof config.displayUuid !== 'string' ||
        !DISPLAY_UUID.test(config.displayUuid.toUpperCase()))) ||
      (config.displayId === undefined && config.displayUuid === undefined)) {
    throw new Error('Invalid host-helper configuration');
  }
  const normalized = structuredClone(config);
  if (normalized.displayUuid !== undefined) normalized.displayUuid = normalized.displayUuid.toUpperCase();
  if (normalized.mapping !== undefined) {
    const mapping = normalized.mapping;
    if (object(mapping) && typeof mapping.displayUuid === 'string') {
      mapping.displayUuid = mapping.displayUuid.toUpperCase();
    }
    if (!object(mapping) || typeof mapping.qualificationReceipt !== 'string' ||
        !mapping.qualificationReceipt.trim() || mapping.displayId !== normalized.displayId ||
        mapping.displayUuid !== normalized.displayUuid ||
        (mapping.scale !== undefined && !validScale(mapping.scale)) ||
        !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => integer(mapping[key])) ||
        !sameBounds(mapping.displayBounds, mapping.displayBounds) ||
        mapping.displayBounds.width <= 0 || mapping.displayBounds.height <= 0) {
      throw new Error('Invalid qualified host-helper mapping');
    }
  }
  return normalized;
}

/** The executable's --stdio mode only attaches to a resident same-user app.
 * No opener, bootstrap, service restart, remote shell script, or GUI launch. */
class HelperChannel {
  constructor(config, spawnImpl, onFailure, now) {
    this.pending = new Map();
    this.onFailure = onFailure;
    this.now = now;
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    this.child = spawnImpl('ssh', ['-T', '-oBatchMode=yes', '-oForwardAgent=no',
      '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none', '-oControlPersist=no',
      '--', config.sshHost, config.command.map(shellQuote).join(' ')],
    { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.childClosed = new Promise(resolve => this.child.once('close', resolve));
    const parser = new NdjsonParser(message => this.receive(message),
      { maxFrameBytes: MAX_IMAGE_BYTES * 2 });
    this.parser = parser;
    this.child.stdout.on('data', chunk => {
      try {
        parser.push(chunk);
        // Only bytes of a reply still in transit count as progress. Another
        // request's complete small reply does not extend a stalled one.
        if (parser.bytes) for (const pending of this.pending.values()) pending.progress?.();
        // Large capture frames should not pin their high-water backing buffer
        // throughout the idle broker lifetime after the image is consumed.
        if (!parser.bytes && parser.buffer.length > 65536) parser.buffer = Buffer.alloc(0);
      } catch { this.fail(localFailure('Invalid host-helper protocol')); }
    });
    this.child.stdout.once('end', () => {
      try { parser.end(); } catch { /* the transport is rejected either way */ }
      this.fail(localFailure('Host-helper transport ended'));
    });
    // Never relay arbitrary remote stderr or protocol values into receipts.
    this.child.stderr?.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(localFailure('Host-helper input failed')));
    this.child.once('error', () => this.fail(localFailure('Host-helper transport failed')));
    this.child.once('exit', () => this.fail(localFailure('Host-helper transport exited')));
  }

  receive(message) {
    if (this.failed || this.closed) return false;
    if (object(message) && message.part !== undefined) return this.receivePart(message);
    if (!object(message) || typeof message.id !== 'string' || !this.pending.has(message.id) ||
        typeof message.success !== 'boolean' ||
        (message.success ? !object(message.result) || message.error !== undefined : !object(message.error))) {
      throw new Error('Invalid host-helper response');
    }
    const pending = this.pending.get(message.id);
    const parts = pending.parts;
    if (parts && (parts.data.length || message.result?.image_parts !== undefined)) {
      // A split reply names exactly the parts received, and only they hold
      // the image. Validation of the joined image is unchanged.
      if (!message.success || message.result.image !== undefined ||
          message.result.image_parts !== parts.data.length) throw new Error('Invalid host-helper response');
      const { image_parts: _count, ...result } = message.result;
      message.result = { ...result, image: parts.data.join('') };
    } else if (message.result?.image_parts !== undefined) throw new Error('Invalid host-helper response');
    this.pending.delete(message.id);
    pending.finish(message.success ? null : helperRefusal(message.error, message.id), message.result);
  }

  receivePart(message) {
    const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    const parts = pending?.parts;
    const part = message.part;
    if (!parts || Object.keys(message).length !== 2 || !object(part) || Object.keys(part).length !== 2 ||
        part.index !== parts.data.length || typeof part.data !== 'string' || !part.data.length ||
        part.data.length > parts.bytes || parts.size + part.data.length > MAX_IMAGE_BYTES * 4 / 3 + 4 ||
        // No more parts than the largest image needs at the requested size,
        // so a Host cannot hold the reply as millions of tiny strings.
        parts.data.length >= Math.ceil((MAX_IMAGE_BYTES * 4 / 3 + 4) / parts.bytes)) {
      throw new Error('Invalid host-helper response');
    }
    parts.data.push(part.data);
    parts.size += part.data.length;
    pending.progress?.();
    return true;
  }

  // With stallMs, timeoutMs is a hard cap and the deadline follows arriving
  // bytes: no gap may exceed stallMs. partBytes accepts a split image reply.
  request(action, params, { signal, timeoutMs = HELPER_TIMEOUT_MS, stallMs, partBytes } = {}) {
    if (this.failed || this.closed) return Promise.reject(this.failed || new Error('Host-helper channel closed'));
    if (signal?.aborted) return Promise.reject(new Error('Host-helper request cancelled'));
    const id = randomUUID();
    const sentAt = this.now();
    if (partBytes !== undefined) params = { ...params, reply_part_bytes: partBytes };
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve({ result, sentAt, roundTripMs: this.now() - sentAt });
      };
      const abort = () => this.fail(new Error('Host-helper request cancelled'));
      const expire = () => this.fail(localFailure('Host-helper receipt deadline exceeded'));
      const arm = from => {
        clearTimeout(timer);
        const wait = stallMs === undefined ? timeoutMs : Math.min(stallMs, sentAt + timeoutMs - from);
        timer = setTimeout(expire, Math.max(0, wait));
      };
      this.pending.set(id, { finish,
        ...(stallMs === undefined ? {} : { progress: () => arm(this.now()) }),
        ...(partBytes === undefined ? {} : { parts: { bytes: partBytes, data: [], size: 0 } }) });
      signal?.addEventListener('abort', abort, { once: true });
      arm(sentAt);
      this.child.stdin.write(JSON.stringify({ action, params, id }) + '\n', error => {
        if (error) this.fail(localFailure('Host-helper input failed'));
      });
    });
  }

  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = error;
    for (const pending of this.pending.values()) pending.finish(error);
    this.pending.clear();
    this.onFailure(error);
    void this.close().catch(() => {});
  }

  close({ signal, timeoutMs = 1250, deadline } = {}) {
    let cutoff;
    try {
      const now = this.now();
      cutoff = Math.min(now + 1250, retirementDeadline({ timeoutMs, deadline, now }));
    } catch (error) { return Promise.reject(error); }
    this.closeDeadline = Math.min(this.closeDeadline ?? Infinity, cutoff);
    const alive = () => this.child.exitCode === null && this.child.signalCode === null;
    if (!this.closing) {
      this.closed = true;
      this.parser?.stop();
      for (const pending of this.pending.values()) pending.finish(new Error('Host-helper channel closed'));
      this.pending.clear();
      const listeners = [];
      const failure = Object.assign(new Error('Host-helper owned SSH exit unconfirmed'), { code: 'release_unconfirmed' });
      this.forceClose = () => {
        if (alive() && !this.closeKillSent) {
          this.closeKillSent = true;
          try { this.child.kill('SIGKILL'); } catch { /* A signal is not exit proof. */ }
        }
      };
      const interrupted = new Promise((_, reject) => {
        this.abortClose = () => { this.forceClose(); reject(failure); };
      });
      this.observeCloseSignal = observed => {
        if (!observed) return;
        const abort = this.abortClose;
        listeners.push([observed, abort]);
        observed.addEventListener('abort', abort, { once: true });
        if (observed.aborted) abort();
      };
      const actualClosure = this.childClosed.then(() => {
        if (this.now() >= this.closeDeadline) throw failure;
      });
      this.closing = Promise.race([actualClosure, interrupted]).finally(() => {
        clearTimeout(this.forceCloseTimer); clearTimeout(this.closeTimer);
        for (const [observed, abort] of listeners) observed.removeEventListener('abort', abort);
        this.observeCloseSignal = null;
      });
      // Keep the actual childClosed promise and sticky closing result even
      // when a caller's shorter inherited cutoff cannot confirm exit.
      this.closing.catch(() => {});
      this.child.stdin.end();
      if (alive()) { try { this.child.kill('SIGTERM'); } catch { /* Await real close. */ } }
    }
    this.observeCloseSignal?.(signal);
    if (this.observeCloseSignal) {
      clearTimeout(this.forceCloseTimer); clearTimeout(this.closeTimer);
      const remaining = this.closeDeadline - this.now();
      if (remaining <= 0) this.abortClose();
      else {
        this.forceCloseTimer = setTimeout(this.forceClose, Math.min(250, remaining * 3 / 4));
        this.closeTimer = setTimeout(this.abortClose, remaining);
      }
    }
    return this.closing;
  }
}

function validateHealth(result, config) {
  if (!object(result) || typeof result.instance_id !== 'string' || !result.instance_id ||
      result.capture_backend !== 'owned_sck' || result.raw_vnc_exclusion !== false ||
      !integer(result.display_id) ||
      (config.displayId !== undefined && result.display_id !== config.displayId) ||
      (config.displayUuid !== undefined && result.display_uuid !== config.displayUuid) ||
      !integer(result.displayGeneration, 0) ||
      result.capture_enabled !== true || result.screen_capture_permission !== true ||
      result.renewal_interval_ms !== RENEW_INTERVAL_MS || result.input_permit_ms !== INPUT_PERMIT_MS ||
      result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS) throw new Error('Host-helper health binding failed');
  return result;
}

// `matches` names the activity sequence and challenge this receipt may echo.
function validateReady(receipt, owner, matches, { refreshPermit = true, roundTripMs = HELPER_TIMEOUT_MS,
  lapsed = false } = {}) {
  // A delayed renewal must not revive an expired input owner. Check at the
  // acknowledgement boundary as well as in the independent watchdog. Only a
  // permit lapsed under an observation is exempt; see permitExpired.
  if (!lapsed) owner.assertPermit();
  const result = receipt.result;
  if (!object(result) || receipt.roundTripMs > roundTripMs ||
      result.instance_id !== owner.instanceId || result.session_id !== owner.sessionId ||
      !matches(result.sequence, result.challenge) ||
      result.display_id !== owner.displayId || result.displayGeneration !== owner.generation ||
      (owner.config.displayUuid !== undefined && result.display_uuid !== owner.config.displayUuid) ||
      result.capture_backend !== 'owned_sck' || result.raw_vnc_exclusion !== false ||
      result.capture_enabled !== true || result.capture_ready !== true ||
      result.overlay_ready !== true || result.ready !== true ||
      !integer(result.ui_heartbeat_age_ms, 0) || result.ui_heartbeat_age_ms > 250 ||
      !integer(result.lease_remaining_ms) || result.lease_remaining_ms > MAX_LEASE_MS ||
      result.renewal_interval_ms !== RENEW_INTERVAL_MS || result.input_permit_ms !== INPUT_PERMIT_MS ||
      result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS) throw tagFailure(new Error('Host-helper activity receipt mismatch'), 'host_activity', 'receipt_mismatch');
  owner.observeAccessibility(result);
  if (refreshPermit) owner.refreshPermit(Math.min(receipt.sentAt + INPUT_PERMIT_MS,
    receipt.sentAt + result.lease_remaining_ms), receipt.sentAt);
  return result;
}

function validateNativePermit(response, binding, challenge, granted = false) {
  const result = response?.result;
  const phase = granted ? 'native_permit_grant' : 'native_permit_begin';
  const message = `Native independent input-permit ${granted ? 'grant' : 'challenge'} unavailable or unconfirmed`;
  if (response?.error) throw nativeFailure(phase, response.error, message);
  if (!object(result) ||
      !Object.keys(binding).every(key => result[key] === binding[key]) ||
      typeof result.challenge !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.challenge) ||
      (challenge !== undefined && result.challenge !== challenge) ||
      result.native_permit_protocol !== NATIVE_PERMIT_PROTOCOL ||
      result.input_permit_ms !== INPUT_PERMIT_MS || result.maximum_round_trip_ms !== HELPER_TIMEOUT_MS ||
      !integer(result.native_permit_remaining_ms) || result.native_permit_remaining_ms > INPUT_PERMIT_MS) {
    throw tagFailure(new Error(message), phase, 'receipt_mismatch');
  }
  return result;
}

// Validate a complete decoded PNG before passing it to an agent. Node's native
// CRC and asynchronous bounded inflater keep large images off the JS heartbeat
// loop. The host encoder supplies pixels; no hiding or masking occurs here.
// D38: a JPEG frame keeps every geometry check; its structure is walked to
// the scan, the frame header must name the scaled size, and it must end with
// EOI. Entropy-coded pixels are not decoded here.
function validateJpeg(jpeg, width, height) {
  if (jpeg.length > MAX_IMAGE_BYTES || jpeg.length < 32 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ||
      jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) throw new Error('Invalid host-helper JPEG');
  let offset = 2;
  let frame = false;
  for (let segments = 0; segments < 4096 && offset + 4 <= jpeg.length; segments++) {
    if (jpeg[offset] !== 0xff) break;
    const marker = jpeg[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    // No standalone marker belongs before the scan.
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) break;
    const length = jpeg.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > jpeg.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const components = jpeg[offset + 9];
      // Huffman baseline, extended or progressive, 8-bit, gray or YCbCr.
      if (frame || marker > 0xc2 || length !== 8 + 3 * components || jpeg[offset + 4] !== 8 ||
          ![1, 3].includes(components) || jpeg.readUInt16BE(offset + 5) !== height ||
          jpeg.readUInt16BE(offset + 7) !== width) break;
      frame = true;
    }
    if (marker === 0xda) {
      if (frame && offset + 2 + length < jpeg.length - 2) return;
      break;
    }
    offset += 2 + length;
  }
  throw new Error('Invalid host-helper JPEG');
}

async function validateImage(result, maximumDimension, mimeType = 'image/png') {
  if (result.mimeType !== mimeType || typeof result.image !== 'string' ||
      !result.image.length || result.image.length > MAX_IMAGE_BYTES * 4 / 3 + 4 ||
      result.image.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.image) ||
      !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => integer(result[key])) ||
      result.nativeWidth > 16384 || result.nativeHeight > 16384 ||
      result.nativeWidth * result.nativeHeight > 33554432 ||
      result.scaledWidth > result.nativeWidth || result.scaledHeight > result.nativeHeight ||
      !sameBounds(result.display_bounds, result.display_bounds) ||
      result.display_bounds.width <= 0 || result.display_bounds.height <= 0 ||
      result.pixels_per_point_x !== result.nativeWidth / result.display_bounds.width ||
      result.pixels_per_point_y !== result.nativeHeight / result.display_bounds.height ||
      result.cursor_included !== true ||
      // Hosts that report mode geometry must agree with the capture: pixels
      // are the mode's pixel framebuffer and scale is pixels per point.
      (result.scale !== undefined && (!validScale(result.scale) ||
        result.scale !== result.pixels_per_point_x || result.pixel_width !== result.nativeWidth ||
        result.pixel_height !== result.nativeHeight))) throw new Error('Invalid host-helper capture geometry');
  const ratio = Math.min(1, maximumDimension / Math.max(result.nativeWidth, result.nativeHeight));
  if (result.scaledWidth !== Math.max(1, Math.round(result.nativeWidth * ratio)) ||
      result.scaledHeight !== Math.max(1, Math.round(result.nativeHeight * ratio))) {
    throw new Error('Host-helper capture scaling mismatch');
  }
  if (mimeType === 'image/jpeg') {
    validateJpeg(Buffer.from(result.image, 'base64'), result.scaledWidth, result.scaledHeight);
    return;
  }
  const png = Buffer.from(result.image, 'base64');
  if (png.length > MAX_IMAGE_BYTES || png.length < 45 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Invalid host-helper PNG');
  }
  let offset = 8;
  const compressed = [];
  let channels;
  let colorType;
  let hasPalette = false;
  let dataEnded = false;
  let chunks = 0;
  while (offset + 12 <= png.length) {
    // ImageIO emits a small chunk set; bound adversarial tiny-chunk work as
    // well as byte and pixel allocations on the shared broker thread.
    if (++chunks > 4096) break;
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length || length > MAX_IMAGE_BYTES) break;
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) ||
        (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))) break;
    if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) break;
    if (offset === 8 && (type !== 'IHDR' || length !== 13 ||
        png.readUInt32BE(offset + 8) !== result.scaledWidth ||
        png.readUInt32BE(offset + 12) !== result.scaledHeight)) break;
    if (type === 'IHDR') {
      if (offset !== 8 || png[offset + 16] !== 8 ||
          ![0, 2, 3, 4, 6].includes(png[offset + 17]) ||
          png[offset + 18] !== 0 || png[offset + 19] !== 0 || png[offset + 20] !== 0) break;
      colorType = png[offset + 17];
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    }
    if (type === 'PLTE') {
      if (hasPalette || compressed.length || !length || length > 768 || length % 3 ||
          [0, 4].includes(colorType)) break;
      hasPalette = true;
    }
    if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !hasPalette)) break;
      compressed.push(png.subarray(offset + 8, offset + 8 + length));
    } else if (compressed.length) dataEnded = true;
    if (type === 'IEND') {
      if (length === 0 && end === png.length && compressed.length && channels) {
        const rowBytes = result.scaledWidth * channels + 1;
        const expectedBytes = rowBytes * result.scaledHeight;
        let pixels;
        try { pixels = await inflateAsync(Buffer.concat(compressed), { maxOutputLength: expectedBytes }); }
        catch { throw new Error('Incomplete or corrupt host-helper PNG pixels'); }
        if (pixels.length !== expectedBytes) throw new Error('Incomplete host-helper PNG pixels');
        for (let row = 0; row < result.scaledHeight; row++) {
          if (pixels[row * rowBytes] > 4) throw new Error('Invalid host-helper PNG scanline');
        }
        return;
      }
      break;
    }
    offset = end;
  }
  throw new Error('Incomplete or corrupt host-helper PNG');
}

const pixelRect = (value, width, height) => object(value) && Object.keys(value).length === 4 &&
  ['x', 'y'].every(key => integer(value[key], 0)) && ['width', 'height'].every(key => integer(value[key])) &&
  value.x + value.width <= width && value.y + value.height <= height;
const boundedText = value => value === undefined || (typeof value === 'string' && value.length <= 256);

// Validate the Host's AX snapshot and add each frame in the agent's scaled
// display space. Frames stay framebuffer pixels; display_frame is derived.
function validateSnapshot(snapshot, display) {
  const framebuffer = snapshot?.framebuffer;
  if (!object(snapshot) || snapshot.schema !== AX_SCHEMA || snapshot.coordinate_space !== 'framebuffer_pixels' ||
      !object(framebuffer) || !integer(framebuffer.pixel_width) || !integer(framebuffer.pixel_height) ||
      framebuffer.pixel_width > 16384 || framebuffer.pixel_height > 16384 || !validScale(framebuffer.scale) ||
      !integer(snapshot.depth) || snapshot.depth > AX_MAX_DEPTH || typeof snapshot.truncated !== 'boolean' ||
      typeof snapshot.focused_app !== 'boolean' || !Array.isArray(snapshot.applications) ||
      snapshot.applications.length > 256 || !snapshot.applications.every(application => object(application) &&
        integer(application.pid) && validRef(application.ref) &&
        (application.bundle_id === null || boundedText(application.bundle_id)) &&
        (application.name === null || boundedText(application.name))) ||
      !Array.isArray(snapshot.nodes) || (snapshot.generation !== undefined && !integer(snapshot.generation)) ||
      snapshot.nodes.length > AX_MAX_NODES || snapshot.node_count !== snapshot.nodes.length) {
    throw new Error('Invalid host-helper AX snapshot');
  }
  const refs = new Set();
  for (const node of snapshot.nodes) {
    if (!object(node) || !validRef(node.ref) || refs.has(node.ref) ||
        (node.parent !== null && !refs.has(node.parent)) || !integer(node.depth, 0) ||
        node.depth > snapshot.depth || typeof node.role !== 'string' || !node.role || node.role.length > 256 ||
        !boundedText(node.subrole) || !boundedText(node.label) || !boundedText(node.value) ||
        (node.value_redacted !== undefined && (node.value_redacted !== true || node.value !== undefined)) ||
        (node.frame !== null && !pixelRect(node.frame, framebuffer.pixel_width, framebuffer.pixel_height))) {
      throw new Error('Invalid host-helper AX snapshot node');
    }
    refs.add(node.ref);
  }
  // The same uniform ratio capture() requests, so display_frame lands in the
  // Host screenshot's coordinates even when the VNC aspect differs.
  const scaled = integer(display?.width) && integer(display?.height);
  const ratio = scaled ? Math.min(1, Math.max(display.width, display.height) /
    Math.max(framebuffer.pixel_width, framebuffer.pixel_height)) : 0;
  const screenshot = { width: Math.max(1, Math.round(framebuffer.pixel_width * ratio)),
    height: Math.max(1, Math.round(framebuffer.pixel_height * ratio)) };
  return { ...snapshot, ...(scaled ? { display: screenshot } : {}),
    nodes: snapshot.nodes.map(node => (!scaled || node.frame === null ? node : { ...node, display_frame: {
      x: Math.floor(node.frame.x * ratio), y: Math.floor(node.frame.y * ratio),
      width: Math.max(1, Math.round(node.frame.width * ratio)), height: Math.max(1, Math.round(node.frame.height * ratio)),
    } })) };
}

const boundedLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

// The Host's receipt for one element action. It must name the request it
// answers; a fallback carries only a framebuffer point, never a verdict.
function validateAxOutcome(outcome, ref, kind, generation, framebuffer) {
  const fallback = outcome?.path === AX_FALLBACK_PATH;
  if (!object(outcome) || outcome.ref !== ref || outcome.action !== kind || outcome.generation !== generation ||
      !(fallback || AX_PATHS[kind].has(outcome.path)) || !AX_SURFACES.has(outcome.surface) ||
      !boundedLabel(outcome.role) || (outcome.subrole !== undefined && !boundedLabel(outcome.subrole)) ||
      (fallback
        ? outcome.verified !== undefined || outcome.ax_result !== undefined || !object(outcome.fallback_point) ||
          !integer(outcome.fallback_point.x, 0) || !integer(outcome.fallback_point.y, 0) ||
          outcome.fallback_point.x >= framebuffer.pixel_width || outcome.fallback_point.y >= framebuffer.pixel_height
        : typeof outcome.verified !== 'boolean' || !['performed', 'indeterminate'].includes(outcome.ax_result) ||
          outcome.fallback_point !== undefined)) {
    throw new Error('Invalid host-helper AX action receipt');
  }
  return outcome;
}

// #161: the Host's readback of one ax_value request.
/** #181: what a readout shows. Logic reports no value on its fader readout and
 * puts the figure in the label, as "volume fader level, -6.0 dB". */
function readoutText(node) {
  if (!node) return undefined;
  if (node.value !== undefined) return node.value;
  const comma = node.label?.indexOf(', ') ?? -1;
  return comma < 0 ? undefined : node.label.slice(comma + 2);
}

/** The slider a readout belongs to: the sibling whose name starts its own, so
 * "volume fader" for "volume fader level". */
function entrySlider(nodes, field) {
  const base = node => (node.label ?? '').split(', ')[0];
  const name = base(field);
  return nodes.filter(node => node.role === 'AXSlider' && base(node) && name.startsWith(base(node)))
    .sort((left, right) => base(right).length - base(left).length)[0];
}

/** Whether a text field is a readout to type a number into: it shows a figure,
 * including an infinite level, or shows nothing and has its slider. A field that
 * holds its text in value, as a strip's name does, also needs that slider. */
function entryReadout(field, slider) {
  const shown = readoutText(field);
  if (shown === undefined || field.value !== undefined) {
    if (!slider) return false;
    if (shown === undefined) return true;
  }
  return /^\s*[+\-\u2212]?(?:\d|\.\d|\u221e)/.test(shown);
}

/** A readout rounds what was typed to the decimals it shows, and may add a
 * unit: "-6.0 dB" shows -6, and "-6.3" shows -6.25. A comma, a second point or a
 * leading unit is not read as a number. */
function readoutShows(shown, entered) {
  const match = /^\s*([+-]?(?:\d+(?:\.(\d*))?|\.(\d+)))(?=$|\s|[A-Za-z%])/.exec(shown.replace(/\u2212/g, '-'));
  if (!match) return false;
  const decimals = (match[2] ?? match[3] ?? '').length;
  return Math.abs(Number(match[1]) - Number(entered)) <= 0.5 * 10 ** -decimals + 1e-9;
}

function validateValueOutcome(outcome, params) {
  const text = value => value === null || (typeof value === 'string' && value.length <= 256);
  const steps = params.operation === 'set' ? 1 : params.steps;
  if (!object(outcome) || outcome.ref !== params.ref || outcome.generation !== params.generation ||
      outcome.operation !== params.operation || !HOST_VALUE_OWNERS.has(outcome.owner) || !boundedLabel(outcome.role) ||
      !text(outcome.value_before) || !text(outcome.value_after) || outcome.steps !== steps ||
      !integer(outcome.steps_performed, 0) || outcome.steps_performed > steps || typeof outcome.verified !== 'boolean' ||
      outcome.target_bundle_id !== params.target.bundle_id ||
      (outcome.ax_result !== undefined && !['performed', 'indeterminate'].includes(outcome.ax_result)) ||
      (outcome.stop_reason !== undefined && !(typeof outcome.stop_reason === 'string' &&
        /^[a-z_]{1,64}$/.test(outcome.stop_reason))) ||
      // A Host refuses before the first AX call; a receipt means one ran,
      // unless a later check stopped a step action before its first call.
      (outcome.steps_performed === 0) !== (outcome.ax_result === undefined) ||
      (outcome.stop_reason === undefined && (outcome.steps_performed < steps || !outcome.verified)) ||
      (outcome.stop_reason === 'value_unverified' && outcome.verified)) {
    throw tagFailure(new Error('Invalid host-helper ax_value receipt'), 'host_activity', 'receipt_mismatch');
  }
  return outcome;
}

/** Host capture uses owned VNC input or the explicit Host-only observer.
 * VNC input requires a qualified mapping. AX actions use Host refs and grants. */
export class HostHelperExecutor {
  constructor({ nativeExecutor, hostHelper, hostOnly = false, hostInput, hostCapture, spawnImpl = spawn,
    now = () => performance.now(), activityIdleMs,
    responseBudgetFactory = () => new ResponseBudget() }) {
    this.config = normalizeHostHelperConfiguration(hostHelper);
    // A VNC target's native permits follow the Host lease, so it keeps the
    // activity for the lane's lifetime as before.
    const idle = activityIdleMs ?? (hostOnly ? HOST_ACTIVITY_IDLE_MS : 0);
    if (!(idle === 0 || (Number.isSafeInteger(idle) && idle >= 1 && idle <= 600000)) ||
        (idle !== 0 && !hostOnly)) {
      throw new Error('Invalid host-helper activity idle period');
    }
    this.activityIdleMs = idle;
    this.idleReleases = 0;
    // #157: posted Host input exists only on a Host-only target whose
    // operator configured it. A VNC target keeps its own input path.
    this.hostInput = hostOnly ? normalizeHostInputPolicy(hostInput) : undefined;
    if (!hostOnly && hostInput !== undefined) throw new Error('hostInput requires the Host-only transport');
    if (!hostOnly && hostCapture !== undefined) throw new Error('hostCapture requires the Host-only transport');
    this.hostCapture = hostOnly ? normalizeHostCapturePolicy(hostCapture, this.hostInput) : undefined;
    this.inputTail = Promise.resolve();
    // TIN-5385: true while VNC input sent through this executor may still be
    // held on the target. See nativeInput and releaseProvable.
    this.nativeInputUnsettled = false;
    this.native = nativeExecutor;
    this.hostOnly = hostOnly;
    this.now = now;
    this.responseBudgetFactory = responseBudgetFactory;
    // A UUID-only profile learns the resolved ID from validated health.
    this.displayId = this.config.displayId;
    this.helperActions = Object.freeze([]);
    this.sessionId = randomUUID();
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.helperTail = Promise.resolve();
    this.observationTail = Promise.resolve();
    this.observing = 0;
    // Challenges sent per activity sequence, so a capture that overlapped a
    // renewal can name either one. Bounded to the most recent sequences.
    this.issued = new Map();
    this.spawnImpl = spawnImpl;
    this.channel = new HelperChannel(this.config, spawnImpl, error => this.fail(error), now);
  }

  get display() { return this.native.display; }

  /** TIN-5385: whether a failed executor can prove its own release in
   * place. A Host-only executor always could (#159). A VNC executor with
   * Host capture can when no VNC input it sent may still be held and its
   * native child reports its exit, so the proof needs only that exit and
   * the Host's own lease state. */
  get releaseProvable() {
    if (this.hostOnly) return true;
    return Boolean(this.failed) && !this.nativeInputUnsettled && typeof this.native?.closed?.then === 'function';
  }

  // The Host route attests its indicator only through a validated activity
  // receipt (overlay_ready) whose input permit is still current.
  get presentation() {
    const live = this.activityActive === true && !this.failed && !this.releasing && !this.released &&
      Number.isFinite(this.permitUntil) && this.now() < this.permitUntil;
    return Object.freeze({ route: 'host', indicator: live ? 'present' : 'unknown' });
  }

  get capabilities() {
    const native = this.native.capabilities ?? nativeCapabilities();
    const actions = ['screenshot', 'health', 'wait'];
    // Only an advertising native backend with the target's policy enabled.
    if (native.known && native.actions.includes('clipboard_read') && this.native.textPolicy?.clipboardRead === true) {
      actions.push('clipboard_read');
    }
    if (this.helperActions.includes('ax_snapshot')) actions.push('ax_snapshot');
    if (this.helperActions.includes('ax_action')) actions.push(...AX_ELEMENT_ACTIONS.keys());
    if (this.hostInputRoute) actions.push(...HOST_INPUT_ACTIONS.keys());
    if (this.hostValueRoute) actions.push(...HOST_VALUE_ACTIONS);
    if (!this.hostOnly && this.config.mapping) {
      actions.push(...[...INPUT_ACTIONS].filter(action => !HOST_VALUE_ACTIONS.has(action)), ...MAPPED_READ_ACTIONS);
    }
    // Actions describe this wrapper's routes. Unknown native metadata remains
    // explicit; a route or qualified mapping does not prove runtime support.
    return Object.freeze({ backend: 'owned_sck', known: native.known,
      actions: Object.freeze(actions.filter(action => HOST_ACTIONS.has(action) ||
        (this.hostInputRoute && HOST_INPUT_ACTIONS.has(action)) ||
        (!native.known || (native.actions.includes(action) &&
          (!INPUT_ACTIONS.has(action) || this.supportsNativeMapping(native)))))),
      native, inputMappingQualified: Boolean(this.config.mapping) });
  }

  // The Host offers input, answers renewals beside it, and the operator
  // configured it for this target.
  get hostInputRoute() {
    return Boolean(this.hostInput && this.helperActions.includes('input') && this.pipelined);
  }

  // #161: element values need the same operator policy and a Host that
  // offers ax_value.
  get hostValueRoute() {
    return Boolean(this.hostInput && this.helperActions.includes('ax_value') && this.pipelined);
  }

  supportsNativeMapping(native) {
    return ['health', 'adopt_observation', 'begin_input_permit', 'grant_input_permit']
      .every(action => native.actions.includes(action));
  }

  preflight(actions) {
    if (this.failed) throw this.failed;
    const native = this.native.capabilities ?? nativeCapabilities();
    for (const action of actions) {
      if (this.hostOnly && HOST_INPUT_ACTIONS.has(action.action) && this.hostInputRoute) {
        this.preflightHostInput(action);
        continue;
      }
      if (HOST_VALUE_ACTIONS.has(action.action)) {
        this.preflightHostValue(action);
        continue;
      }
      if (!this.hostOnly && hostOnlyDragOptions(action)) {
        throw preAdmissionRefusal('mouse_drag modifiers and fine offsets need the Host input route',
          'unsupported_on_route');
      }
      if (this.hostOnly && (INPUT_ACTIONS.has(action.action) || MAPPED_READ_ACTIONS.has(action.action) ||
          NATIVE_READ_ACTIONS.has(action.action) || action.action === 'activate_app')) {
        throw preAdmissionRefusal('VNC actions are forbidden on the Host-only transport', 'unsupported_on_route');
      }
      if ((INPUT_ACTIONS.has(action.action) || MAPPED_READ_ACTIONS.has(action.action)) && !this.config.mapping) {
        throw preAdmissionRefusal('Host-helper input mapping is not qualified');
      }
      if (NATIVE_READ_ACTIONS.has(action.action) && this.native.textPolicy?.clipboardRead !== true) {
        throw clipboardReadRefusal();
      }
      if (RAW_OBSERVATION_ACTIONS.has(action.action)) {
        throw preAdmissionRefusal('Action unavailable on the Host route: it observes raw VNC pixels',
          'unsupported_on_route');
      }
      if (!['screenshot', 'health', 'wait', 'ax_snapshot'].includes(action.action) && !INPUT_ACTIONS.has(action.action) &&
          !MAPPED_READ_ACTIONS.has(action.action) && !NATIVE_READ_ACTIONS.has(action.action) &&
          !AX_ELEMENT_ACTIONS.has(action.action)) {
        throw preAdmissionRefusal('Action unavailable with owned host-helper capture');
      }
      if (action.action === 'ax_snapshot') {
        if (!this.helperActions.includes('ax_snapshot')) {
          throw preAdmissionRefusal('ax_snapshot unavailable; this FruitctlHost predates it');
        }
        if (action.depth !== undefined && (!integer(action.depth) || action.depth > AX_MAX_DEPTH)) {
          throw preAdmissionRefusal('Invalid ax_snapshot depth');
        }
        if (action.focused_app !== undefined && typeof action.focused_app !== 'boolean') {
          throw preAdmissionRefusal('Invalid ax_snapshot focused_app');
        }
        if (action.menu_extras !== undefined && typeof action.menu_extras !== 'boolean') {
          throw preAdmissionRefusal('Invalid ax_snapshot menu_extras');
        }
        if (action.max_nodes !== undefined && (!integer(action.max_nodes) || action.max_nodes > AX_MAX_NODES)) {
          throw preAdmissionRefusal('Invalid ax_snapshot max_nodes');
        }
        if (action.root !== undefined) {
          if (action.menu_extras === true || !(['focused_window', 'menu'].includes(action.root) || validRef(action.root))) {
            throw preAdmissionRefusal('Invalid ax_snapshot root');
          }
          if (validRef(action.root) && (this.axGeneration === undefined || !this.axRefs.has(action.root))) {
            throw preAdmissionRefusal(`${action.root} is not in the latest ax_snapshot; take a new snapshot`,
              'stale_ref');
          }
        }
        this.requireAccessibility();
      }
      if (AX_ELEMENT_ACTIONS.has(action.action)) {
        if (!this.helperActions.includes('ax_action')) {
          throw preAdmissionRefusal(`${action.action} unavailable; this FruitctlHost predates it`);
        }
        if (!validRef(action.ref)) {
          throw preAdmissionRefusal(`Invalid ${action.action} ref`);
        }
        this.requireAccessibility();
        // Refs resolve only against this executor's latest snapshot. A ref
        // from an older snapshot, another lane or a retired executor never
        // reaches the Host.
        if (this.axGeneration === undefined || !this.axRefs.has(action.ref)) {
          throw preAdmissionRefusal(`${action.ref} is not in the latest ax_snapshot; take a new snapshot`,
            'stale_ref');
        }
      }
      // D15/D16: a secret is never typed, and no element is pressed or
      // focused, while the human Stop is latched. A Stop during a live lease
      // fails the executor; this covers a Host whose last validated receipt
      // already reported the latch.
      if ((action.action === 'type_secret' || AX_ELEMENT_ACTIONS.has(action.action)) &&
          this.humanStopLatched === true) {
        const refusal = preAdmissionRefusal(`The human Stop is latched on FruitctlHost; ${action.action} refused`);
        refusal.code = 'human_stop_latched';
        throw refusal;
      }
      if (action.action === 'screenshot' && this.hostCapture?.scope === 'target' &&
          !this.helperActions.includes('capture_scope')) {
        const refusal = preAdmissionRefusal('This FruitctlHost cannot capture only the target windows; update it');
        refusal.code = 'capture_scope_unsupported';
        throw refusal;
      }
      if (action.action === 'wait' && action.ms !== undefined &&
          (!integer(action.ms, 50) || action.ms > 10000)) {
        throw preAdmissionRefusal('Invalid host-helper wait duration');
      }
      if (!HOST_ACTIONS.has(action.action) && native.known &&
          (!native.actions.includes(action.action) ||
            (INPUT_ACTIONS.has(action.action) && !this.supportsNativeMapping(native)))) {
        throw preAdmissionRefusal('Action unavailable on native backend');
      }
    }
    if (native.known && actions.some(action => HOLD_ACTIONS.has(action.action)) &&
        !native.actions.includes('release_holds')) {
      throw preAdmissionRefusal('Action unavailable on native backend');
    }
  }

  /** #157: refuse before admission anything the Host would refuse for
   * shape, and anything the operator's policy does not allow. */
  preflightHostInput(action) {
    const refuse = (message, code = 'invalid_input') => {
      const refusal = preAdmissionRefusal(message);
      refusal.code = code;
      throw refusal;
    };
    if (this.humanStopLatched === true) refuse(`The human Stop is latched on FruitctlHost; ${action.action} refused`,
      'human_stop_latched');
    if (this.inputEnabled === false) {
      refuse('Agent input is disabled in the FruitctlHost menu; the operator enables it locally', 'input_disabled');
    }
    if (this.inputPermission === false) {
      refuse('FruitctlHost may not post input; the operator grants it Accessibility', 'input_permission_required');
    }
    this.requireAccessibility();
    const apps = this.hostInput.applications;
    const app = action.app ?? (apps.length === 1 ? apps[0] : undefined);
    if (typeof app !== 'string' || !apps.includes(app)) {
      refuse(`${action.action} needs app, one of this target's hostInput applications`, 'input_target_not_allowed');
    }
    const display = this.native.display;
    const inside = (x, y) => integer(x, 0) && integer(y, 0) && x < display.width && y < display.height;
    const kind = HOST_INPUT_ACTIONS.get(action.action);
    if (!['key', 'type', 'activate'].includes(kind) && !inside(action.x, action.y)) {
      refuse(`${action.action} needs x and y inside the current display`);
    }
    // #180: Shift only. A held Cmd, Ctrl or Option turns a drag into another
    // command and, when an interrupted drag is cancelled with Escape, can
    // form a system shortcut.
    if (kind === 'drag' && action.modifiers !== undefined &&
        action.modifiers.some(name => !['shift', 'rshift'].includes(name))) {
      refuse('mouse_drag takes only shift as a modifier');
    }
    const fine = action.fine_dx !== undefined || action.fine_dy !== undefined;
    if (fine) {
      const offset = value => value === undefined || (Number.isSafeInteger(value) && Math.abs(value) <= 64);
      if (kind !== 'drag' || !offset(action.fine_dx) || !offset(action.fine_dy) ||
          !(action.fine_dx ?? 0) && !(action.fine_dy ?? 0) ||
          action.toX !== undefined || action.toY !== undefined) {
        refuse('mouse_drag takes fine_dx and fine_dy of -64 to 64 framebuffer pixels instead of toX and toY');
      }
      const { width, height } = this.native.geometry;
      const from = this.framebufferPoint(action.x, action.y);
      const to = { x: from.x + (action.fine_dx ?? 0), y: from.y + (action.fine_dy ?? 0) };
      if (to.x < 0 || to.y < 0 || to.x >= width || to.y >= height) refuse('mouse_drag fine end is outside the display');
    } else if (kind === 'drag' && !inside(action.toX, action.toY)) refuse('mouse_drag needs toX and toY inside the display');
    if (action.window !== undefined && (typeof action.window !== 'string' || !action.window.length ||
        action.window.length > 256)) refuse('window must be a window title of 1 to 256 characters');
    if (action.button !== undefined && !['left', 'right', 'middle'].includes(action.button)) refuse('Invalid button');
    if (action.modifiers !== undefined && (!Array.isArray(action.modifiers) || !action.modifiers.length ||
        action.modifiers.length > 4 || action.modifiers.some(name => !HOST_MODIFIERS.has(name)))) {
      refuse('Invalid modifiers');
    }
    if (kind === 'key') {
      const keys = this.hostKeys(action);
      if (!keys.length || keys.length > 6 || !keys.every(name => HOST_KEY_NAME.test(name)) ||
          !keys.slice(0, -1).every(name => HOST_MODIFIERS.has(name.toLowerCase()))) {
        refuse(`Invalid ${action.action} keys`);
      }
    }
    if (kind === 'type' && (typeof action.text !== 'string' || !action.text.length ||
        action.text.length > MAX_HOST_INPUT_TEXT ||
        // Only newline and tab among control characters; CR becomes newline.
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(action.text))) {
      refuse('key_type text must be 1 to 4096 characters without control characters');
    }
    if (kind === 'type' && [...graphemes.segment(action.text)].some(({ segment }) =>
      segment.length > HOST_INPUT_GRAPHEME_UNITS)) refuse('key_type text holds a character over 64 UTF-16 units');
    if (kind === 'scroll' && (!['up', 'down', 'left', 'right'].includes(action.direction) ||
        (action.amount !== undefined && (!integer(action.amount) || action.amount > 20)))) refuse('Invalid scroll');
  }

  /** #161: refuse before admission what the Host would refuse for shape,
   * and any application outside the operator's hostInput list. */
  preflightHostValue(action) {
    const refuse = (message, code = 'invalid_input') => {
      const refusal = preAdmissionRefusal(message);
      refusal.code = code;
      throw refusal;
    };
    if (!this.hostOnly || !this.hostValueRoute) {
      refuse(`${action.action} needs a Host-only target with hostInput and a FruitctlHost that offers ax_value`,
        'unsupported_on_route');
    }
    if (this.humanStopLatched === true) refuse(`The human Stop is latched on FruitctlHost; ${action.action} refused`,
      'human_stop_latched');
    if (this.inputEnabled === false) {
      refuse('Agent input is disabled in the FruitctlHost menu; the operator enables it locally', 'input_disabled');
    }
    this.requireAccessibility();
    const apps = this.hostInput.applications;
    const app = action.app ?? (apps.length === 1 ? apps[0] : undefined);
    if (typeof app !== 'string' || !apps.includes(app)) {
      refuse(`${action.action} needs app, one of this target's hostInput applications`, 'input_target_not_allowed');
    }
    if (!validRef(action.ref)) refuse(`Invalid ${action.action} ref`);
    if (this.axGeneration === undefined || !this.axRefs.has(action.ref)) {
      refuse(`${action.ref} is not in the latest ax_snapshot; take a new snapshot`, 'stale_ref');
    }
    if (action.action === 'enter_element_value') {
      const text = typeof action.value === 'number' ? String(action.value) : action.value;
      if (typeof text !== 'string' || text.length > HOST_ENTRY_MAX_TEXT || !HOST_ENTRY_VALUE.test(text) ||
          action.steps !== undefined) {
        refuse('enter_element_value needs value: a number of at most 16 characters');
      }
      if (!this.hostInputRoute) {
        refuse('enter_element_value needs a FruitctlHost that offers input', 'unsupported_on_route');
      }
      const readout = this.axEntryNodes.get(action.ref);
      if (!readout) refuse(`${action.ref} is not an AXTextField inside a window`, 'ax_action_unsupported');
      if (readout.bundle !== undefined && readout.bundle !== app) {
        refuse(`${action.ref} does not belong to ${app}`, 'input_target_mismatch');
      }
    } else if (action.action === 'set_element_value') {
      const { value } = action;
      const text = typeof value === 'string' && value.length <= HOST_VALUE_MAX_TEXT &&
        Buffer.byteLength(value, 'utf8') <= HOST_VALUE_MAX_TEXT &&
        !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
      if (!(text || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 2 ** 53)) ||
          action.steps !== undefined) {
        refuse('set_element_value needs value: a number, or text of at most 256 bytes without control characters');
      }
    } else if (!Number.isSafeInteger(action.steps) || action.steps === 0 || Math.abs(action.steps) > HOST_VALUE_MAX_STEPS ||
        action.value !== undefined) {
      refuse(`step_element needs steps: 1 to ${HOST_VALUE_MAX_STEPS} up, or -1 to -${HOST_VALUE_MAX_STEPS} down`);
    }
  }

  hostKeys(action) {
    if (action.action === 'key_tap') return typeof action.key === 'string' ? [action.key] : [];
    if (Array.isArray(action.keys) && action.keys.length) return action.keys.map(String);
    return typeof action.key === 'string' ? action.key.split('+').map(part => part.trim()) : [];
  }

  // Framebuffer pixel at the centre of a scaled screenshot pixel.
  framebufferPoint(x, y) {
    const { width, height } = this.native.geometry;
    const display = this.native.display;
    return { x: Math.min(width - 1, Math.floor((x + 0.5) * width / display.width)),
      y: Math.min(height - 1, Math.floor((y + 0.5) * height / display.height)) };
  }

  hostInputRequests(action) {
    const kind = HOST_INPUT_ACTIONS.get(action.action);
    const base = { kind, target: { bundle_id: action.app ?? this.hostInput.applications[0],
      ...(action.window === undefined ? {} : { window_title: action.window }) },
      operator_input: this.hostInput.operatorInput, operator_idle_ms: this.hostInput.operatorIdleMs };
    if (kind === 'type') {
      // Whole graphemes, at most 32 per request, and a newline or tab ends
      // its request so the Host re-checks focus before the next characters.
      const chunks = [];
      let current = [];
      let units = 0;
      for (const { segment } of graphemes.segment(action.text.replace(/\r\n?/g, '\n'))) {
        if (current.length && units + segment.length > HOST_INPUT_TEXT_UNITS) {
          chunks.push({ ...base, text: current.join('') });
          current = []; units = 0;
        }
        current.push(segment);
        units += segment.length;
        if (current.length === HOST_INPUT_TEXT_CHUNK || segment === '\n' || segment === '\t') {
          chunks.push({ ...base, text: current.join('') });
          current = []; units = 0;
        }
      }
      if (current.length) chunks.push({ ...base, text: current.join('') });
      return chunks;
    }
    if (kind === 'key') return [{ ...base, keys: this.hostKeys(action) }];
    if (kind === 'activate') return [base];
    const { x, y } = this.framebufferPoint(action.x, action.y);
    const request = { ...base, x, y };
    if (kind === 'drag') {
      // #180: fine offsets are framebuffer pixels from the start pixel.
      const to = action.fine_dx !== undefined || action.fine_dy !== undefined
        ? { x: x + (action.fine_dx ?? 0), y: y + (action.fine_dy ?? 0) }
        : this.framebufferPoint(action.toX, action.toY);
      Object.assign(request, { to_x: to.x, to_y: to.y });
    }
    if (action.button !== undefined && kind !== 'move' && kind !== 'scroll') request.button = action.button;
    if (action.modifiers !== undefined && kind !== 'move' && kind !== 'scroll') request.modifiers = action.modifiers;
    if (kind === 'scroll') Object.assign(request, { direction: action.direction, amount: action.amount ?? 3 });
    return [request];
  }

  /** One Host input request on its own queue, so renewals continue beside
   * it on a pipelining Host. The reply binds the lease it ended under. */
  inputRequest(params, signal) {
    const task = this.inputTail.then(async () => {
      if (this.failed) throw this.failed;
      this.assertPermit();
      const first = this.lastSequence;
      let receipt;
      try {
        receipt = await this.channel.request('input', { session_id: this.sessionId, ...this.displayParams,
          capture_backend: 'owned_sck', ...params }, { signal, timeoutMs: HOST_INPUT_TIMEOUT_MS });
      } catch (error) {
        if (!HOST_INPUT_REFUSALS.has(error?.code) || hostHelperRefusalMessage(error) === undefined) throw error;
        return { refusal: error };
      }
      const lost = receipt.result;
      if (object(lost) && lost.lease_lost === true) {
        // Stop, expiry or a display change ended the lease mid-action. The
        // Host released what it held; this lane retires with the count.
        const posted = integer(lost.input?.posted_events, 0) ? lost.input.posted_events : 'unknown';
        throw tagFailure(localFailure(`Host input lease ended after ${posted} events; take a screenshot before acting`),
          'host_activity', 'context_changed');
      }
      const result = validateReady(receipt, this, (sequence, challenge) => this.issuedSince(first, sequence, challenge),
        { refreshPermit: false, roundTripMs: HOST_INPUT_TIMEOUT_MS });
      const input = result.input;
      if (input?.stop_detail !== undefined) {
        // An unreadable detail is dropped; the stop itself is still reported.
        const window = windowRefusalDetail(input.stop_detail);
        if (window) input.stop_detail = window;
        else delete input.stop_detail;
      }
      if (!object(input) || input.kind !== params.kind || !integer(input.posted_events, 0) ||
          typeof input.completed !== 'boolean' || !integer(input.operator_input_events, 0) ||
          !integer(input.released_events, 0) || input.target_bundle_id !== params.target.bundle_id ||
          (input.stop_reason !== undefined && !(typeof input.stop_reason === 'string' &&
            /^[a-z_]{1,64}$/.test(input.stop_reason))) || (!input.completed && input.stop_reason === undefined)) {
        throw tagFailure(new Error('Invalid host-helper input receipt'), 'host_activity', 'receipt_mismatch');
      }
      return { input };
    });
    this.inputTail = task.catch(() => {});
    return task;
  }

  /** #161: one ax_value request on the input queue, so renewals continue
   * beside it. A refusal before the first AX call is returned, not thrown. */
  valueRequest(params, signal) {
    const task = this.inputTail.then(async () => {
      if (this.failed) throw this.failed;
      this.assertPermit();
      const first = this.lastSequence;
      let receipt;
      try {
        receipt = await this.channel.request('ax_value', { session_id: this.sessionId, ...this.displayParams,
          capture_backend: 'owned_sck', ...params }, { signal, timeoutMs: HOST_INPUT_TIMEOUT_MS });
      } catch (error) {
        if (!HOST_VALUE_REFUSALS.has(error?.code) || hostHelperRefusalMessage(error) === undefined) throw error;
        return { refusal: error };
      }
      const lost = receipt.result;
      if (object(lost) && lost.lease_lost === true) {
        // Stop, expiry or a display change ended the lease after an AX
        // call. This lane retires with the count.
        const performed = integer(lost.ax_value?.steps_performed, 0) ? lost.ax_value.steps_performed : 'unknown';
        throw tagFailure(localFailure(`Host ax_value lease ended after ${performed} AX calls; take a screenshot ` +
          'before acting'), 'host_activity', 'context_changed');
      }
      const result = validateReady(receipt, this, (sequence, challenge) => this.issuedSince(first, sequence, challenge),
        { refreshPermit: false, roundTripMs: HOST_INPUT_TIMEOUT_MS });
      return { outcome: validateValueOutcome(result.ax_value, params) };
    });
    this.inputTail = task.catch(() => {});
    return task;
  }

  /** set_element_value / step_element. The Host makes the AX call and reads
   * the value back; nothing is retried. A step that stops early is this
   * action's error response with what ran. */
  /** #181: a control whose value is not settable, such as a Logic mixer fader,
   * often has an editable readout beside it. Read its strip, double-click the
   * readout where it is now, type the number, press Return and read the strip
   * again. Each step is ordinary Host input under every input gate. Each read
   * keeps only that strip's refs, so refs elsewhere go stale. */
  async enterElementValue(action, signal) {
    const app = action.app ?? this.hostInput.applications[0];
    const stale = () => this.perCallRefusal(Object.assign(new Error(`${action.ref} is not in the latest ` +
      'ax_snapshot; take a new snapshot'), { code: 'stale_ref' }));
    const known = this.axEntryNodes.get(action.ref);
    if (!known) return stale();
    const strip = { root: known.parent, depth: 1, max_nodes: HOST_ENTRY_STRIP_NODES };
    const before = await this.axSnapshot(strip, signal);
    if (before.refusal) return this.perCallRefusal(before.refusal);
    const field = before.ax_snapshot.nodes.find(node => node.ref === action.ref);
    if (field?.role !== 'AXTextField') return stale();
    const unsupported = message => this.perCallRefusal(Object.assign(new Error(`${action.ref} ${message}`),
      { code: 'ax_action_unsupported' }));
    if (!field.display_frame) return unsupported('has no frame on screen; bring it into view and take a new snapshot');
    const slider = entrySlider(before.ax_snapshot.nodes, field);
    // A strip's name is a text field too, and a rename would verify itself.
    if (!entryReadout(field, slider)) return unsupported('is not a numeric readout');
    const text = String(action.value);
    const x = field.display_frame.x + Math.floor(field.display_frame.width / 2);
    const y = field.display_frame.y + Math.floor(field.display_frame.height / 2);
    const steps = [{ step: 'open', input: { action: 'mouse_double_click', x, y, app }, readback: false },
      { step: 'type', input: { action: 'key_type', text, app }, readback: false },
      { step: 'commit', input: { action: 'key_tap', key: 'return', app }, readback: true }];
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    let last, posted = 0;
    for (const { step, input, readback } of steps) {
      if (last) await pause(step === 'type' ? HOST_ENTRY_OPEN_SETTLE_MS : HOST_INPUT_FOCUS_SETTLE_MS);
      last = await this.hostInputAction(input, signal, { readback });
      // The field may still be opening. That refusal posted nothing, so ask again.
      const deadline = this.now() + HOST_ENTRY_OPEN_RETRY_MS;
      while (step === 'type' && last.error?.data?.code === 'input_focus_unavailable' && this.now() < deadline) {
        await pause(HOST_ENTRY_OPEN_POLL_MS);
        last = await this.hostInputAction(input, signal, { readback });
      }
      // A stop after the field opened leaves it open. Nothing here presses
      // Escape, which is a Logic command.
      if (last.error) {
        last.error.data = { ...last.error.data, entry_step: step, entry_posted_events: posted };
        return last;
      }
      posted += last.result.host_input.posted_events;
    }
    const after = await this.axSnapshot(strip, signal);
    const nodes = after.refusal ? [] : after.ax_snapshot.nodes;
    const shown = readoutText(nodes.find(node => node.ref === action.ref));
    const sliderAfter = slider && nodes.find(node => node.ref === slider.ref);
    // A slider's raw value says it moved, not that it reached the number, so
    // only the figure verifies. Movement is reported for the agent to weigh.
    const summary = { ref: action.ref, action: action.action, app, role: 'AXTextField', value_requested: text,
      value_after: shown ?? null, posted_events: posted, verified: shown !== undefined && readoutShows(shown, text),
      ...(slider ? { slider_ref: slider.ref, slider_before: slider.value ?? null,
        slider_after: sliderAfter?.value ?? null,
        slider_moved: slider.value !== undefined && sliderAfter?.value !== undefined &&
          sliderAfter.value !== slider.value } : {}) };
    if (!summary.verified) {
      const reason = after.refusal?.code ?? 'value_not_verified';
      return this.perCallRefusal(Object.assign(new Error(`${action.action} ${action.ref}: the entry was sent and ` +
        `could not be verified: ${reason}`), { code: 'input_interrupted', data: { reason, ...summary } }));
    }
    return { id: randomUUID(), result: { ...last.result,
      detail: `${action.action} ${action.ref}: ${posted} events posted, readout verified`, ax_value: summary } };
  }

  async hostValueAction(action, signal) {
    const set = action.action === 'set_element_value';
    const operation = set ? 'set' : action.steps > 0 ? 'increment' : 'decrement';
    const app = action.app ?? this.hostInput.applications[0];
    const params = { generation: this.axGeneration, ref: action.ref, operation, target: { bundle_id: app },
      operator_input: this.hostInput.operatorInput, operator_idle_ms: this.hostInput.operatorIdleMs,
      ...(set ? { value: action.value } : { steps: Math.abs(action.steps) }) };
    const reply = await this.valueRequest(params, signal);
    if (reply.refusal) return this.perCallRefusal(reply.refusal);
    const { outcome } = reply;
    const summary = { ref: outcome.ref, action: action.action, app, operation, owner: outcome.owner,
      role: outcome.role, value_before: outcome.value_before, value_after: outcome.value_after,
      steps: outcome.steps, steps_performed: outcome.steps_performed, verified: outcome.verified,
      ...(outcome.ax_result === undefined ? {} : { ax_result: outcome.ax_result }) };
    // An unverified value or a partial step may still have acted: the
    // batch ends here, and the agent reads value_after before anything else.
    if (outcome.stop_reason !== undefined) {
      return this.perCallRefusal(Object.assign(new Error(`${action.action} stopped after ` +
        `${outcome.steps_performed} of ${outcome.steps} AX calls: ${outcome.stop_reason}`),
      { code: 'input_interrupted', data: { reason: outcome.stop_reason, ...summary } }));
    }
    // Values stay in ax_value; the journalled detail carries none.
    return { id: randomUUID(), result: {
      detail: `${action.action} ${outcome.ref}: ${outcome.steps_performed} AX calls, verified ${outcome.verified}`,
      ax_value: summary } };
  }

  /** #157: the Host posts the action; nothing is replayed. A refusal before
   * the first event, or a stop after some, is this action's error response
   * and ends the batch. A completed action is followed by one fresh frame. */
  async hostInputAction(action, signal, { readback: wantsFrame = true } = {}) {
    let posted = 0, operatorEvents = 0, monitor, settle = false;
    const pause = ms => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    for (const params of this.hostInputRequests(action)) {
      if (settle) await pause(HOST_INPUT_FOCUS_SETTLE_MS);
      settle = params.text !== undefined && /[\n\t]$/.test(params.text);
      const reply = await this.inputRequest(params, signal);
      if (reply.refusal) {
        if (posted) {
          // Earlier requests posted; read back what they did (review round 3).
          const readback = await this.readbackFrame(signal);
          return this.perCallRefusal(Object.assign(new Error(`${action.action} stopped after ${posted} events: ` +
            reply.refusal.code), { code: 'input_interrupted',
            data: { reason: reply.refusal.code, posted_events: posted,
              ...(reply.refusal.data?.window ? { window: reply.refusal.data.window } : {}), readback } }));
        }
        return this.perCallRefusal(reply.refusal);
      }
      const { input } = reply;
      posted += input.posted_events;
      operatorEvents += input.operator_input_events;
      monitor = input.operator_input_monitor;
      if (!input.completed) {
        // The lease still holds: read back what the partial input did.
        const readback = await this.readbackFrame(signal);
        return this.perCallRefusal(Object.assign(new Error(`${action.action} stopped after ${posted} events: ` +
          input.stop_reason), { code: 'input_interrupted', data: { reason: input.stop_reason, posted_events: posted,
          released_events: input.released_events, ...(input.stop_detail ? { window: input.stop_detail } : {}),
          readback } }));
      }
    }
    // #181: a composite action asks for the frame on its last step only.
    const frame = wantsFrame ? await this.readbackFrame(signal) : {};
    const summary = { action: action.action, app: action.app ?? this.hostInput.applications[0], posted_events: posted,
      operator_input: this.hostInput.operatorInput, operator_input_events: operatorEvents,
      ...(typeof monitor === 'string' ? { operator_input_monitor: monitor } : {}), readback: wantsFrame };
    return { id: randomUUID(), result: { ...frame,
      detail: `${action.action}: ${posted} events posted by FruitctlHost${wantsFrame ? '; readback frame attached' : ''}`,
      host_input: summary } };
  }

  /** One complete Host frame after a settle, so the target has drawn what
   * the input did. Every completed or interrupted input carries one. */
  async readbackFrame(signal) {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); },
        HOST_INPUT_READBACK_SETTLE_MS);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    await this.activity('renew_activity', signal);
    const frame = await this.capture(signal, 'jpeg');
    if (this.permitLapsedAt !== undefined) await this.activity('renew_activity', signal);
    return frame;
  }

  async ready() {
    const { result } = await this.channel.request('health', { ...this.displayParams,
      capture_backend: 'owned_sck' }, { timeoutMs: HELPER_CONNECT_TIMEOUT_MS });
    const health = validateHealth(result, this.config);
    if (this.hostOnly) this.native.bindHealth(health);
    // A Host that answers requests concurrently can renew beside a capture.
    this.pipelined = health.request_pipelining === true;
    this.replyParts = health.reply_parts === true;
    this.imageFormats = Array.isArray(health.image_formats) ? health.image_formats : [];
    this.instanceId = health.instance_id;
    this.observeInput(health);
    this.generation = health.displayGeneration;
    this.displayId = health.display_id;
    this.observeAccessibility(health);
    // Older Hosts report no capability list; they offer only capture.
    this.helperActions = Object.freeze(Array.isArray(health.capabilities) && health.capabilities.length <= 32 &&
      health.capabilities.every(action => typeof action === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(action))
      ? [...health.capabilities] : []);
    this.helperReleased = true; // This connection has not acquired activity.
    return this;
  }

  fail(error, closeOptions) {
    clearTimeout(this.idleReleaseTimer);
    this.idleReleaseTimer = undefined;
    if (this.failed) return;
    this.failed = tagFailure(error, 'host_helper', localFailureReasons.get(error?.message) ??
      (hostHelperRefusalMessage(error) ? 'helper_refused' : 'unknown'));
    this.heartbeatEnabled = false;
    clearTimeout(this.heartbeat);
    clearTimeout(this.permitTimer);
    clearTimeout(this.lapseTimer);
    this.activeController?.abort(error);
    this.releaseController?.abort(error);
    // Invalidating synchronously prevents any successor input from being sent.
    if (!this.nativeClosing) {
      try { this.nativeClosing = Promise.resolve(this.native.close({ graceful: false, ...closeOptions })); }
      catch (closeError) { this.nativeClosing = Promise.reject(closeError); }
      this.nativeClosing.catch(() => {});
    }
    this.helperClosing ??= this.channel?.close(closeOptions);
  }

  // D10 expects the grant. The last validated Host receipt said it is
  // missing, so refuse before admission instead of retiring the lane.
  requireAccessibility() {
    if (this.accessibilityTrusted === false) {
      const refusal = preAdmissionRefusal('FruitctlHost lacks the Accessibility grant');
      refusal.code = 'accessibility_permission_required';
      throw refusal;
    }
  }

  observeInput(health) {
    if (typeof health.input_enabled === 'boolean') this.inputEnabled = health.input_enabled;
    if (typeof health.input_post_permission === 'boolean') this.inputPermission = health.input_post_permission;
  }

  observeAccessibility(result) {
    if (typeof result.accessibility_trusted === 'boolean') this.accessibilityTrusted = result.accessibility_trusted;
    if (typeof result.human_stop_latched === 'boolean') this.humanStopLatched = result.human_stop_latched;
  }

  // Requests name the learned display ID and, when configured, the UUID the
  // Host re-checks on every call.
  get displayParams() {
    return { display_id: this.displayId,
      ...(this.config.displayUuid === undefined ? {} : { display_uuid: this.config.displayUuid }) };
  }

  assertPermit() {
    if (this.activityActive && (this.permitLapsedAt !== undefined || !Number.isFinite(this.permitUntil) ||
        this.now() >= this.permitUntil)) {
      throw localFailure('Host-helper input permit expired');
    }
  }

  // A Host that answers one request at a time cannot renew while it encodes
  // a capture. A permit that expires then lapses rather than retiring the
  // owner: input stays refused, and only a renewal sent after the lapse can
  // re-arm it. Any other expiry retires the owner, including one after this
  // batch has sent mouse_down: retirement releases the hold, and a lapse
  // would leave the button pressed for the rest of the capture.
  permitExpired() {
    if (this.observing > 0 && !this.pipelined && !this.holdPressed) {
      this.permitLapsedAt ??= this.now();
      return;
    }
    this.fail(localFailure('Host-helper input permit expired'));
  }

  refreshPermit(until, startedAt = this.now()) {
    if (!Number.isFinite(until) || this.now() >= until) throw localFailure('Host-helper input permit expired');
    this.permitUntil = until;
    this.permitStartedAt = startedAt;
    clearTimeout(this.permitTimer);
    this.permitTimer = setTimeout(() => {
      // #177: no input runs while an idle release is committed; a renewal that
      // was already in flight must not fail the executor on its permit.
      if (!this.activityActive || this.failed || this.idleReleasing) return;
      try {
        if (this.now() >= this.permitUntil) this.permitExpired();
        else this.refreshPermit(this.permitUntil, this.permitStartedAt);
      } catch (error) { this.fail(error); }
    }, Math.max(1, until - this.now()));
    if (!this.renewing) this.scheduleRenewal();
  }

  scheduleRenewal() {
    clearTimeout(this.heartbeat);
    if (!this.heartbeatEnabled || !this.activityActive || this.failed) return;
    // A full renewal budget must fit before expiry. Reserve half the
    // remaining protocol window for dispatch delay, without extending it.
    const dispatchMargin = (INPUT_PERMIT_MS - HELPER_TIMEOUT_MS) / 2;
    const latest = this.permitUntil - HELPER_TIMEOUT_MS - dispatchMargin;
    // A short advertised lease still expires. Do not spin renewals faster
    // than the same dispatch margin to keep an otherwise spent owner alive.
    const notBefore = this.permitStartedAt + dispatchMargin;
    const delay = Math.max(0, Math.min(RENEW_INTERVAL_MS,
      Math.max(notBefore, latest) - this.now()));
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined;
      if (!this.heartbeatEnabled || !this.activityActive || this.renewing || this.failed) return;
      this.renewing = true;
      this.activity('renew_activity', undefined, { heartbeat: true }).catch(error => this.fail(error))
        .finally(() => { this.renewing = false; this.scheduleRenewal(); });
    }, delay);
  }

  helperOperation(operation) {
    const task = this.helperTail.then(() => {
      if (this.failed) throw this.failed;
      return operation();
    });
    this.helperTail = task.catch(() => {});
    return task;
  }

  // A serial Host keeps observations in the lease order. A pipelining Host
  // takes them on their own queue so renewals continue during the encode.
  observation(operation) {
    const observed = async () => {
      if (!this.observing) this.observationSequenceFloor = this.lastSequence;
      this.observing++;
      try { return await operation(); }
      finally {
        this.observing--;
        if (!this.observing) {
          this.observationSequenceFloor = undefined;
          this.pruneChallenges();
        }
        if (!this.observing && this.permitLapsedAt !== undefined && !this.failed) {
          // The renewal queued behind this observation re-arms promptly.
          clearTimeout(this.lapseTimer);
          this.lapseTimer = setTimeout(() => {
            if (this.permitLapsedAt !== undefined) this.fail(localFailure('Host-helper input permit expired'));
          }, RENEW_INTERVAL_MS + HELPER_TIMEOUT_MS);
        }
      }
    };
    if (!this.pipelined) return this.helperOperation(observed);
    const task = this.observationTail.then(() => {
      if (this.failed) throw this.failed;
      return observed();
    });
    this.observationTail = task.catch(() => {});
    return task;
  }

  pruneChallenges() {
    // A streamed observation can echo a challenge from its capture boundary.
    // Pin that bounded in-flight range, then retain only the latest 16 again.
    const floor = this.observing ? this.observationSequenceFloor : undefined;
    for (const sequence of this.issued.keys()) {
      if (sequence < this.sequence - 15 && (floor === undefined || sequence < floor)) {
        this.issued.delete(sequence);
      }
    }
  }

  issuedSince(first, sequence, challenge) {
    return integer(sequence) && sequence >= first && sequence <= this.sequence &&
      this.issued.get(sequence) === challenge;
  }

  // TIN-5385: a native input call marks its input unsettled until its own
  // successful reply. In a hold scope only the confirmed release_holds
  // settles it. A pointer move outside a hold scope never marks it.
  async nativeInput(action, holdScope, operation) {
    if (holdScope !== undefined || !POINTER_MOVES.has(action)) this.nativeInputUnsettled = true;
    const responses = await operation();
    if (holdScope === undefined && Array.isArray(responses) && responses.length > 0 &&
        responses.every(response => object(response) && !response.error)) this.nativeInputUnsettled = false;
    return responses;
  }

  async nativeOperation(phase, operation) {
    try { return await operation(); }
    catch (error) {
      throw tagFailure(error, phase, localFailureReasons.get(error?.message) ?? 'unknown');
    }
  }

  activity(action, signal, { heartbeat = false } = {}) {
    const budget = action === 'begin_activity' ? HELPER_BEGIN_TIMEOUT_MS : HELPER_TIMEOUT_MS;
    return this.helperOperation(async () => {
      // A heartbeat queued behind work that ended the activity (a release, or
      // a refusal from a Host that released its lease) has nothing to renew.
      if (heartbeat && (!this.activityActive || !this.heartbeatEnabled)) return;
      const lapsedAt = this.permitLapsedAt;
      if (lapsedAt === undefined) this.assertPermit();
      const sequence = ++this.sequence;
      let challenge = randomUUID();
      let binding;
      let nativeStartedAt;
      if (this.nativeBinding && !this.nativeReleasing) {
        if (typeof this.native.inputPermitControl !== 'function') {
          throw new Error('Native independent input-permit protocol unavailable');
        }
        binding = { instance_id: this.instanceId, session_id: this.sessionId,
          display_id: this.displayId, displayGeneration: this.generation,
          ...this.nativeBinding, sequence };
        nativeStartedAt = this.now();
        const response = await this.nativeOperation('native_permit_begin', () =>
          this.native.inputPermitControl('begin_input_permit', binding, { signal, timeoutMs: budget }));
        challenge = validateNativePermit(response, binding).challenge;
        if (lapsedAt === undefined) this.assertPermit();
      }
      this.pruneChallenges();
      if (this.issued.size >= MAX_ISSUED_CHALLENGES) {
        throw localFailure('Host-helper observation challenge budget exceeded');
      }
      this.issued.set(sequence, challenge);
      this.pruneChallenges();
      // #177: a renewal sent for an agent batch is marked, so the Host's own
      // idle bound counts the agent, never the heartbeat.
      const receipt = await this.channel.request(action, { session_id: this.sessionId,
        sequence, challenge, ...this.displayParams, capture_backend: 'owned_sck',
        ...(action === 'renew_activity' && !heartbeat ? { agent_request: true } : {}) }, { signal, timeoutMs: budget });
      // A lapsed permit re-arms only from a renewal sent after the lapse.
      if (lapsedAt !== undefined && receipt.sentAt < lapsedAt) {
        throw localFailure('Host-helper input permit expired');
      }
      const beginning = action === 'begin_activity';
      const result = validateReady(receipt, this, (echoed, echoedChallenge) =>
        echoed === sequence && echoedChallenge === challenge,
      { refreshPermit: !binding && !beginning, roundTripMs: budget, lapsed: lapsedAt !== undefined });
      // Start at our earlier local send boundary. No clock from either
      // remote process can extend the native-created authorization window.
      let until = beginning && !binding
        ? Math.min(receipt.sentAt + INPUT_PERMIT_MS, receipt.sentAt + result.lease_remaining_ms) : undefined;
      if (binding) {
        const remaining = budget - (this.now() - nativeStartedAt);
        if (remaining <= 0) throw tagFailure(new Error('Native input-permit grant deadline exceeded'), 'native_permit_grant', 'deadline');
        const response = await this.nativeOperation('native_permit_grant', () =>
          this.native.inputPermitControl('grant_input_permit', {
            ...binding, challenge, lease_remaining_ms: result.lease_remaining_ms,
          }, { signal, timeoutMs: remaining }));
        validateNativePermit(response, binding, challenge, true);
        if (lapsedAt === undefined) this.assertPermit();
        until = Math.min(nativeStartedAt + INPUT_PERMIT_MS, nativeStartedAt + result.lease_remaining_ms);
      }
      this.activityActive = true;
      if (beginning && until !== undefined && this.now() >= until) {
        // A begin that answers within its budget but after the permit window
        // admits the owner with input refused: only the renewal ensureActivity
        // sends next can arm it, and without one the owner retires.
        this.permitUntil = until;
        this.permitStartedAt = binding ? nativeStartedAt : receipt.sentAt;
        this.permitLapsedAt = this.now();
        clearTimeout(this.lapseTimer);
        this.lapseTimer = setTimeout(() => {
          if (this.permitLapsedAt !== undefined) this.fail(localFailure('Host-helper input permit expired'));
        }, RENEW_INTERVAL_MS + HELPER_TIMEOUT_MS);
      } else {
        if (until !== undefined) this.refreshPermit(until, binding ? nativeStartedAt : receipt.sentAt);
        this.permitLapsedAt = undefined;
        clearTimeout(this.lapseTimer);
      }
      this.lastSequence = result.sequence;
      this.lastChallenge = result.challenge;
    });
  }

  async ensureActivity(signal) {
    if (this.activityActive) { this.assertPermit(); return; }
    const startedAt = this.now();
    await this.activity('begin_activity', signal);
    const beginMs = this.now() - startedAt;
    this.helperReleased = false;
    // The first heartbeat is answered a renewal interval and a round trip
    // from now. A begin slow enough to leave less permit than that (0.5 s of
    // Host work plus link latency on a remote Mac) renews at once instead.
    if (this.permitLapsedAt !== undefined || this.permitUntil - this.now() < RENEW_INTERVAL_MS + beginMs) {
      await this.activity('renew_activity', signal);
    }
    // The broker's bounded ownership lease still covers thinking gaps.
    // Schedule from the accepted permit deadline, not an unrelated interval.
    this.heartbeatEnabled = true;
    this.scheduleRenewal();
  }

  /** #177: after the agent's last request, release the Host activity once
   * the idle period passes with nothing queued. It runs on the serial tail,
   * so it never interleaves a batch, and a failed release fails the executor
   * like any other uncertain Host state. */
  scheduleIdleRelease() {
    clearTimeout(this.idleReleaseTimer);
    this.idleReleaseTimer = undefined;
    if (!this.activityIdleMs || !this.activityActive || this.failed || this.releasing || this.released) return;
    const armedAt = this.requestArrivals ?? 0;
    this.idleReleaseTimer = setTimeout(() => {
      this.idleReleaseTimer = undefined;
      const task = this.tail.then(async () => {
        if (this.idleReleaseTimer || (this.requestArrivals ?? 0) !== armedAt || !this.activityActive ||
            this.failed || this.releasing || this.released || this.activeController) return;
        // Commit before the first await: a request admitted from here on
        // sees no refs and is refused before admission, not inside the tail.
        this.axGeneration = undefined;
        this.axRefs = new Set();
        this.axEntryNodes = new Map();
        // No input runs on the tail meanwhile, so the permit no longer bounds it.
        this.idleReleasing = true;
        clearTimeout(this.permitTimer);
        clearTimeout(this.lapseTimer);
        this.permitLapsedAt = undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Host-helper idle release deadline exceeded')),
          IDLE_RELEASE_TIMEOUT_MS);
        try {
          await this.releaseActivity(controller.signal);
          this.idleReleases += 1;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.fail(tagFailure(failure, 'host_activity', controller.signal.aborted ? 'deadline' : 'receipt_mismatch'));
        } finally {
          clearTimeout(timer);
          this.idleReleasing = false;
        }
      });
      this.tail = task.catch(() => {});
    }, this.activityIdleMs);
    this.idleReleaseTimer.unref?.();
  }

  async releaseActivity(signal) {
    this.heartbeatEnabled = false;
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    if (this.helperReleased) return;
    const receipt = await this.helperOperation(() => this.channel.request('release_activity',
      { session_id: this.sessionId }, { signal }));
    if (receipt.result.instance_id !== this.instanceId ||
        receipt.result.display_id !== this.displayId ||
        receipt.result.displayGeneration !== this.generation || receipt.result.ready !== false ||
        receipt.result.lease_remaining_ms !== 0) throw new Error('Host-helper release receipt mismatch');
    this.helperReleased = true;
    this.activityActive = false;
    clearTimeout(this.permitTimer);
  }

  // An observation receipt reports the lease the Host held when it finished,
  // which may be a renewal sent while it ran. It never refreshes the permit.
  observationReceipt(receipt, first) {
    return validateReady(receipt, this, (sequence, challenge) => this.issuedSince(first, sequence, challenge),
      { refreshPermit: false, roundTripMs: HELPER_OBSERVATION_TIMEOUT_MS, lapsed: true });
  }

  // Pixels are returned only under a live owner: the Host's own receipt at
  // completion, and either a current permit or one lapsed under this read.
  assertObserver() {
    if (this.failed) throw this.failed;
    if (this.permitLapsedAt === undefined) this.assertPermit();
  }

  // D38: JPEG for model-facing frames, PNG when asked for lossless pixels.
  // A Host without image_formats returns PNG only.
  capture(signal, format = 'jpeg') {
    return this.observation(async () => {
      const first = this.lastSequence;
      // The agent-facing size: the native executor's scaled framebuffer.
      const maximumDimension = Math.max(this.native.display.width, this.native.display.height);
      const encoded = this.imageFormats.includes(format) ? format : 'png';
      // #163: a target scope fails closed on a Host that cannot apply it.
      if (this.hostCapture?.scope === 'target' && !this.helperActions.includes('capture_scope')) {
        throw localFailure('Host-helper capture scope unsupported');
      }
      const scope = this.hostCapture?.scope === 'target' ? { include_bundle_ids: this.hostCapture.applications }
        : this.hostCapture?.exclude ? { exclude_bundle_ids: this.hostCapture.exclude } : {};
      const receipt = await this.channel.request('capture', { session_id: this.sessionId,
        ...this.displayParams, capture_backend: 'owned_sck', max_dimension: maximumDimension, ...scope,
        ...(this.imageFormats.includes(format) ? { format } : {}) }, { signal, timeoutMs: HELPER_OBSERVATION_TIMEOUT_MS,
        stallMs: HELPER_OBSERVATION_STALL_MS,
        ...(this.replyParts ? { partBytes: HELPER_REPLY_PART_BYTES } : {}) });
      const result = this.observationReceipt(receipt, first);
      await validateImage(result, maximumDimension, encoded === 'jpeg' ? 'image/jpeg' : 'image/png');
      if (this.hostOnly) this.native.assertFrame(result.nativeWidth, result.nativeHeight,
        result.pixels_per_point_x, result.pixels_per_point_y);
      this.assertObserver();
      return result;
    });
  }

  // Observation only: a live AX read under the same activity lease as
  // capture. It never seeds input authorization or a cached frame.
  axSnapshot(action, signal) {
    return this.observation(async () => {
      const first = this.lastSequence;
      let receipt;
      try {
        receipt = await this.channel.request('ax_snapshot', { session_id: this.sessionId,
          ...this.displayParams, capture_backend: 'owned_sck',
          ...(action.depth === undefined ? {} : { depth: action.depth }),
          ...(action.focused_app === undefined ? {} : { focused_app: action.focused_app }),
          ...(action.menu_extras === undefined ? {} : { menu_extras: action.menu_extras }),
          ...(action.root === undefined ? {} : { root: action.root }),
          ...(action.max_nodes === undefined ? {} : { max_nodes: action.max_nodes }) },
        { signal, timeoutMs: HELPER_OBSERVATION_TIMEOUT_MS, stallMs: HELPER_OBSERVATION_STALL_MS });
      } catch (error) {
        // The Host resolves the root before reading; its lease stays.
        if (!AX_SNAPSHOT_REFUSALS.has(error?.code) || hostHelperRefusalMessage(error) === undefined) throw error;
        return { refusal: error };
      }
      const result = this.observationReceipt(receipt, first);
      const snapshot = validateSnapshot(result.ax_snapshot, this.native.display);
      if (this.hostOnly) this.native.assertFrame(snapshot.framebuffer.pixel_width,
        snapshot.framebuffer.pixel_height, snapshot.framebuffer.scale, snapshot.framebuffer.scale);
      this.assertObserver();
      // The Host replaced its generation; so does this executor. A Host
      // without element actions reports none and leaves no refs.
      this.axGeneration = snapshot.generation;
      this.axRefs = new Set(snapshot.generation === undefined ? [] : snapshot.nodes.map(node => node.ref));
      // #181: enter_element_value needs a readout's strip and owner, not its
      // frame, which it reads again just before acting.
      const bundles = new Map(snapshot.applications.map(application => [application.pid, application.bundle_id]));
      this.axEntryNodes = new Map(snapshot.generation === undefined ? [] : snapshot.nodes
        .filter(node => node.role === 'AXTextField' && node.parent !== null)
        .map(node => [node.ref, { parent: node.parent, bundle: bundles.get(Number(node.ref.split(':')[1])) }]));
      this.axFramebuffer = snapshot.framebuffer;
      return { detail: `ax_snapshot: ${snapshot.node_count} nodes${snapshot.truncated ? ' (truncated)' : ''}`,
        ax_snapshot: snapshot };
    });
  }

  // `refusals` names the pre-act Host reasons this request answers as a
  // per-call refusal, after the lease state is settled in the same turn.
  axHostRequest(name, params, signal, { refusals } = {}) {
    return this.helperOperation(async () => {
      const sequence = this.lastSequence;
      const challenge = this.lastChallenge;
      let receipt;
      try {
        receipt = await this.channel.request(name, { session_id: this.sessionId, ...this.displayParams,
          capture_backend: 'owned_sck', ...params }, { signal });
      } catch (error) {
        // Only a pending-matched, sanitized Host refusal carries its code here.
        if (!refusals?.has(error?.code) || hostHelperRefusalMessage(error) === undefined) throw error;
        await this.settleRefusedLease(signal);
        return { refusal: error };
      }
      const result = validateReady(receipt, this, (echoed, echoedChallenge) =>
        echoed === sequence && echoedChallenge === challenge, { refreshPermit: false });
      this.assertPermit();
      return result;
    });
  }

  // #159: a current Host keeps its lease after a pre-act refusal; one that
  // predates the fix released it. Read-only health says which, inside the
  // helper queue so no renewal runs first. This session's ready lease
  // continues. No lease at all ends the activity here, and the next batch
  // begins a fresh one. Any other state retires the executor as before.
  async settleRefusedLease(signal) {
    const { result } = await this.channel.request('health', { ...this.displayParams,
      capture_backend: 'owned_sck' }, { signal });
    validateHealth(result, this.config);
    if (result.instance_id !== this.instanceId || result.displayGeneration !== this.generation ||
        result.display_id !== this.displayId) {
      throw tagFailure(new Error('Host-helper identity changed after a refusal'), 'host_activity', 'receipt_mismatch');
    }
    this.observeAccessibility(result);
    if (result.session_id === this.sessionId && result.ready === true) return 'retained';
    if (result.session_id === undefined && result.ready === false && result.overlay_ready === false &&
        result.lease_remaining_ms === 0) {
      this.endActivity();
      return 'released';
    }
    throw tagFailure(new Error('Host-helper lease state after a refusal is unconfirmed'), 'host_activity',
      'receipt_mismatch');
  }

  // The Host holds no lease for this session: stop renewing, forget refs
  // from that lease and leave no permit. Nothing is sent to the Host.
  endActivity() {
    this.heartbeatEnabled = false;
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    clearTimeout(this.permitTimer);
    clearTimeout(this.lapseTimer);
    this.activityActive = false;
    this.helperReleased = true;
    this.permitUntil = undefined;
    this.permitLapsedAt = undefined;
    this.axGeneration = undefined;
    this.axRefs = new Set();
    this.axEntryNodes = new Map();
  }

  // A pre-act refusal as this action's response. The batch stops at it.
  perCallRefusal(error) {
    const response = { id: randomUUID(), error: { code: PER_CALL_REFUSAL_CODE, message: error.message,
      data: { ...(object(error.data) ? error.data : {}), code: error.code } } };
    perCallRefusals.add(response);
    return response;
  }

  // A VNC click needs the qualified mapping and a native backend that can
  // click under the independent input permit.
  get axVncFallback() {
    if (this.hostOnly) return false;
    const native = this.native.capabilities ?? nativeCapabilities();
    return Boolean(this.config.mapping) &&
      (!native.known || (native.actions.includes('mouse_click') && this.supportsNativeMapping(native)));
  }

  /** click_element / focus_element. The Host performs AXPress / AXFocused
   * (or AXShowMenu / AXRaise) and verifies it. Only when the element
   * definitely did not act does it return a framebuffer point; that point is
   * clicked through the ordinary input path (mapping check, input-settle gate,
   * native permit) and the Host then verifies the click. */
  async axElement(action, signal, deadline, scoped) {
    const kind = AX_ELEMENT_ACTIONS.get(action.action);
    const generation = this.axGeneration;
    const framebuffer = this.axFramebuffer;
    const fallback = this.axVncFallback;
    const acted = await this.axHostRequest('ax_action', { generation, ref: action.ref, action: kind,
      vnc_fallback: fallback }, signal, { refusals: AX_PRE_ACT_REFUSALS });
    if (acted.refusal) return this.perCallRefusal(acted.refusal);
    const outcome = validateAxOutcome(acted.ax_action, action.ref, kind, generation, framebuffer);
    const { ref, path, surface, role, subrole, verified, ax_result: axResult } = outcome;
    const report = (record) => ({ id: randomUUID(), result: {
      detail: `${action.action} ${ref}: ${record.path}, verified ${record.verified}`,
      ax_action: { ref, action: action.action, surface, role, ...(subrole === undefined ? {} : { subrole }),
        ...record } } });
    if (path !== AX_FALLBACK_PATH) return report({ path, verified, ax_result: axResult });
    if (this.hostOnly) throw new Error('Host-only transport refused a VNC fallback request');
    const mapping = this.config.mapping;
    if (!fallback || framebuffer.pixel_width !== mapping.nativeWidth ||
        framebuffer.pixel_height !== mapping.nativeHeight) {
      throw new Error('Host-helper AX fallback outside the qualified mapping');
    }
    const point = {
      x: Math.min(mapping.scaledWidth - 1, Math.floor(outcome.fallback_point.x * mapping.scaledWidth / mapping.nativeWidth)),
      y: Math.min(mapping.scaledHeight - 1, Math.floor(outcome.fallback_point.y * mapping.scaledHeight / mapping.nativeHeight)),
    };
    await this.verifyMapping(signal, Math.max(1, deadline - this.now()), scoped.holdScope);
    this.assertPermit();
    if (this.failed) throw this.failed;
    const [clicked] = await this.nativeInput('mouse_click', scoped.holdScope, () =>
      this.native.execute([{ action: 'mouse_click', x: point.x, y: point.y }],
        { signal, timeoutMs: Math.max(1, deadline - this.now()), ...scoped }));
    if (!clicked || clicked.error) return clicked;
    const checked = await this.axHostRequest('ax_verify', { generation, ref, action: kind }, signal);
    const receipt = checked.ax_verify;
    if (!object(receipt) || receipt.ref !== ref || receipt.action !== kind || receipt.generation !== generation ||
        typeof receipt.verified !== 'boolean') throw new Error('Invalid host-helper AX verification receipt');
    return report({ path: 'vnc_click', verified: receipt.verified, point });
  }

  // The native controller holds input for its settle time after ServerInit
  // (Apple ignores early input). Wait here, before adoption and the native
  // permit, so the short permit lease is never spent waiting. A wait that
  // cannot finish before the operation deadline fails as input_not_ready.
  async awaitInputSettle(health, signal, deadline) {
    const remaining = health.input_settle_remaining_ms;
    if (health.input_ready !== false || !Number.isSafeInteger(remaining) || remaining <= 0) return;
    if (this.now() + remaining >= deadline) {
      throw Object.assign(new Error(`Input not ready: the server ignores input for ${remaining} ms more after connecting`),
        { code: -32013, data: { reason: 'input_not_ready', remaining_ms: remaining } });
    }
    if (signal?.aborted) throw signal.reason;
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, remaining);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async verifyMapping(signal, timeoutMs, holdScope) {
    const deadline = this.now() + timeoutMs;
    const mapping = this.config.mapping;
    if (!mapping) throw new Error('Host-helper input mapping is not qualified');
    const capture = await this.capture(signal);
    if (this.permitLapsedAt !== undefined) await this.activity('renew_activity', signal);
    if (!['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => capture[key] === mapping[key]) ||
        (mapping.displayId !== undefined && capture.display_id !== mapping.displayId) ||
        (mapping.displayUuid !== undefined && capture.display_uuid !== mapping.displayUuid) ||
        // A qualified scale binds the HiDPI mode; a mode change with equal
        // pixel sizes but different points cannot reuse the mapping.
        (mapping.scale !== undefined && capture.scale !== mapping.scale) ||
        !sameBounds(capture.display_bounds, mapping.displayBounds)) {
      throw tagFailure(new Error('Host-helper qualified mapping changed'), 'mapping_capture', 'geometry_mismatch');
    }
    const [health] = await this.nativeOperation('mapping_health', () =>
      this.native.execute([{ action: 'health' }], { signal, timeoutMs, holdScope }));
    if (health?.error) throw nativeFailure('mapping_health', health.error, 'Host-helper and VNC geometry mismatch');
    if (!object(health?.result) ||
        !['nativeWidth', 'nativeHeight', 'scaledWidth', 'scaledHeight'].every(key => health.result[key] === mapping[key]) ||
        this.native.display.width !== mapping.scaledWidth || this.native.display.height !== mapping.scaledHeight) {
      throw tagFailure(new Error('Host-helper and VNC geometry mismatch'), 'mapping_health', 'geometry_mismatch');
    }
    const fields = NATIVE_GEOMETRY_FIELDS;
    if (!fields.every(key => integer(health.result[key]))) {
      throw tagFailure(new Error('Native observation allocation binding unavailable'), 'mapping_health', 'receipt_mismatch');
    }
    const binding = Object.fromEntries(fields.map(key => [key, health.result[key]]));
    if (this.nativeBinding && !fields.every(key => this.nativeBinding[key] === binding[key])) {
      throw tagFailure(new Error('Native input-permit allocation binding changed'), 'mapping_health', 'geometry_mismatch');
    }
    await this.awaitInputSettle(health.result, signal, deadline);
    // This private native seam adopts the independently qualified SCK
    // observation. It is never accepted from public MCP tool parameters and
    // never takes/discards a raw VNC screenshot to seed input authorization.
    const [adopted] = await this.nativeOperation('observation_adopt', () =>
      this.native.execute([{ action: 'adopt_observation', ...binding }], { signal, timeoutMs, holdScope }));
    if (adopted?.error) throw nativeFailure('observation_adopt', adopted.error, 'Native external-observation adoption unconfirmed');
    if (!object(adopted?.result) ||
        !fields.every(key => adopted.result[key] === binding[key])) {
      throw tagFailure(new Error('Native external-observation adoption unconfirmed'), 'observation_adopt', 'receipt_mismatch');
    }
    this.nativeBinding ??= binding;
    // Fresh ready acknowledgement after mapping work; no old permit is reused.
    await this.activity('renew_activity', signal);
  }

  execute(actions, { signal, timeoutMs = 30000, onResponse } = {}) {
    if (this.releasing || this.released) return Promise.reject(new Error('Host-helper executor is releasing'));
    // #177: an agent request (not a health check) holds the activity. A
    // release already queued skips itself when it sees a newer arrival; a
    // request refused below re-arms the idle period.
    const holdsActivity = Array.isArray(actions) && actions.some(action => action?.action !== 'health');
    if (holdsActivity) {
      this.requestArrivals = (this.requestArrivals ?? 0) + 1;
      clearTimeout(this.idleReleaseTimer);
      this.idleReleaseTimer = undefined;
    }
    const rearm = error => { if (holdsActivity) this.scheduleIdleRelease(); return Promise.reject(error); };
    if (!Array.isArray(actions) || !actions.length || actions.length > 256 ||
        actions.some(action => !object(action))) {
      return rearm(new Error('Invalid host-helper action batch'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return rearm(new Error('Invalid host-helper operation deadline'));
    }
    try { this.preflight(actions); }
    catch (error) { return rearm(error); }
    const deadline = this.now() + timeoutMs;
    const controller = new AbortController();
    const responses = [];
    const responseBudget = this.responseBudgetFactory();
    const abort = () => controller.abort(new Error('Host-helper operation cancelled'));
    if (signal?.aborted) return rearm(new Error('Host-helper operation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Host-helper operation deadline exceeded')), timeoutMs);
    let rejectCancellation;
    const cancellation = new Promise((resolve, reject) => { rejectCancellation = reject; });
    const cancelled = () => {
      const error = controller.signal.reason || new Error('Host-helper operation cancelled');
      error.responses = responses.map(responseMetadata);
      rejectCancellation(error);
    };
    controller.signal.addEventListener('abort', cancelled, { once: true });
    // D27: this wrapper splits one batch into native calls, so it owns the
    // batch's hold scope: every native call carries it, then release_holds.
    const holdScope = actions.some(action => HOLD_ACTIONS.has(action.action)) ? randomUUID() : undefined;
    const scoped = holdScope === undefined ? {} : { holdScope };
    const task = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      if (controller.signal.aborted) throw controller.signal.reason;
      this.preflight(actions);
      this.activeController = controller;
      const onAbort = () => this.fail(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        // Capability discovery through health does not acquire the overlay or
        // input permit. Other admitted work retains its existing lease rules.
        if (actions.some(action => action.action !== 'health')) {
          try {
            const wasActive = this.activityActive;
            await this.ensureActivity(controller.signal);
            // A batch that reaches the Host renews on its own; any other one
            // tells the Host the agent is still there (#177).
            const hostBound = actions.some(action => HOST_ACTIONS.has(action.action) ||
              HOST_INPUT_ACTIONS.has(action.action) || HOST_VALUE_ACTIONS.has(action.action));
            if (wasActive && !hostBound) {
              await this.activity('renew_activity', controller.signal);
            }
          } catch (error) {
            // #177: after an idle release another Host client may hold the
            // single Host lease. Nothing is held or sent, so this batch is
            // refused per call and the lane keeps its owner.
            if (this.idleReleases > 0 && !this.activityActive && !this.failed && error?.code === 'host_busy' &&
                hostHelperRefusalMessage(error) !== undefined) {
              const busy = Object.assign(new Error('FruitctlHost is serving another session; retry later'),
                { code: 'host_busy' });
              const response = this.perCallRefusal(busy);
              responses.push(response);
              onResponse?.(responseMetadata(response));
              return responses;
            }
            throw error;
          }
        }
        for (const action of actions) {
          if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
          this.assertPermit();
          const remaining = deadline - this.now();
          if (remaining <= 0) throw new Error('Host-helper operation deadline exceeded');
          let response;
          if (action.action === 'screenshot') {
            await this.activity('renew_activity', controller.signal);
            try {
              response = { id: randomUUID(), result: await this.capture(controller.signal, action.format) };
            } catch (error) {
              // No target window is running: nothing was captured (#163).
              if (error?.code !== 'capture_target_unavailable' || hostHelperRefusalMessage(error) === undefined) throw error;
              response = this.perCallRefusal(error);
            }
            if (this.permitLapsedAt !== undefined) await this.activity('renew_activity', controller.signal);
          } else if (action.action === 'ax_snapshot') {
            await this.activity('renew_activity', controller.signal);
            const read = await this.axSnapshot(action, controller.signal);
            response = read.refusal ? this.perCallRefusal(read.refusal) : { id: randomUUID(), result: read };
            if (this.permitLapsedAt !== undefined) await this.activity('renew_activity', controller.signal);
          } else if (AX_ELEMENT_ACTIONS.has(action.action)) {
            await this.activity('renew_activity', controller.signal);
            response = await this.axElement(action, controller.signal, deadline, scoped);
          } else if (this.hostOnly && HOST_INPUT_ACTIONS.has(action.action)) {
            await this.activity('renew_activity', controller.signal);
            response = await this.hostInputAction(action, controller.signal);
          } else if (action.action === 'enter_element_value') {
            await this.activity('renew_activity', controller.signal);
            response = await this.enterElementValue(action, controller.signal);
          } else if (HOST_VALUE_ACTIONS.has(action.action)) {
            await this.activity('renew_activity', controller.signal);
            response = await this.hostValueAction(action, controller.signal);
          } else if (action.action === 'health') {
            let health;
            if (this.hostOnly) {
              const { result } = await this.channel.request('health', { ...this.displayParams,
                capture_backend: 'owned_sck' }, { signal: controller.signal, timeoutMs: remaining });
              validateHealth(result, this.config);
              if (result.instance_id !== this.instanceId || result.displayGeneration !== this.generation) {
                throw new Error('Host-only health identity changed');
              }
              this.native.bindHealth(result);
              this.observeAccessibility(result);
              this.observeInput(result);
              health = { id: randomUUID(), result: { ...result, transport: 'host-only', vnc: false,
                scaledWidth: this.display.width, scaledHeight: this.display.height } };
            } else {
              [health] = await this.native.execute([action], { signal: controller.signal, timeoutMs: remaining,
                ...scoped });
            }
            response = health.error ? health : { ...health, result: { ...health.result,
              capabilities: this.capabilities, hostHelper: {
              captureBackend: 'owned_sck', displayId: this.displayId,
              ...(this.config.displayUuid === undefined ? {} : { displayUuid: this.config.displayUuid }),
              displayGeneration: this.generation, inputMappingQualified: Boolean(this.config.mapping) } } };
          } else if (INPUT_ACTIONS.has(action.action)) {
            await this.verifyMapping(controller.signal, remaining, holdScope);
            // D16: a fresh Host renewal immediately before a secret, so a
            // lease or Stop that says no fails here, before any keystroke.
            if (action.action === 'type_secret') await this.activity('renew_activity', controller.signal);
            this.assertPermit();
            if (this.failed) throw this.failed;
            if (action.action === 'mouse_down') this.holdPressed = true;
            [response] = await this.nativeOperation('native_input', () =>
              this.nativeInput(action.action, holdScope, () => this.native.execute([action], {
                signal: controller.signal, timeoutMs: Math.max(1, deadline - this.now()), ...scoped })));
          } else if (MAPPED_READ_ACTIONS.has(action.action) || NATIVE_READ_ACTIONS.has(action.action)) {
            [response] = await this.native.execute([action], { signal: controller.signal, timeoutMs: remaining,
              ...scoped });
          } else if (action.action === 'wait' &&
              (action.ms === undefined || (integer(action.ms, 50) && action.ms <= 10000))) {
            [response] = await this.native.execute([action], { signal: controller.signal, timeoutMs: remaining,
              ...scoped });
          } else {
            throw new Error('Action unavailable with owned host-helper capture');
          }
          if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
          this.assertPermit();
          responseBudget.add(response);
          responses.push(response);
          onResponse?.(responseMetadata(response));
          // An unknown clipboard is an answer, not a native failure: end the
          // batch there without retiring the Host route.
          if (response.error && NATIVE_READ_ACTIONS.has(action.action) &&
              response.error.code === CLIPBOARD_UNAVAILABLE_CODE) break;
          // #159: a pre-act Host refusal ends the batch; nothing acted.
          if (response.error && perCallRefusals.has(response)) break;
          if (response.error) throw nativeFailure(INPUT_ACTIONS.has(action.action) ? 'native_input' : 'native_read', response.error, 'Native operation failed');
        }
        if (holdScope) {
          // Batch end releases any live hold. A failure path instead retires
          // the native controller, whose shutdown releases held input.
          const remaining = deadline - this.now();
          if (remaining <= 0) throw new Error('Host-helper operation deadline exceeded');
          const [released] = await this.native.execute([{ action: 'release_holds' }],
            { signal: controller.signal, timeoutMs: remaining, holdScope });
          if (released?.error) throw new Error('Batch-scoped mouse hold release unconfirmed');
          if (object(released)) this.nativeInputUnsettled = false;
        }
        return responses;
      } catch (error) {
        this.fail(error);
        error.responses = responses.map(responseMetadata);
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        this.activeController = undefined;
        this.holdPressed = false;
        // A health check neither holds nor restarts the idle period (#177).
        if (holdsActivity) this.scheduleIdleRelease();
      }
    });
    this.tail = task.catch(() => {});
    return Promise.race([task, cancellation]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancelled);
    });
  }

  release({ signal, timeoutMs = 30000 } = {}) {
    clearTimeout(this.idleReleaseTimer);
    this.idleReleaseTimer = undefined;
    if (this.releasing) return this.releasing;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return Promise.reject(new Error('Invalid host-helper release deadline'));
    }
    // #159: a failed Host-only executor proves its release from the Host.
    // TIN-5385: so does a VNC executor whose input is settled.
    if (this.failed && this.releaseProvable) {
      this.releasing = this.reconcileRelease({ signal, timeoutMs });
      return this.releasing;
    }
    const deadline = this.now() + timeoutMs;
    const controller = new AbortController();
    this.releaseController = controller;
    const abort = () => controller.abort(new Error('Host-helper release cancelled'));
    const interrupted = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        this.fail(controller.signal.reason, { deadline, signal: controller.signal });
        reject(controller.signal.reason);
      }, { once: true });
    });
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Host-helper release deadline exceeded')), timeoutMs);
    if (signal?.aborted) abort();
    const releaseTask = (async () => {
      try {
        await this.tail;
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        if (typeof this.native.release !== 'function') throw new Error('Native clean release is unavailable');
        // Keep the resident indication alive while native shutdown confirms
        // held-state release, but finish any permit control already in flight
        // before the native executor starts refusing successor requests.
        this.nativeReleasing = true;
        await Promise.all([this.helperTail, this.observationTail]);
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        await this.native.release({ signal: controller.signal,
          timeoutMs: Math.max(1, deadline - this.now()) });
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        await this.releaseActivity(controller.signal);
        const { result } = await this.helperOperation(() => this.channel.request('health', {
          ...this.displayParams, capture_backend: 'owned_sck' }, { signal: controller.signal }));
        validateHealth(result, this.config);
        // #177: after an idle release another session may hold the Host's one
        // lease; only this executor's own session must be gone.
        const foreign = this.hostOnly && this.idleReleases > 0 && typeof result.session_id === 'string' &&
          result.session_id !== this.sessionId;
        if (result.instance_id !== this.instanceId || result.displayGeneration !== this.generation ||
            result.display_id !== this.displayId || (!foreign &&
            (result.ready !== false || result.overlay_ready !== false || result.capture_ready !== false ||
              result.lease_remaining_ms !== 0))) throw new Error('Host-helper overlay release unconfirmed');
        await this.channel.close({ deadline, signal: controller.signal });
        if (this.failed || controller.signal.aborted) throw this.failed || controller.signal.reason;
        this.released = true;
      } catch (error) { this.fail(error, { deadline, signal: controller.signal }); throw error; }
    })();
    this.releasing = Promise.race([releaseTask, interrupted]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.releaseController = undefined;
    });
    return this.releasing;
  }

  /** #159: release proof for a failed executor. The Host ends a lease
   * when its connection closes. Release is confirmed only when this
   * executor's own SSH child has exited and a fresh, read-only attachment
   * to the configured Host reports no lease, indicator or capture
   * readiness. The probe's own child must also exit. Nothing is sent but
   * health, and no failure is cleared: the executor stays failed.
   * TIN-5385: a VNC executor runs this only with its VNC input settled
   * (releaseProvable). Its native child's exit must be observed before the
   * probe starts. Settled means every input call had its own reply. RFB has
   * no input acknowledgement, so that reply does not prove the target
   * received the input, and fail() ends the child without the native
   * shutdown handshake. nativeReleaseProof records this for the receipt. */
  reconcileRelease({ signal, timeoutMs = 5000 } = {}) {
    if (!this.failed || !this.releaseProvable) {
      return Promise.reject(new Error('Release proof requires a failed executor that can prove its release'));
    }
    if (this.reconciled) return this.reconciled;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
      return Promise.reject(new Error('Invalid host-helper release deadline'));
    }
    const deadline = this.now() + timeoutMs;
    const exited = (channel, cause) => new Promise((resolve, reject) => {
      // 'close' follows exit once the child's stdio ends; wait within budget.
      let abort;
      const timer = setTimeout(() => finish(localFailure(cause)), Math.max(0, deadline - this.now()));
      const finish = error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      abort = () => finish(localFailure('Host-helper operation cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      channel.childClosed.then(() => finish());
    });
    const task = (async () => {
      // A failed channel already signalled its child; never reconnect first.
      void this.channel.close({ deadline }).catch(() => {});
      await exited(this.channel, 'Host-helper transport exited');
      // TIN-5385: fail() already signalled the VNC child. Its exit, even a
      // late one, ends every input path this executor had.
      if (!this.hostOnly) {
        await exited({ childClosed: this.native.closed }, 'Native owned exit unconfirmed');
        this.nativeReleaseProof = Object.freeze({ input_settled: true, exit_observed: true, delivery_proven: false });
      }
      const probe = new HelperChannel(this.config, this.spawnImpl, () => {}, this.now);
      let receipt;
      try {
        let result;
        for (;;) {
          ({ result } = await probe.request('health', { ...this.displayParams, capture_backend: 'owned_sck' },
            { signal, timeoutMs: Math.max(1, Math.min(HELPER_CONNECT_TIMEOUT_MS, deadline - this.now())) }));
          validateHealth(result, this.config);
          // Any instance may answer: a restarted Host holds no prior lease.
          if (result.session_id === undefined && result.ready === false && result.overlay_ready === false &&
              result.capture_ready === false && result.lease_remaining_ms === 0) break;
          // Only this executor's own lease may still be draining: the Host
          // can read our disconnect after the probe connects, and it expires
          // an unrenewed lease within 3 s. Another session never clears.
          if (result.session_id !== this.sessionId || this.now() + RENEW_INTERVAL_MS / 2 >= deadline) {
            throw tagFailure(new Error('Host-only release unconfirmed: the Host reports activity'), 'host_activity',
              'receipt_mismatch');
          }
          await new Promise(resolve => setTimeout(resolve, RENEW_INTERVAL_MS / 2));
          if (signal?.aborted) throw localFailure('Host-helper operation cancelled');
        }
        receipt = Object.freeze({ instance_id: result.instance_id,
          same_instance: result.instance_id === this.instanceId, display_id: result.display_id,
          displayGeneration: result.displayGeneration, lease_remaining_ms: 0,
          human_stop_latched: result.human_stop_latched === true });
      } finally {
        void probe.close({ deadline }).catch(() => {});
        await exited(probe, 'Host-helper transport exited');
      }
      this.released = true;
      return receipt;
    })();
    this.reconciled = task;
    // A failed proof may be retried by a later reconcile with a new probe.
    task.catch(() => { if (this.reconciled === task) this.reconciled = undefined; });
    return task;
  }

  async close({ signal, timeoutMs, deadline } = {}) {
    clearTimeout(this.idleReleaseTimer);
    this.idleReleaseTimer = undefined;
    const inherited = Object.fromEntries(Object.entries({ signal, timeoutMs, deadline })
      .filter(([, value]) => value !== undefined));
    const options = Object.keys(inherited).length ? inherited : undefined;
    // Reconciled: every owned child was seen to exit.
    if (this.released && this.failed && this.releaseProvable) return;
    if (this.released) { await this.channel.close(options); return; }
    if (this.failed && options) {
      // Shorten already-started owned retirement without replacing its
      // original nativeClosing/helperClosing tracking or clearing failure.
      try { this.nativeClosingUpdate = Promise.resolve(this.native.close({ graceful: false, ...options })); }
      catch (error) { this.nativeClosingUpdate = Promise.reject(error); }
      this.nativeClosingUpdate.catch(() => {});
      this.channel.close(options).catch(() => {});
    }
    this.fail(new Error('Host-helper executor closed'), options);
    await Promise.all([this.nativeClosing, this.helperClosing, this.nativeClosingUpdate]);
  }
}

export async function createHostHelperExecutor(options) {
  let executor;
  try {
    executor = new HostHelperExecutor(options);
    return await executor.ready();
  } catch (error) {
    if (executor) await executor.close();
    else await options.nativeExecutor.close({ graceful: false });
    throw error;
  }
}
