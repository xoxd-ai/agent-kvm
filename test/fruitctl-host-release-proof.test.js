// SPDX-License-Identifier: MIT
// TIN-5385: a VNC lane with Host capture proves its release in place when no
// VNC input it sent may still be held. Mock SSH and a fake VNC client only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TargetLane } from '../lib/broker/server.mjs';
import { createHostHelperExecutor } from '../lib/broker/host-helper.mjs';
import { nativeCapabilities } from '../lib/mcp/capabilities.js';
import { hostBinding, hostSequence } from './host-mock.mjs';

// Matches the mock Host's capture geometry.
const mapping = { qualificationReceipt: 'test-fixture:explicit-geometry-proof', displayId: 42,
  nativeWidth: 512, nativeHeight: 256, scaledWidth: 512, scaledHeight: 256,
  displayBounds: { x: 0, y: 0, width: 256, height: 128 } };
const profile = () => ({ hostHelper: { ...hostBinding(), mapping } });

/** A VNC client whose child exits on close. `hang(action)` leaves that
 * input unanswered. `exits: false` models a client without exit reporting.
 * `exits: 'manual'` reports an exit only when the test calls `exit()`. */
function vncClient({ hang = () => false, exits = true } = {}) {
  let closeChild;
  const client = {
    capabilities: nativeCapabilities(), display: { width: 512, height: 256 }, calls: [], closes: [],
    async inputPermitControl(method, params) {
      const { lease_remaining_ms, ...binding } = params;
      return { id: 'native-permit', result: { ...binding, challenge: params.challenge || randomUUID(),
        native_permit_protocol: 'fruitctl.native-input-permit.v1', input_permit_ms: 1000,
        maximum_round_trip_ms: 500, native_permit_remaining_ms: 1000 } };
    },
    async execute(actions) {
      client.calls.push(...actions.map(action => action.action));
      const [action] = actions;
      if (action.action === 'health') return [{ id: 'native-health', result: { nativeWidth: 512,
        nativeHeight: 256, scaledWidth: 512, scaledHeight: 256, connectionGeneration: 3, allocation: 9 } }];
      if (action.action === 'adopt_observation') {
        const { action: name, ...result } = action;
        return [{ id: 'native-adoption', result }];
      }
      if (hang(action.action)) return new Promise(() => {});
      return actions.map(() => ({ id: 'native-input', result: { detail: 'input acknowledged' } }));
    },
    async close(options) { client.closes.push(options); if (exits !== 'manual') closeChild?.(); },
  };
  if (exits) client.closed = new Promise(resolve => { closeChild = resolve; });
  if (exits === 'manual') client.exit = () => closeChild();
  return client;
}

function laneFor(hosts, clients) {
  return new TargetLane(profile(), async (target, { onExecutor } = {}) => {
    const client = clients.shift();
    const executor = await createHostHelperExecutor({ nativeExecutor: client, hostHelper: target.hostHelper,
      spawnImpl: hosts.spawnImpl });
    onExecutor?.(executor);
    return executor;
  }, { retirementMs: 2000 });
}

test('a Host receipt deadline on an AX call with no VNC input in flight does not latch the lane', async () => {
  const hosts = hostSequence(index => ({ alter(request, response) {
    // The first attachment never answers the press, as when the target's
    // main thread is blocked in a pop-up menu's tracking loop.
    return index === 0 && request.action === 'ax_action' ? null : response;
  } }));
  const clients = [vncClient(), vncClient()];
  const [first] = clients;
  const lane = laneFor(hosts, clients);
  try {
    lane.acquire('first');
    await lane.execute([{ action: 'ax_snapshot' }]);
    await lane.execute([{ action: 'mouse_click', x: 10, y: 10 }]);
    await assert.rejects(lane.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      /Host-helper receipt deadline exceeded/);
    await lane.release('first');
    assert.equal(lane.cleanupFailure, undefined);
    // The proof sent health only, after the VNC child exited.
    assert.ok(first.closes.length >= 1);
    assert.deepEqual(hosts.attachments[1].requests.map(request => request.action), ['health']);
    assert.ok(hosts.attachments.slice(0, 2).every(host => host.child.signalCode !== null));
    lane.acquire('second');
    const [shot] = await lane.execute([{ action: 'screenshot' }]);
    assert.equal(shot.result.scaledWidth, 512);
  } finally { await lane.close().catch(() => {}); }
});

