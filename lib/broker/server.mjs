// SPDX-License-Identifier: MIT
import net from 'node:net';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, errorRecord, MAX_REQUEST_BYTES } from './protocol.mjs';
import { prepareSocket, usCompatibleInputSource, validateTargetTransport } from './paths.mjs';
import { hostHelperRefusalMessage, hostHelperFailureCause } from './host-helper.mjs';
import { ResponseBudget, responseMetadata } from '../mcp/protocol.js';
import { executionBudget, retirementDeadline, RETIREMENT_TIMEOUT_MS } from '../deadlines.mjs';
import { isPreAdmissionRefusal, preAdmissionRefusal, presentationLabels, RAW_PRESENTATION, HOST_ROUTE_ACTIONS,
  routeRefusal, INPUT_ACTIONS, clipboardReadRefusal } from '../mcp/capabilities.js';
import { WakeHold, wakeOptions, typedFailure, withWakeHealth } from './wake.mjs';
import { DesktopSentinel, desktopStateOptions, desktopRefusal, withDesktopState, observesDesktop,
  DESKTOP_STATE_NOT_CONFIGURED } from './desktop-state.mjs';
import { ActionObserver } from './observe.mjs';
import { credentialSpec, envProviderNames, resolveSecret, scrubbedEnvironment, SecretError } from './secrets.mjs';
import { planSecretBatch, resolveSecretBatch, resolveAllowlistedSecrets, secretResponse } from './type-secret.mjs';
import { boundClipboardResponse, CLIPBOARD_MAX_BYTES } from '../mcp/clipboard.js';

const MAX_ACTIONS = 256;
const MAX_WAITING = 64;
const TOOL_TIMEOUT_MS = 30000;
const STARTUP_CLEANUP_MS = 2000;
// How long a health result waits for a desktop-state probe already running.
const HEALTH_STATE_WAIT_MS = 1500;

const validDeadline = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
/** A request deadline that is not a positive number of milliseconds. */
function invalidDeadline() {
  return preAdmissionRefusal('Invalid operation deadline: timeoutMs must be a positive number of milliseconds',
    'invalid_deadline');
}
/** The owner's idle connection is closing; nothing was admitted. */
function idleRetiringRefusal() {
  return preAdmissionRefusal('Target is closing its idle connection; retry the request', 'target_idle_retiring');
}

/** D8/D29 profile fields as the native executor's text policy. The VNC
 * credential is a declared secret: clipboard_read never returns text that
 * contains it. The lane adds the size cap and allowlisted D16 secrets. */
export function textPolicyFor(profile, secrets = []) {
  const { input = {}, clipboard = {} } = profile;
  return { pasteUnmappable: input.pasteUnmappable === true,
    usInputSource: usCompatibleInputSource(profile.inputSource),
    clipboardRead: clipboard.read === true,
    ...(clipboard.ttlMs === undefined ? {} : { clipboardTtlMs: clipboard.ttlMs }),
    extendedClipboard: clipboard.extended !== false,
    secrets: secrets.filter(Boolean) };
}

// Exported for offline tests of profile-to-launch mapping; never a second launch path.
export async function nativeFactory(profile, { signal, deadline, onExecutor, secretEnv = [], hostSpawn,
  hostActivityIdleMs } = {}) {
  if (validateTargetTransport(profile)) {
    const { createHostOnlyExecutor } = await import('./host-only.mjs');
    const activityIdleMs = hostActivityIdleMs ?? profile.hostActivityIdleMs;
    return createHostOnlyExecutor({ hostHelper: profile.hostHelper, hostInput: profile.hostInput,
      hostCapture: profile.hostCapture, signal, deadline,
      onExecutor,
      ...(activityIdleMs === undefined ? {} : { activityIdleMs }),
      ...(hostSpawn ? { spawnImpl: hostSpawn } : {}) });
  }
  const { createNativeExecutor, validCaptureTimeoutMs } = await import('../mcp/native.js');
  const spec = credentialSpec(profile);
  if (!profile.vnc || !spec) throw new Error('Target lacks a VNC credential provider');
  const { host, port, username = '', requestMode, captureTimeoutMs } = profile.vnc;
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof username !== 'string' ||
      (requestMode !== undefined && !['stream', 'on-demand'].includes(requestMode)) ||
      (captureTimeoutMs !== undefined && !validCaptureTimeoutMs(captureTimeoutMs))) {
    throw new Error('Invalid VNC profile');
  }
  // Env-provider variables never reach the daemon or a provider command.
  const childEnv = scrubbedEnvironment(process.env, secretEnv);
  let credential;
  try {
    credential = await resolveSecret(spec, { signal, childEnv,
      ...(Number.isFinite(deadline) ? { timeoutMs: Math.max(1, deadline - performance.now()) } : {}) });
  } catch (error) {
    const reason = error instanceof SecretError ? error.reason : 'spawn_failed';
    throw Object.assign(new Error(`VNC credential provider ${spec.provider} failed: ${reason}`),
      { code: 'credential_unavailable' });
  }
  const env = { ...childEnv, VNC_HOST: host, VNC_PORT: String(port),
    VNC_USERNAME: username, VNC_PASSWORD: credential };
  delete env.CLAUDE_KVM_DAEMON_PARAMETERS;
  const native = await createNativeExecutor({ env, daemonPath: profile.daemonPath, signal, deadline, onExecutor,
    log: () => {}, emitDiagnostics: false, ...(requestMode === undefined ? {} : { requestMode }),
    ...(captureTimeoutMs === undefined ? {} : { captureTimeoutMs }),
    textPolicy: textPolicyFor(profile, [credential]) });
  if (!profile.hostHelper) return native;
  const { HostHelperExecutor } = await import('./host-helper.mjs');
  let helper;
  try {
    if (signal?.aborted || performance.now() >= deadline) throw signal?.reason || new Error('Operation deadline exceeded');
    helper = new HostHelperExecutor({ nativeExecutor: native, hostHelper: profile.hostHelper });
    onExecutor?.(helper);
    return await helper.ready();
  } catch (error) {
    await (helper || native).close({ graceful: false });
    throw error;
  }
}

