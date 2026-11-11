#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { defaultConfigPath, defaultSocketPath, defaultStateDir, loadConfig } from '../lib/broker/paths.mjs';

let values, positionals, command, socketPath, configPath, installerTimingsForError;

async function packageVersion() {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return metadata.version;
}

function lifecycle(service, { unconfirmedExitCode = 1 } = {}) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await service.close(); } catch {
      process.stderr.write('Fruitctl: owned session cleanup unconfirmed; reconcile the target before restarting\n');
      process.exitCode = unconfirmedExitCode;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

try {
  ({ values, positionals } = parseArgs({ allowPositionals: true, options: {
  target: { type: 'string', default: 'default' }, socket: { type: 'string' },
  config: { type: 'string' }, bridge: { type: 'string' },
  'remote-socket': { type: 'string' }, 'remote-command': { type: 'string' },
  agent: { type: 'string' }, scope: { type: 'string' }, version: { type: 'string' },
  'dry-run': { type: 'boolean' }, 'project-dir': { type: 'string' }, 'install-root': { type: 'string' },
  mux: { type: 'boolean' }, stdio: { type: 'boolean' }, json: { type: 'boolean' },
  timings: { type: 'boolean' }, macos: { type: 'boolean' }, 'target-ssh': { type: 'string' },
  help: { type: 'boolean' }, 'manifest-url': { type: 'string' }, secrets: { type: 'boolean' },
  once: { type: 'boolean' }, health: { type: 'boolean' },
} }));
command = positionals[0];
socketPath = values.socket || defaultSocketPath();
configPath = values.config || defaultConfigPath();

  if (positionals.length > 1 && command !== 'journal') throw new Error('Unexpected positional arguments; use --help');
  if (values['install-root'] !== undefined && !['install', 'doctor', 'rollback', 'uninstall'].includes(command)) {
    throw new Error('--install-root is supported only by install, doctor, rollback and uninstall');
  }
  if (command === 'install' && values['install-root'] !== undefined && !['user', 'project'].includes(values.scope)) {
    throw new Error('Installation with --install-root requires explicit --scope user|project');
  }
  if (values.timings && command && !['install', 'doctor', 'rollback', 'uninstall'].includes(command)) {
    throw new Error('--timings is supported only by install, doctor, rollback and uninstall');
  }
  if (values.macos && command !== 'doctor') throw new Error('--macos is supported only by doctor');
  if (values['target-ssh'] !== undefined && !values.macos) throw new Error('--target-ssh requires doctor --macos');
  if (values.secrets && command !== 'doctor') throw new Error('--secrets is supported only by doctor');
  if ((values.once || values.health) && command !== 'relay') throw new Error('--once and --health are supported only by relay');
  if (values.help || !command) {
    process.stdout.write('Fruitctl\n\nCommands: mcp, broker, relay, attach, install, doctor, rollback, uninstall, journal, reconcile\n' +
      '  mcp --target PROFILE [--socket PATH]\n' +
      '  broker [--config PATH] [--socket PATH]\n' +
      '  relay --bridge USER@HOST [--socket PATH] [--remote-socket PATH] [--remote-command PATH] [--once]\n' +
      '  relay --health [--socket PATH]\n' +
      '  install --agent AGENT --scope user|project --version TAG --target PROFILE [--project-dir PATH] [--install-root ABSOLUTE_DIRECTORY] [--dry-run]\n' +
      '  doctor [--agent AGENT] [--scope user|project] [--project-dir PATH] [--install-root ABSOLUTE_DIRECTORY] --json\n' +
      '  doctor --macos [--target PROFILE] [--config PATH] [--target-ssh USER@HOST] [--bridge USER@HOST [--remote-command PATH]]\n' +
      '  doctor --secrets [--target PROFILE] [--config PATH]\n' +
      '  rollback|uninstall --agent AGENT [--scope user|project] [--project-dir PATH] [--install-root ABSOLUTE_DIRECTORY]\n' +
      '  journal verify FILE\n' +
      '  reconcile --target PROFILE [--socket PATH]\n' +
      '\n--install-root selects Fruitctl runtime/state/launcher storage; registration still follows scope and project/user configuration.\n' +
      'Repeat the selected root for doctor, rollback and uninstall. Explicit-root installation requires explicit scope; omitted root preserves legacy paths.\n' +
      'Install requires explicit --version TAG. Doctor writes JSON: exit 1 for drift, 0 for configured or not-installed.\n' +
      'Doctor --macos adds read-only target checks over SSH (macOS 26.6.1+ or 27, Screen Sharing mode, session, Host grants, other input owners, target profile); a typed failure exits 1.\n' +
      'Doctor --secrets resolves each declared credential and type_secret ref once on this broker host, prints only provider and status, and exits 1 on a failure.\n' +
      'From a Linux seat, doctor --macos runs the probe on the Darwin bridge (--bridge or FRUITCTL_BRIDGE_HOST), which owns the profile.\n' +
      'The relay reconnects with capped backoff and answers clients with typed bridge errors; --once exits on the first bridge loss.\n' +
      'relay --health prints the running relay\'s state as JSON and exits 0 only while its bridge is up.\n' +
      'reconcile asks the running broker to prove a latched Host release and clear it; it prints a JSON receipt\n' +
      'and exits 1 when the target cannot prove it (a VNC lane with unsettled input needs a reconciled broker restart).\n' +
      'Add --timings to installer commands for bounded aggregate timings; default output is unchanged.\n');
  } else if (command === 'broker') {
    const { createBroker } = await import('../lib/broker/server.mjs');
    const { brokerObservability } = await import('../lib/broker/observe.mjs');
    const config = await loadConfig(configPath);
    const log = message => process.stderr.write(`${message}\n`);
    const { journal, telemetry } = brokerObservability(config, { stateDir: defaultStateDir(), log });
    lifecycle(await createBroker({ socketPath, config, journal, telemetry, log }));
    process.stderr.write('Fruitctl broker ready\n');
  } else if (command === 'journal') {
    if (positionals[1] !== 'verify' || positionals.length !== 3) throw new Error('Usage: fruitctl journal verify FILE');
    const { verifyJournal } = await import('../lib/broker/journal.mjs');
    const result = await verifyJournal(positionals[2]);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'relay' && values.health) {
    const { queryRelayHealth } = await import('../lib/broker/relay.mjs');
    const health = await queryRelayHealth({ socketPath });
    process.stdout.write(JSON.stringify(health, null, 2) + '\n');
    if (health.state !== 'up') process.exitCode = 1;
  } else if (command === 'relay') {
    const { createRelay, RELAY_EXIT } = await import('../lib/broker/relay.mjs');
    const log = message => process.stderr.write(`${message}\n`);
    const service = await createRelay({ socketPath, bridge: values.bridge ?? process.env.FRUITCTL_BRIDGE_HOST,
      remoteSocket: values['remote-socket'], remoteCommand: values['remote-command'],
      reconnect: !values.once, log });
    lifecycle(service, { unconfirmedExitCode: RELAY_EXIT.unconfirmed });
    process.stderr.write('Fruitctl relay ready\n');
    service.failure.catch(async error => {
      process.stderr.write(`Fruitctl relay: ${error.code || 'bridge_lost'}: ${error.message}\n`);
      let exitCode = error.exitCode ?? 1;
      try { await service.close(); } catch {
        process.stderr.write('Fruitctl: owned session cleanup unconfirmed; reconcile the target before restarting\n');
        exitCode = RELAY_EXIT.unconfirmed;
      }
      process.exitCode = exitCode;
    });
  } else if (command === 'attach') {
    if (!values.mux) throw new Error('Attach requires --mux; agents use mcp --target PROFILE');
    const { attachMux } = await import('../lib/broker/relay.mjs');
    await attachMux({ socketPath });
  } else if (command === 'reconcile') {
    const { BrokerExecutor } = await import('../lib/broker/client.mjs');
    const executor = new BrokerExecutor({ socketPath, target: values.target });
    try {
      await executor.opened;
      const receipt = await executor.reconcile();
      process.stdout.write(JSON.stringify(receipt ?? { reconciled: false }, null, 2) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ reconciled: false, ...(typeof error.code === 'string' ? { code: error.code } : {}),
        message: String(error.message).slice(0, 512) }, null, 2) + '\n');
      process.exitCode = 1;
    } finally { await executor.close(); }
  } else if (command === 'mcp') {
    const { BrokerExecutor } = await import('../lib/broker/client.mjs');
    const { startMcp } = await import('../lib/mcp/server.js');
    const version = await packageVersion();
    const executor = new BrokerExecutor({ socketPath, target: values.target });
    await executor.opened;
    const server = await startMcp({ executor, name: 'fruitctl', version });
    lifecycle({ close: async () => { await server.close(); await executor.close(); } });
    process.stdin.once('end', () => executor.close());
  } else if (['install', 'doctor', 'uninstall', 'rollback'].includes(command)) {
    if (command === 'install' && !values.version) {
      throw new Error('Installation requires explicit --version TAG; use the exact published release tag');
    }
    let macos;
    if (values.macos) {
      const { resolvePreflightTarget } = await import('../lib/install/macos-preflight.mjs');
      macos = await resolvePreflightTarget({ targetSsh: values['target-ssh'], target: values.target,
        configPath: values.config || process.env.FRUITCTL_CONFIG_PATH || defaultConfigPath(),
        bridge: values.bridge, environmentBridge: process.env.FRUITCTL_BRIDGE_HOST,
        remoteCommand: values['remote-command'] ?? process.env.FRUITCTL_BRIDGE_COMMAND });
    }
    const installer = await import('../lib/install/index.mjs');
    if (values.timings) installerTimingsForError = installer.timingsForError;
    const result = await installer[command]({ agent: values.agent, scope: values.scope,
      version: values.version || await packageVersion(), target: values.target,
      dryRun: Boolean(values['dry-run']), projectDir: values['project-dir'],
      installRoot: values['install-root'],
      ...(values.timings === true ? { timings: true } : {}),
      configPath: values.config || process.env.FRUITCTL_CONFIG_PATH,
      manifestUrl: values['manifest-url'], ...(macos ? { macos } : {}) });
    if (values.secrets) {
      // D16/D36: values are resolved and discarded; only provider and status print.
      const { checkSecrets } = await import('../lib/broker/secrets.mjs');
      const explicitTarget = process.argv.some(argument => argument === '--target' || argument.startsWith('--target='));
      result.secretsCheck = await checkSecrets(await loadConfig(values.config || defaultConfigPath()),
        explicitTarget ? { target: values.target } : {});
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (command === 'doctor' && (result.status === 'drift' || result.targetPreflight?.status === 'fail' ||
        result.secretsCheck?.status === 'fail')) process.exitCode = 1;
  } else throw new Error('Unknown Fruitctl command; use --help');
} catch (error) {
  // A relay or broker refusal at MCP startup keeps its typed code (D20).
  const typed = typeof error.code === 'string' && /^(bridge_[a-z_]+|broker_unavailable)$/.test(error.code);
  process.stderr.write(`Fruitctl: ${typed ? `${error.code}: ` : ''}${error.message}\n`);
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  if (values?.timings === true && installerTimingsForError) {
    try {
      const timings = installerTimingsForError(error);
      if (timings) process.stderr.write(JSON.stringify({ timings }) + '\n');
    } catch { /* Optional diagnostics cannot replace the original command error. */ }
  }
}