test('a pointer move left unanswered outside a hold scope does not latch the lane', async () => {
  const hosts = hostSequence();
  const clients = [vncClient({ hang: action => action === 'mouse_move' }), vncClient()];
  const lane = laneFor(hosts, clients);
  try {
    lane.acquire('first');
    await assert.rejects(lane.execute([{ action: 'mouse_move', x: 10, y: 10 }], { timeoutMs: 1500 }));
    await lane.release('first');
    assert.equal(lane.cleanupFailure, undefined);
    lane.acquire('second');
    await lane.execute([{ action: 'screenshot' }]);
  } finally { await lane.close().catch(() => {}); }
});

test('an unanswered click stays latched and reconcile refuses it', async () => {
  const hosts = hostSequence();
  const lane = laneFor(hosts, [vncClient({ hang: action => action === 'mouse_click' })]);
  try {
    lane.acquire('first');
    await assert.rejects(lane.execute([{ action: 'mouse_click', x: 10, y: 10 }], { timeoutMs: 1500 }));
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    await assert.rejects(lane.reconcile(), error => error.code === 'reconcile_unsupported');
    assert.ok(lane.cleanupFailure);
    // Only the Host attachment ever ran: nothing probed it.
    assert.equal(hosts.attachments.length, 1);
  } finally { await lane.close().catch(() => {}); }
});

test('a hold scope stays unsettled until its release_holds is confirmed', async () => {
  const hosts = hostSequence();
  const lane = laneFor(hosts, [vncClient({ hang: action => action === 'mouse_move' })]);
  try {
    lane.acquire('first');
    // The move is inside the scope opened by mouse_down, so a button may be down.
    await assert.rejects(lane.execute([{ action: 'mouse_down', x: 10, y: 10 },
      { action: 'mouse_move', x: 20, y: 20 }, { action: 'mouse_up', x: 20, y: 20 }], { timeoutMs: 1500 }));
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    await assert.rejects(lane.reconcile(), error => error.code === 'reconcile_unsupported');
  } finally { await lane.close().catch(() => {}); }
});

test('a settled VNC lane that latched on a busy Host is cleared by reconcile', async () => {
  const hosts = hostSequence(index => ({ alter(request, response) {
    if (index === 0 && request.action === 'ax_action') return null;
    // The first probe sees a lease this broker never held.
    if (index === 1 && request.action === 'health') Object.assign(response.result, { session_id: 'other',
      ready: true, overlay_ready: true, capture_ready: true, lease_remaining_ms: 2000 });
    return response;
  } }));
  const lane = laneFor(hosts, [vncClient(), vncClient()]);
  try {
    lane.acquire('first');
    await lane.execute([{ action: 'ax_snapshot' }]);
    await assert.rejects(lane.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]));
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    assert.throws(() => lane.acquire('second'), /release is unconfirmed/);
    const receipt = await lane.reconcile();
    assert.equal(receipt.reconciled, true);
    assert.equal(receipt.host.lease_remaining_ms, 0);
    assert.deepEqual(receipt.native, { input_settled: true, exit_observed: true, delivery_proven: false });
    assert.deepEqual(receipt.first_cause, { phase: 'host_helper', reason: 'deadline' });
    assert.equal(lane.cleanupFailure, undefined);
    lane.acquire('second');
    await lane.execute([{ action: 'screenshot' }]);
  } finally { await lane.close().catch(() => {}); }
});