function boundedErrorResponses(responses, count) {
  const admitted = [];
  const budget = new ResponseBudget({ maxResponses: Math.max(1, Math.min(MAX_ACTIONS, count || 1)) });
  if (!Array.isArray(responses)) return admitted;
  for (const response of responses) {
    try { admitted.push(budget.add(responseMetadata(response))); } catch { break; }
  }
  return admitted;
}

export class TargetLane {
  #firstCause;
  get firstCause() { return this.#firstCause; }
  rememberFirstCause(error) {
    this.#firstCause ??= hostHelperFailureCause(this.executor?.failed) ?? hostHelperFailureCause(error) ??
      Object.freeze({ phase: 'operation', reason: 'unknown' });
  }
  firstCauseText() {
    const cause = this.#firstCause;
    return cause ? `; firstCause=${cause.phase}/${cause.reason}` +
      (cause.native_code === undefined ? '' : `; native_code=${cause.native_code}`) : '';
  }

  constructor(profile, factory = nativeFactory, { idleMs = 300000, leaseMs = 60000,
    retirementMs = RETIREMENT_TIMEOUT_MS, name, observer = null, wakeSpawn, desktopProbe, log, secretEnv = [],
    secretOptions = {} } = {}) {
    retirementDeadline({ timeoutMs: retirementMs });
    // D11/D28/D30 attachments. None of them gates admission or input.
    const wake = wakeOptions(profile.wake);
    this.wake = wake ? new WakeHold({ ...wake, ...(wakeSpawn ? { spawnImpl: wakeSpawn } : {}), log }) : null;
    // The desktop-state sentinel gates input only on a known blocking state.
    const desktop = desktopStateOptions(profile);
    this.desktop = desktop ? new DesktopSentinel({ ...desktop, ...(desktopProbe ? { probe: desktopProbe } : {}), log }) : null;
    this.name = name;
    this.observer = observer;
    this.profile = profile;
    this.factory = factory;
    this.idleMs = idleMs;
    this.tail = Promise.resolve();
    this.waiting = 0;
    this.executor = null;
    this.closed = false;
    this.leaseMs = leaseMs;
    this.retirementMs = retirementMs;
    this.owner = null;
    this.controllers = new Set();
    // D16: names of env-provider variables, removed from child environments,
    // and resolver overrides for owned tests.
    this.secretEnv = secretEnv;
    this.secretOptions = secretOptions;
  }
  // D7: a running executor declares its route (the Host attests its own
  // indicator); before startup the configured profile decides.
  get presentation() {
    const declared = this.executor?.presentation;
    if (declared) return presentationLabels(declared);
    return this.profile.hostHelper ? presentationLabels({ route: 'host' }) : RAW_PRESENTATION;
  }
  acquire(owner) {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.closed || this.releasing || (this.owner && this.owner !== owner)) {
      throw new Error('Target is controlled by another session or is releasing');
    }
    if (this.idleRetirement) throw idleRetiringRefusal();
    // A confirmed release permits a new owner, not reuse of a quarantined cause.
    if (this.owner === null) this.#firstCause = undefined;
    this.owner = owner;
    this.wake?.ensure();
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => { void this.release(owner).catch(() => {}); }, this.leaseMs);
    this.leaseTimer.unref();
  }
  release(owner, { signal, timeoutMs = TOOL_TIMEOUT_MS } = {}) {
    if (!validDeadline(timeoutMs) || timeoutMs > TOOL_TIMEOUT_MS) return Promise.reject(invalidDeadline());
    if (this.owner !== owner) return Promise.resolve();
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    const deadline = performance.now() + timeoutMs;
    this.releaseDeadline = Math.min(this.releaseDeadline ?? Infinity, deadline);
    if (!this.releasePromise) {
      this.releasing = true;
      void this.wake?.stop('lease_end');
      clearTimeout(this.idleTimer);
      clearTimeout(this.leaseTimer);
      for (const controller of this.controllers) controller.abort(new Error('Target control released'));
      const controller = new AbortController();
      this.releaseController = controller;
      let abort;
      const interrupted = new Promise((_, reject) => {
        abort = () => reject(this.recordCleanupFailure());
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      const cleanup = this.tail.then(async () => {
        if (controller.signal.aborted) throw this.recordCleanupFailure();
        await this.dropExecutor({ signal: controller.signal, deadline: this.releaseDeadline });
        if (this.cleanupFailure || controller.signal.aborted || performance.now() >= this.releaseDeadline) {
          throw this.recordCleanupFailure();
        }
        this.owner = null;
        this.releasing = false;
        this.releasePromise = null;
        this.releaseController = null;
        this.releaseDeadline = undefined;
      });
      this.releasePromise = Promise.race([cleanup, interrupted])
        .catch(() => {
          const failure = this.recordCleanupFailure();
          controller.abort(failure);
          throw failure;
        })
        .finally(() => controller.signal.removeEventListener('abort', abort));
      // Failed cleanup keeps the target blocked, even if the owned child exits later.
      this.tail = this.releasePromise.catch(() => {});
    }
    // Each RPC retains its own budget even when retirement has already started.
    let timer;
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => {
        const failure = this.recordCleanupFailure();
        this.releaseController?.abort(signal?.reason || new Error('Target release deadline exceeded'));
        reject(failure);
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
      if (signal?.aborted) abort();
    });
    return Promise.race([this.releasePromise, interrupted]).then(() => {
      if (signal?.aborted || performance.now() >= deadline) {
        const failure = this.recordCleanupFailure();
        this.releaseController?.abort(failure);
        throw failure;
      }
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  }
  recordCleanupFailure(deadline = Math.min(this.closeDeadline ?? Infinity,
    this.releaseDeadline ?? Infinity, this.executorRetirementDeadline ?? Infinity),
    signal = this.closeController?.signal || this.releaseController?.signal) {
    const observed = hostHelperFailureCause(this.executor?.failed);
    if (observed) this.#firstCause ??= observed;
    this.cleanupFailure ||= new Error('Target input release is unconfirmed; reconcile the target before restarting its broker');
    this.cleanupFailure.message = 'Target input release is unconfirmed; reconcile the target before restarting its broker' + this.firstCauseText();
    this.cleanupFailure.code = 'release_unconfirmed';
    const executor = this.executor;
    const first = executor && this.forcedExecutor !== executor;
    if (executor && (first || deadline < this.forcedDeadline ||
        (signal && signal !== this.forcedSignal && !this.forcedSignal?.aborted))) {
      this.forcedExecutor = executor;
      this.forcedDeadline = first ? deadline : Math.min(this.forcedDeadline, deadline);
      if (first || (signal && !this.forcedSignal?.aborted)) this.forcedSignal = signal;
      // This is our recorded executor. Start its termination without allowing
      // an unconfirmed close to delay the caller or reopen target admission.
      const options = { graceful: false,
        ...(Number.isFinite(this.forcedDeadline) ? { deadline: this.forcedDeadline } : {}),
        ...(this.forcedSignal ? { signal: this.forcedSignal } : {}) };
      const closing = Promise.resolve().then(() => executor.close(options));
      closing.catch(() => {});
      // Narrow the executor's existing retirement without replacing the
      // original owned closure tracking or treating a timeout as an exit.
      if (first) this.forcedClose = closing;
      else this.forcedCloseUpdate = closing;
    }
    return this.cleanupFailure;
  }
  /** #159: clear a latched release in place, without restarting the broker,
   * only when the recorded executor proves its own release. A Host-only
   * executor can (see HostHelperExecutor.reconcileRelease). TIN-5385: so can
   * a VNC executor with Host capture whose VNC input was settled when it
   * failed (releaseProvable). A raw VNC lane, unsettled input, a startup
   * failure or a lane with queued work stays latched. Returns a bounded
   * receipt; the first cause is reported, never cleared silently. */
  async reconcile({ signal, timeoutMs = 10000 } = {}) {
    if (!validDeadline(timeoutMs) || timeoutMs > TOOL_TIMEOUT_MS) throw invalidDeadline();
    const refuse = (message, code) => Object.assign(new Error(message), { code });
    if (!this.cleanupFailure) return { reconciled: false, latched: false };
    if (this.closed || this.reconciling || this.waiting || this.startup) {
      throw refuse('Target is closing or busy; reconcile refused', 'reconcile_refused');
    }
    const executor = this.executor ?? this.forcedExecutor;
    if (!(executor?.hostOnly || executor?.releaseProvable === true) ||
        typeof executor.reconcileRelease !== 'function') {
      throw refuse('This target cannot prove its release in place; reconcile the target, then restart its broker',
        'reconcile_unsupported');
    }
    const cause = this.firstCause;
    this.reconciling = true;
    try {
      const host = await executor.reconcileRelease({ signal, timeoutMs });
      // Only a latch that is still the one this proof answered is cleared.
      if (this.closed || this.waiting || (this.executor ?? this.forcedExecutor) !== executor) {
        throw refuse('Target changed during reconcile; reconcile refused', 'reconcile_refused');
      }
      clearTimeout(this.leaseTimer);
      this.cleanupFailure = undefined;
      this.executor = null;
      this.forcedExecutor = this.forcedClose = this.forcedCloseUpdate = undefined;
      this.forcedDeadline = this.forcedSignal = undefined;
      this.executorRetirementDeadline = undefined;
      this.owner = null;
      this.releasing = false;
      this.releasePromise = null;
      this.releaseController = null;
      this.releaseDeadline = undefined;
      this.tail = Promise.resolve();
      // TIN-5385: a VNC executor also reports what its native proof covered.
      const native = executor.hostOnly ? undefined : executor.nativeReleaseProof;
      return { reconciled: true, latched: false, ...(cause ? { first_cause: { ...cause } } : {}), host,
        ...(native ? { native: { ...native } } : {}) };
    } finally { this.reconciling = false; }
  }
  async dropExecutor({ signal, deadline = performance.now() + this.retirementMs, operationDeadline } = {}) {
    if (this.cleanupFailure) throw this.cleanupFailure;
    const executor = this.executor;
    if (!executor) return;
    this.executorRetirementDeadline = Math.min(deadline, this.closeDeadline ?? Infinity,
      this.releaseDeadline ?? Infinity);
    const controller = new AbortController();
    let timer;
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => {
        const failure = this.recordCleanupFailure(this.executorRetirementDeadline, controller.signal);
        controller.abort(failure);
        reject(failure);
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, Math.max(0, this.executorRetirementDeadline - performance.now()));
      if (signal?.aborted) abort();
    });
    const check = () => {
      if (this.cleanupFailure || controller.signal.aborted ||
          performance.now() >= this.executorRetirementDeadline ||
          (this.releaseDeadline !== undefined && performance.now() >= this.releaseDeadline)) {
        throw new Error('Target release interrupted');
      }
    };
    try {
      await Promise.race([(async () => {
        check();
        const now = performance.now();
        // Preserve an operation's remaining release budget while it is valid.
        // After cancellation/expiry, safety cleanup still has its finite grace.
        const remaining = Math.min(this.executorRetirementDeadline - now,
          this.releaseDeadline === undefined ? Infinity : this.releaseDeadline - now,
          operationDeadline > now ? operationDeadline - now : Infinity);
        if (remaining <= 0) throw new Error('Target release interrupted');
        await executor.release?.({ signal: controller.signal,
          ...(Number.isFinite(remaining) ? { timeoutMs: remaining } : {}) });
        check();
        this.executorClosing = Promise.resolve().then(() => executor.close({ signal: controller.signal,
          deadline: this.executorRetirementDeadline }));
        this.executorClosing.catch(() => {});
        await this.executorClosing;
        check();
        this.executor = null;
        this.executorRetirementDeadline = undefined;
      })(), interrupted]);
    } catch {
      const failure = this.recordCleanupFailure(this.executorRetirementDeadline, controller.signal);
      controller.abort(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async startExecutor(signal, deadline, cleanup) {
    const startup = { handles: new Set(), closes: [], retiring: false };
    this.startup = startup;
    const close = executor => {
      const closing = Promise.resolve().then(() => executor.close({ graceful: false,
        ...(Number.isFinite(startup.retirementDeadline) ? { deadline: startup.retirementDeadline } : {}),
        ...(this.closeController ? { signal: this.closeController.signal } : {}) }));
      closing.catch(() => {});
      startup.closes.push(closing);
    };
    const onExecutor = executor => {
      if (!executor || startup.handles.has(executor)) return;
      startup.handles.add(executor);
      if (startup.retiring) close(executor);
    };
    const factory = Promise.resolve().then(() => this.factory(this.profile,
      { signal, deadline, onExecutor, secretEnv: this.secretEnv }));
    // Track even a factory that ignores cancellation. Its late result is owned
    // cleanup, never permission to send the expired request.
    const settled = factory.then(executor => { onExecutor(executor); }, error => {
      if (error?.startupCleanupUnconfirmed) startup.failure = error;
    });
    let abort;
    try {
      const executor = await Promise.race([factory, new Promise((_, reject) => {
        abort = () => reject(signal.reason || new Error('Operation cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
      if (signal.aborted || performance.now() >= deadline) throw signal.reason || new Error('Operation deadline exceeded');
      this.executor = executor;
      this.startup = null;
    } catch (error) {
      startup.retiring = true;
      const retirementDeadline = cleanup
        ? Math.min(cleanup.deadline, performance.now() + cleanup.timeoutMs,
          this.releaseDeadline ?? Infinity, this.closeDeadline ?? Infinity)
        : Math.min(performance.now() + STARTUP_CLEANUP_MS, this.closeDeadline ?? Infinity);
      startup.retirementDeadline = retirementDeadline;
      for (const executor of startup.handles) close(executor);
      let timer;
      try {
        await Promise.race([(async () => {
          await settled;
          await Promise.all(startup.closes);
          if (startup.failure) throw startup.failure;
        })(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Startup owned exit unconfirmed')),
            Math.max(0, retirementDeadline - performance.now()));
        })]);
        if (this.cleanupFailure || performance.now() >= retirementDeadline ||
            (this.releaseDeadline !== undefined && performance.now() >= this.releaseDeadline)) {
          throw new Error('Startup owned exit unconfirmed');
        }
        this.startup = null;
      } catch {
        this.cleanupFailure = new Error('Target startup cleanup is unconfirmed; reconcile the target before restarting its broker');
        this.cleanupFailure.code = 'release_unconfirmed';
        throw this.cleanupFailure;
      } finally { clearTimeout(timer); }
      throw error;
    } finally { signal.removeEventListener('abort', abort); }
  }
  // D11/D30 hook point: the watch observes the serialized batch below. Journal
  // and telemetry writes are queued and cannot fail or alter the result.
  execute(actions, options = {}) {
    // A deadline the caller named must be one: a negative or non-numeric
    // timeoutMs is refused typed, never read as an early provider timeout.
    if (options.timeoutMs !== undefined && !validDeadline(options.timeoutMs)) {
      const error = invalidDeadline();
      this.observer?.batch(this, actions)?.failed(error);
      return Promise.reject(error);
    }
    // D16: a batch with type_secret is checked against this target's
    // allowlist now; each ref is resolved later, inside the lane task.
    let plan;
    try { plan = planSecretBatch(this.profile, actions); }
    catch (error) {
      this.observer?.batch(this, actions)?.failed(error);
      return Promise.reject(error);
    }
    const reads = new Set(Array.isArray(actions)
      ? actions.flatMap((action, index) => action?.action === 'clipboard_read' ? [index] : []) : []);
    // A disabled read is refused before any allowlisted secret is resolved.
    if (reads.size && this.profile.clipboard?.read !== true) {
      const error = clipboardReadRefusal();
      this.observer?.batch(this, plan ? plan.journalled : actions)?.failed(error);
      return Promise.reject(error);
    }
    if (!plan && !reads.size) return this.observedBatch(actions, actions, options);
    // The batch joins the lane queue now, so arrival order is queue order
    // and the idle timer cannot retire the lane under a slow provider. Its
    // refs resolve only after every pre-admission refusal (desktop state,
    // native capabilities, route, Stop latch) has passed. The journal sees
    // {ref, provider, length_class}; only the executor's native action
    // carries a value, and every type_secret response is replaced by a
    // fixed-shape result before it reaches a client.
    const childEnv = () => scrubbedEnvironment(process.env, this.secretEnv);
    const prepare = async ({ signal, timeoutMs }) => {
      const started = performance.now();
      const left = () => Math.max(1, timeoutMs - (performance.now() - started));
      let transform;
      if (reads.size) {
        // D8/D16: the read is withheld whole when its text contains an
        // allowlisted value, then capped to clipboard.maxBytes. A provider
        // failure refuses it: an unchecked clipboard never leaves.
        const secrets = await resolveAllowlistedSecrets(this.profile,
          { signal, timeoutMs: left(), childEnv: childEnv(), ...this.secretOptions });
        const maxBytes = this.profile.clipboard?.maxBytes ?? CLIPBOARD_MAX_BYTES.default;
        transform = (response, index) => reads.has(index)
          ? boundClipboardResponse(response, { maxBytes, secrets }) : response;
      }
      if (!plan) return { actions, journalled: actions, transform };
      const values = await resolveSecretBatch(plan,
        { signal, timeoutMs: left(), childEnv: childEnv(), ...this.secretOptions });
      return { actions: plan.native(values), journalled: plan.journal(values), transform };
    };
    // Preflight sees each type_secret in its native shape without a value.
    const preview = plan ? plan.native(new Map([...plan.indexes].map(index => [index, '']))) : actions;
    return this.observedBatch(plan ? plan.journalled : actions, preview,
      { ...options, prepare, ...(plan ? { secretIndexes: plan.indexes } : {}) });
  }
  observedBatch(journalled, actions, { onResponse, secretIndexes, transform, prepare, ...options } = {}) {
    const watch = this.observer?.batch(this, journalled);
    const prepared = prepare && (async budget => {
      const ready = await prepare(budget);
      watch?.describe(ready.journalled);
      transform = ready.transform;
      return ready.actions;
    });
    const clean = (response, index) => {
      const shaped = transform ? transform(response, index) : response;
      return secretIndexes?.has(index) ? secretResponse(shaped) : shaped;
    };
    const cleanAll = responses => Array.isArray(responses) ? responses.map(clean) : responses;
    let progressed = 0;
    // Observation never waits for the sentinel: a screenshot carries the
    // cached sample while it is fresh (else unknown, `stale`) and starts the
    // next one. Health waits briefly for that probe, within its own deadline.
    const observes = observesDesktop(journalled);
    if (observes) void this.desktop?.refresh();
    const budget = Math.min(TOOL_TIMEOUT_MS, options.timeoutMs ?? TOOL_TIMEOUT_MS);
    const replyBy = performance.now() + (Number.isFinite(budget) && budget > 0 ? executionBudget(budget).workMs : 0);
    return this.executeBatch(actions, { ...options, prepare: prepared, onAdmitted: () => watch?.admitted(),
      onResponse: response => {
        const visible = clean(response, progressed++);
        watch?.progress(visible); onResponse?.(visible);
      } })
      .then(async responses => {
        const visible = cleanAll(responses);
        watch?.done(visible);
        const withWake = withWakeHealth(journalled, visible, this.wake);
        if (!observes) return withWake;
        const state = !this.desktop ? DESKTOP_STATE_NOT_CONFIGURED
          : journalled.some(action => action.action === 'health')
            ? await this.desktop.read({ timeoutMs: Math.min(HEALTH_STATE_WAIT_MS, replyBy - performance.now()) })
            : this.desktop.current();
        return withDesktopState(journalled, withWake, state);
      }, error => {
        if ((secretIndexes || transform) && Array.isArray(error?.responses)) error.responses = cleanAll(error.responses);
        // Typed before observation: `watch?.` would skip its argument when
        // the journal and telemetry are both off.
        const failure = typedFailure(error);
        watch?.failed(failure);
        throw failure;
      });
  }
  executeBatch(actions, { signal, timeoutMs = TOOL_TIMEOUT_MS, onResponse, onAdmitted, prepare } = {}) {
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    if (this.closed) return Promise.reject(new Error('Target lane closed'));
    if (this.releasing) return Promise.reject(new Error('Target is releasing control'));
    // Idle retirement keeps the owner; nothing was admitted, so say so.
    if (this.idleRetirement) return Promise.reject(idleRetiringRefusal());
    if (this.waiting >= MAX_WAITING) return Promise.reject(new Error('Target queue full'));
    if (!Array.isArray(actions) || !actions.length || actions.length > MAX_ACTIONS ||
        actions.some(action => !action || typeof action !== 'object' || Array.isArray(action) ||
          typeof action.action !== 'string')) return Promise.reject(new Error('Invalid action batch'));
    // A raw-route profile refuses Host-only actions before queueing or
    // starting its VNC executor; nothing is admitted or retired.
    const hostOnly = !this.profile.hostHelper && actions.find(action => HOST_ROUTE_ACTIONS.includes(action.action));
    if (hostOnly) return Promise.reject(routeRefusal(hostOnly.action));
    if (!validDeadline(timeoutMs)) return Promise.reject(invalidDeadline());
    const budget = Math.min(TOOL_TIMEOUT_MS, timeoutMs);
    const { workMs, cleanupMs } = executionBudget(budget);
    const requestedAt = performance.now();
    const deadline = requestedAt + workMs;
    const totalDeadline = requestedAt + budget;
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort(signal.reason || new Error('Operation cancelled'));
    if (signal?.aborted) { this.controllers.delete(controller); return Promise.reject(signal.reason || new Error('Operation cancelled')); }
    signal?.addEventListener('abort', abort, { once: true });
    let started = false;
    let abortQueued;
    const queuedInterruption = new Promise((_, reject) => {
      abortQueued = () => { if (!started) reject(controller.signal.reason); };
      controller.signal.addEventListener('abort', abortQueued, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new Error('Operation deadline exceeded')), workMs);
    clearTimeout(this.idleTimer);
    this.waiting++;
    const progressBudget = new ResponseBudget({ maxResponses: actions.length });
    let preAdmissionError;
    const task = this.tail.then(async () => {
      started = true;
      const retire = () => {
        this.releasing = true;
        return this.dropExecutor({ signal: this.releaseController?.signal,
          deadline: Math.min(totalDeadline, performance.now() + cleanupMs, this.releaseDeadline ?? Infinity),
          operationDeadline: deadline });
      };
      if (performance.now() >= deadline) controller.abort(new Error('Operation deadline exceeded'));
      if (controller.signal.aborted || this.closed) throw controller.signal.reason || new Error('Target lane closed');
      // Before connecting or sending anything, refuse input that macOS would
      // block or misroute: lock screen, asleep display, a consent dialog
      // (D16: type_secret is input and is never typed into one). The refusal
      // is pre-admission, so the lease and executor are kept. The probe gets
      // at most half of what is left: a slow one reads as unknown and must
      // not run the batch into its deadline, which would retire the lane.
      if (this.desktop && actions.some(action => INPUT_ACTIONS.has(action.action))) {
        const state = await this.desktop.read({ signal: controller.signal,
          timeoutMs: Math.min(this.desktop.timeoutMs, (deadline - performance.now()) / 2) });
        const refused = desktopRefusal(state);
        if (refused) { preAdmissionError = refused; throw refused; }
      }
      if (!this.executor) await this.startExecutor(controller.signal, deadline,
        { deadline: totalDeadline, timeoutMs: cleanupMs });
      if (controller.signal.aborted) {
        await retire();
        throw controller.signal.reason;
      }
      let acceptingProgress = true;
      let abortExecution;
      onAdmitted?.();
      const interrupted = new Promise((_, reject) => {
        abortExecution = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortExecution, { once: true });
        if (controller.signal.aborted) abortExecution();
      });
      // An abort during an awaited provider rejects this before the race
      // below observes it; unobserved, that rejection would end the broker.
      interrupted.catch(() => {});
      try {
        try {
          this.executor.preflight?.(actions);
          // D16/D8: providers run only now, after every refusal above.
          if (prepare) {
            actions = await prepare({ signal: controller.signal, timeoutMs: deadline - performance.now() });
            // D16: a slow provider must not age the sentinel's answer. The
            // ~2 s cache answers a fast one; a slow one probes again, so a
            // dialog that appeared meanwhile is refused before any key.
            if (this.desktop && actions.some(action => INPUT_ACTIONS.has(action.action))) {
              const state = await this.desktop.read({ signal: controller.signal,
                timeoutMs: Math.min(this.desktop.timeoutMs, (deadline - performance.now()) / 2) });
              const refused = desktopRefusal(state);
              if (refused) { preAdmissionError = refused; throw refused; }
            }
          }
        } catch (error) {
          if (isPreAdmissionRefusal(error)) preAdmissionError = error;
          throw error;
        }
        const responses = await Promise.race([Promise.resolve().then(() => {
          if (controller.signal.aborted || performance.now() >= deadline) {
            throw controller.signal.reason || new Error('Operation deadline exceeded');
          }
          return this.executor.execute(actions, { signal: controller.signal,
            onResponse: response => {
              if (!acceptingProgress || controller.signal.aborted || performance.now() >= deadline) return;
              progressBudget.add(response); onResponse?.(response);
            },
            timeoutMs: deadline - performance.now() });
        }), interrupted]);
        if (controller.signal.aborted || performance.now() >= deadline) {
          throw controller.signal.reason || new Error('Operation deadline exceeded');
        }
        if (!Array.isArray(responses)) throw new Error('Invalid executor response batch');
        const finalBudget = new ResponseBudget({ maxResponses: actions.length });
        for (const response of responses) finalBudget.add(response);
        return responses;
      } catch (error) {
        acceptingProgress = false;
        if (preAdmissionError && error === preAdmissionError) throw error;
        // Snapshot the initiating cause before retirement can replace its Error.
        // Quarantine and cleanup still run independently and retain their status.
        this.rememberFirstCause(error);
        // Uncertain native execution is never replayed or handed to another owner.
        try { await retire(); }
        catch (retirementError) {
          const diagnostic = hostHelperRefusalMessage(error);
          if (diagnostic && retirementError?.code === 'release_unconfirmed') {
            // Retain the sticky cleanup failure and revoked lane. Only this
            // request gains the already sanitized cause, never raw executor text.
            const failure = new Error(`${retirementError.message}; cause=${diagnostic}`);
            failure.code = 'release_unconfirmed';
            throw failure;
          }
          throw retirementError;
        }
        throw error;
      } finally {
        acceptingProgress = false;
        controller.signal.removeEventListener('abort', abortExecution);
      }
    }).catch(error => {
      // Only this task's local preflight can prove zero admitted work. Errors
      // raised by execute, including forged codes, retain safety retirement.
      if (preAdmissionError && error === preAdmissionError) throw error;
      // Revoke before resolving the queue tail: already queued input cannot
      // race the caller's later error handling and enter an uncertain session.
      this.releasing = true;
      for (const queued of this.controllers) queued.abort(new Error('Target control revoked after operation failure'));
      throw error;
    });
    this.tail = task.catch(() => {});
    const settled = task.finally(() => {
      this.controllers.delete(controller);
      this.waiting--;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!this.waiting && !this.closed && !this.cleanupFailure && !this.releasing) {
        this.idleTimer = setTimeout(() => {
          if (this.waiting || this.closed || this.releasing || this.cleanupFailure) return;
          const deadline = performance.now() + this.retirementMs;
          this.idleDeadline = deadline;
          // Block acquisition and direct execution before the asynchronous
          // release starts. A successful idle close retains the current owner.
          const retirement = this.tail.then(() => this.dropExecutor({ deadline }));
          this.idleRetirement = retirement;
          this.tail = retirement.catch(() => {}).finally(() => {
            if (this.idleRetirement === retirement) {
              this.idleRetirement = null;
              this.idleDeadline = undefined;
            }
          });
        }, this.idleMs);
        this.idleTimer.unref();
      }
    });
    // A queued caller can expire before the prior task retires. Keep that task
    // in the serial tail and capacity count, but return its cancellation now;
    // it will see the aborted signal before starting any factory or input.
    return Promise.race([settled, queuedInterruption]).finally(() => {
      controller.signal.removeEventListener('abort', abortQueued);
    });
  }
  close({ signal, timeoutMs = this.retirementMs, deadline } = {}) {
    let cutoff;
    try { cutoff = retirementDeadline({ timeoutMs, deadline }); }
    catch (error) { return Promise.reject(error); }
    this.closeDeadline = Math.min(this.closeDeadline ?? Infinity, cutoff,
      this.idleDeadline ?? Infinity, this.executorRetirementDeadline ?? Infinity,
      this.releaseDeadline ?? Infinity);
    if (!this.closePromise) {
      this.closed = true;
      void this.wake?.stop('shutdown');
      clearTimeout(this.idleTimer);
      clearTimeout(this.leaseTimer);
      for (const active of this.controllers) active.abort(new Error('Target lane closed'));
      const controller = this.closeController = new AbortController();
      const listeners = [];
      let timer;
      const interrupted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(this.recordCleanupFailure()), { once: true });
      });
      this.armClose = () => {
        clearTimeout(timer);
        if (controller.signal.aborted) return;
        const remaining = this.closeDeadline - performance.now();
        if (remaining <= 0) controller.abort(this.recordCleanupFailure());
        else timer = setTimeout(() => controller.abort(this.recordCleanupFailure()), remaining);
      };
      this.observeCloseSignal = observed => {
        if (!observed) return;
        const abort = () => controller.abort(this.recordCleanupFailure());
        listeners.push([observed, abort]);
        observed.addEventListener('abort', abort, { once: true });
        if (observed.aborted) abort();
      };
      const check = () => {
        if (this.cleanupFailure || controller.signal.aborted || performance.now() >= this.closeDeadline) {
          throw this.recordCleanupFailure();
        }
      };
      const cleanup = this.tail.then(async () => {
        check();
        await this.dropExecutor({ signal: controller.signal, deadline: this.closeDeadline });
        check();
      });
      this.closePromise = Promise.race([cleanup, interrupted]).catch(() => {
        const failure = this.recordCleanupFailure();
        controller.abort(failure);
        throw failure;
      }).finally(() => {
        clearTimeout(timer);
        for (const [observed, abort] of listeners) observed.removeEventListener('abort', abort);
        this.armClose = null;
        this.observeCloseSignal = null;
      });
      this.closePromise.catch(() => {});
    }
    this.observeCloseSignal?.(signal);
    this.armClose?.();
    if (this.cleanupFailure) this.recordCleanupFailure();
    return this.closePromise;
  }
}

export async function createBroker({ socketPath, config, factory, idleMs, leaseMs, retirementMs,
  journal = null, telemetry = null, wakeSpawn, desktopProbe, log = () => {}, secretOptions = {} }) {
  // Names are discovery aliases, not independent permission to control the
  // same desktop. Reject known overlaps before opening a public socket.
  const identities = new Map();
  for (const [name, profile] of Object.entries(config.targets)) {
    const keys = [];
    if (profile.vnc) {
      let host = String(profile.vnc.host).toLowerCase().replace(/^\[|\]$/g, '');
      if (['localhost', '127.0.0.1', '::1'].includes(host)) host = 'loopback';
      keys.push(`vnc:${host}:${profile.vnc.port}`);
    }
    if (profile.hostHelper) keys.push(`helper:${String(profile.hostHelper.sshHost).toLowerCase()}`);
    if (profile.targetId !== undefined) {
      if (typeof profile.targetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(profile.targetId)) {
        throw new Error('Invalid physical target identity');
      }
      keys.push(`target:${profile.targetId}`);
    }
    for (const key of keys) {
      if (identities.has(key)) throw new Error('Duplicate target endpoint or physical identity; use one profile per desktop');
      identities.set(key, name);
    }
  }
  // Profile attachments (wake, desktopState) validate before the socket path is touched.
  for (const profile of Object.values(config.targets)) { wakeOptions(profile.wake); desktopStateOptions(profile); }
  const observer = journal || telemetry ? new ActionObserver({ journal, telemetry }) : null;
  const secretEnv = [...envProviderNames(config)];
  await prepareSocket(socketPath);
  const lanes = new Map(Object.entries(config.targets).map(([name, profile]) =>
    [name, new TargetLane(profile, factory, { idleMs, leaseMs, retirementMs, name, observer, wakeSpawn,
      desktopProbe, log, secretEnv, secretOptions })]));
  const sockets = new Set();
  const active = new Set();
  let closing = false;
  let closePromise;
  let closeDeadline, closeTimer, closeController, observeCloseSignal;
  const server = net.createServer(socket => {
    if (closing || sockets.size >= 128) return socket.destroy();
    sockets.add(socket);
    const clientId = randomUUID();
    const pending = new Map();
    let lane;
    const reply = frame => {
      try { writeFrame(socket, { v: 1, ...frame }); } catch { socket.destroy(); }
    };
    readFrames(socket, frame => {
      if (frame.v !== 1) return socket.destroy();
      if (frame.kind === 'open') {
        if (lane || !lanes.has(frame.profile)) return reply({ kind: 'error', error: { message: 'Unknown or already opened profile' } });
        lane = lanes.get(frame.profile);
        return reply({ kind: 'opened', clientId, presentation: lane.presentation });
      }
      if (frame.kind === 'cancel') { pending.get(frame.id)?.abort(new Error('Operation cancelled')); return; }
      if (frame.kind === 'close') {
        for (const controller of pending.values()) controller.abort(new Error('Client closed'));
        void lane?.release(clientId).catch(() => {});
        socket.end();
        return false;
      }
      if (frame.kind === 'release' && lane && typeof frame.id === 'string' && frame.id.length <= 128) {
        if (pending.has(frame.id)) return reply({ kind: 'error', id: frame.id, error: { message: 'Invalid broker request' } });
        if (pending.size >= MAX_WAITING) return reply({ kind: 'error', id: frame.id, error: { message: 'Client queue full' } });
        const controller = new AbortController();
        pending.set(frame.id, controller);
        active.add(controller);
        lane.release(clientId, { signal: controller.signal, timeoutMs: frame.timeoutMs })
          .then(() => reply({ kind: 'result', id: frame.id, responses: [], presentation: lane.presentation }))
          .catch(error => reply({ kind: 'error', id: frame.id, error: errorRecord(error), presentation: lane.presentation }))
          .finally(() => { pending.delete(frame.id); active.delete(controller); });
        return;
      }
      if (frame.kind === 'reconcile' && lane && typeof frame.id === 'string' && frame.id.length <= 128) {
        if (pending.has(frame.id)) return reply({ kind: 'error', id: frame.id, error: { message: 'Invalid broker request' } });
        if (pending.size >= MAX_WAITING) return reply({ kind: 'error', id: frame.id, error: { message: 'Client queue full' } });
        const controller = new AbortController();
        pending.set(frame.id, controller);
        active.add(controller);
        lane.reconcile({ signal: controller.signal, ...(frame.timeoutMs === undefined ? {} : { timeoutMs: frame.timeoutMs }) })
          .then(receipt => reply({ kind: 'result', id: frame.id, presentation: lane.presentation,
            responses: [{ id: frame.id, result: { detail: receipt.reconciled ? 'Target release reconciled'
              : 'Target release was not latched', reconcile: receipt } }] }))
          .catch(error => reply({ kind: 'error', id: frame.id, error: errorRecord(error), presentation: lane.presentation }))
          .finally(() => { pending.delete(frame.id); active.delete(controller); });
        return;
      }
      if (frame.kind !== 'execute' || !lane || typeof frame.id !== 'string' || frame.id.length > 128 || pending.has(frame.id)) {
        return reply({ kind: 'error', id: frame.id, error: { message: 'Invalid broker request' } });
      }
      if (pending.size >= MAX_WAITING) return reply({ kind: 'error', id: frame.id, error: { message: 'Client queue full' } });
      try { lane.acquire(clientId); }
      catch (error) { return reply({ kind: 'error', id: frame.id, error: errorRecord(error) }); }
      const controller = new AbortController();
      pending.set(frame.id, controller);
      active.add(controller);
      lane.execute(frame.actions, { signal: controller.signal, timeoutMs: frame.timeoutMs,
        onResponse: response => {
          const progress = responseMetadata(response);
          reply({ kind: 'progress', id: frame.id, response: progress, presentation: lane.presentation });
        } })
        .then(responses => reply({ kind: 'result', id: frame.id, responses, presentation: lane.presentation }))
        .catch(error => {
          reply({ kind: 'error', id: frame.id, error: errorRecord(error), responses: boundedErrorResponses(error.responses, frame.actions?.length), presentation: lane.presentation });
          // A proven local refusal retains this owner's healthy lease. An
          // admitted failure has already marked releasing, even if its Error
          // copied or reused a locally branded refusal.
          if (isPreAdmissionRefusal(error) && !lane.releasing && !lane.cleanupFailure) return;
          // A queued RPC can expire while earlier input is still active. Its
          // canceled task stays serialized; do not release that earlier input
          // merely to deliver the queued caller's finite error response.
          void lane.tail.then(() => lane.release(clientId)).catch(() => {});
        })
        .finally(() => { pending.delete(frame.id); active.delete(controller); });
    }, () => socket.destroy(), MAX_REQUEST_BYTES);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      for (const controller of pending.values()) controller.abort(new Error('Client disconnected'));
      sockets.delete(socket);
      void lane?.release(clientId).catch(() => {});
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  return { server, lanes, status() {
    return { ...observer?.status(), targets: Object.fromEntries([...lanes].map(([name, lane]) =>
      [name, { owned: Boolean(lane.owner), ...(lane.wake ? { wake: lane.wake.status() } : {}),
        ...(lane.desktop ? { desktop_state: lane.desktop.status() } : {}) }])) };
  }, close({ signal, timeoutMs = retirementMs ?? RETIREMENT_TIMEOUT_MS, deadline } = {}) {
    let cutoff;
    try { cutoff = retirementDeadline({ timeoutMs, deadline }); }
    catch (error) { return Promise.reject(error); }
    closeDeadline = Math.min(closeDeadline ?? Infinity, cutoff);
    if (!closePromise) {
      closing = true;
      closeController = new AbortController();
      const listeners = [];
      const failure = Object.assign(new Error('Broker owned shutdown is unconfirmed'), { code: 'release_unconfirmed' });
      const interrupted = new Promise((_, reject) => {
        closeController.signal.addEventListener('abort', () => reject(failure), { once: true });
      });
      observeCloseSignal = observed => {
        if (!observed) return;
        const abort = () => closeController.abort(failure);
        listeners.push([observed, abort]);
        observed.addEventListener('abort', abort, { once: true });
        if (observed.aborted) abort();
      };
      // Stop admission before awaiting owned executor cleanup. A connection
      // already queued for acceptance is refused by the closing flag above.
      const listenerClosed = new Promise(resolve => server.close(resolve));
      for (const controller of active) controller.abort(new Error('Broker shutting down'));
      for (const socket of sockets) socket.destroy();
      const cleanup = (async () => {
        const results = await Promise.allSettled([...lanes.values()].map(lane =>
          lane.close({ signal: closeController.signal, timeoutMs, deadline: closeDeadline })));
        await listenerClosed;
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        if (closeController.signal.aborted || performance.now() >= closeDeadline) throw failure;
      })();
      closePromise = Promise.race([cleanup, interrupted]).finally(() => {
        clearTimeout(closeTimer);
        for (const [observed, abort] of listeners) observed.removeEventListener('abort', abort);
        observeCloseSignal = null;
      });
      closePromise.catch(() => {});
    } else {
      // Every shorter caller cutoff reaches the already-retiring lanes, even
      // when their serial tails are stalled and dropExecutor has not begun.
      for (const lane of lanes.values()) {
        lane.close({ signal: closeController.signal, timeoutMs, deadline: closeDeadline }).catch(() => {});
      }
    }
    observeCloseSignal?.(signal);
    if (observeCloseSignal) {
      clearTimeout(closeTimer);
      const remaining = closeDeadline - performance.now();
      if (remaining <= 0) closeController.abort(new Error('Broker shutdown deadline exceeded'));
      else closeTimer = setTimeout(() => closeController.abort(new Error('Broker shutdown deadline exceeded')), remaining);
    }
    return closePromise;
  } };
}