test('a VNC client that cannot report its exit keeps the latch and reconcile_unsupported', async () => {
  const hosts = hostSequence(index => ({ alter(request, response) {
    return index === 0 && request.action === 'ax_action' ? null : response;
  } }));
  const lane = laneFor(hosts, [vncClient({ exits: false })]);
  try {
    lane.acquire('first');
    await lane.execute([{ action: 'ax_snapshot' }]);
    await assert.rejects(lane.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]));
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    await assert.rejects(lane.reconcile(), error => error.code === 'reconcile_unsupported');
  } finally { await lane.close().catch(() => {}); }
});

test('a hold batch whose Host capture misses its deadline after mouse_down stays latched', async () => {
  let captures = 0;
  const hosts = hostSequence(index => ({ alter(request, response) {
    // The capture before mouse_move never answers. mouse_down has replied,
    // so a button may be down and no input call is in flight.
    if (index === 0 && request.action === 'capture' && ++captures === 2) return null;
    return response;
  } }));
  const client = vncClient();
  const lane = laneFor(hosts, [client]);
  try {
    lane.acquire('first');
    await assert.rejects(lane.execute([{ action: 'mouse_down', x: 10, y: 10 },
      { action: 'mouse_move', x: 20, y: 20 }, { action: 'mouse_up', x: 20, y: 20 }], { timeoutMs: 1500 }));
    assert.ok(client.calls.includes('mouse_down'));
    assert.ok(!client.calls.includes('mouse_move'));
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    await assert.rejects(lane.reconcile(), error => error.code === 'reconcile_unsupported');
    assert.equal(hosts.attachments.length, 1);
  } finally { await lane.close().catch(() => {}); }
});

test('a hold batch whose release_holds never answers stays latched', async () => {
  const hosts = hostSequence();
  // Every input in the scope replied. Only release_holds settles the scope.
  const lane = laneFor(hosts, [vncClient({ hang: action => action === 'release_holds' })]);
  try {
    lane.acquire('first');
    await assert.rejects(lane.execute([{ action: 'mouse_down', x: 10, y: 10 },
      { action: 'mouse_up', x: 10, y: 10 }], { timeoutMs: 1500 }));
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    await assert.rejects(lane.reconcile(), error => error.code === 'reconcile_unsupported');
    assert.equal(hosts.attachments.length, 1);
  } finally { await lane.close().catch(() => {}); }
});

test('a pointer move inside a hold scope is unsettled even before mouse_down', async () => {
  const hosts = hostSequence();
  const lane = laneFor(hosts, [vncClient({ hang: action => action === 'mouse_move' })]);
  try {
    lane.acquire('first');
    await assert.rejects(lane.execute([{ action: 'mouse_move', x: 10, y: 10 },
      { action: 'mouse_down', x: 10, y: 10 }, { action: 'mouse_up', x: 10, y: 10 }], { timeoutMs: 1500 }));
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    await assert.rejects(lane.reconcile(), error => error.code === 'reconcile_unsupported');
  } finally { await lane.close().catch(() => {}); }
});

test('the proof waits for the VNC child to exit before any Host probe', async () => {
  const hosts = hostSequence(index => ({ alter(request, response) {
    return index === 0 && request.action === 'ax_action' ? null : response;
  } }));
  const client = vncClient({ exits: 'manual' });
  const lane = laneFor(hosts, [client, vncClient()]);
  try {
    lane.acquire('first');
    await lane.execute([{ action: 'ax_snapshot' }]);
    await assert.rejects(lane.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]));
    // The child was signalled but has not exited within the release budget.
    assert.ok(client.closes.length >= 1);
    await assert.rejects(lane.release('first'), error => error.code === 'release_unconfirmed');
    await assert.rejects(lane.reconcile({ timeoutMs: 500 }), /Native owned exit unconfirmed/);
    assert.ok(lane.cleanupFailure);
    assert.equal(hosts.attachments.length, 1);
    // Once the child exits, the probe runs and the latch clears.
    client.exit();
    const receipt = await lane.reconcile();
    assert.equal(receipt.reconciled, true);
    assert.deepEqual(receipt.native, { input_settled: true, exit_observed: true, delivery_proven: false });
    assert.deepEqual(hosts.attachments[1].requests.map(request => request.action), ['health']);
  } finally { await lane.close().catch(() => {}); }
});
