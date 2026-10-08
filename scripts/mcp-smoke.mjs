#!/usr/bin/env node
// End-to-end MCP coverage using the installed/native binary and an isolated data home.
// Usage: node scripts/mcp-smoke.mjs [path/to/laci]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const binary = path.resolve(process.argv[2] || 'target/debug/laci');
const home = await mkdtemp(path.join(tmpdir(), 'laci-mcp-smoke-'));
const encode = p => p.replace(/[^A-Za-z0-9]/g, '-');
const exists = async p => stat(p).then(() => true, () => false);
const write = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
const project = path.join(home, 'project', 'alpha');
const logStore = path.join(home, '.claude', 'projects');
const claudeFile = path.join(logStore, encode(project), 'alpha-session.jsonl');
const codexFile = path.join(home, '.codex', 'sessions', '2026', 'alpha.jsonl');
const ghost = path.join(home, 'project', 'ghost');
const orphanDir = path.join(logStore, encode(ghost));
const originalClaude = `${JSON.stringify({ type: 'user', cwd: project, gitBranch: 'main' })}\n`;
const originalCodex = `${JSON.stringify({ type: 'session_meta', payload: { cwd: project } })}\n`;
let child;
let stderr = '';
let checks = 0;

class Client {
  constructor(process) {
    this.process = process;
    this.id = 0;
    this.pending = new Map();
    this.lines = createInterface({ input: process.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error(`MCP wrote non-JSON stdout: ${line.slice(0, 300)}`)); return; }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    process.on('error', error => this.fail(error));
    process.stdin.on('error', error => this.fail(error));
    process.on('exit', (code, signal) => this.fail(new Error(`MCP exited (${code ?? signal}): ${stderr.slice(-4000)}`)));
  }
  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  notify(method, params = {}) { this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  request(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (result.isError) throw new Error(text || `Tool failed: ${name}`);
    return JSON.parse(text);
  }
  async rejects(name, args, expected) {
    await assert.rejects(() => this.call(name, args), expected);
    checks++;
  }
  close() { this.lines.close(); this.fail(new Error('Client closed')); }
}

try {
  assert.ok(await exists(binary), `Build the native binary first: ${binary}`);
  await write(path.join(project, 'package.json'), '{"name":"alpha","scripts":{"test":"node --test"},"dependencies":{"react":"latest"}}\n');
  await write(path.join(project, 'README.md'), '# Alpha\n\nTokenizer prototype for migration checks.\n');
  await write(path.join(project, 'TODO.md'), '## Next\n\n- [ ] Ship tokenizer parser\n- [ ] Ship tokenizer docs\n');
  await write(claudeFile, originalClaude);
  await write(codexFile, originalCodex);
  await write(path.join(orphanDir, 'gone.jsonl'), `${JSON.stringify({ cwd: ghost })}\n`);
  await write(path.join(home, '.config', 'laci', 'config.json'), JSON.stringify({ roots: ['~/project'], presets: ['claude', 'codex'], custom: [], apps: {} }));

  child = spawn(binary, ['mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LACI_HOME: home,
      DISPLAY: '', WAYLAND_DISPLAY: '',
      GIT_AUTHOR_NAME: 'Migration Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Migration Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_000); });
  const client = new Client(child);
  const initialized = await client.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'laci-migration-smoke', version: '1.0.0' },
  });
  assert.equal(initialized.serverInfo.name, 'laci');
  client.notify('notifications/initialized');
  const catalog = await client.request('tools/list');
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), [
    'add_next_step', 'apply_suggestion', 'archive_project', 'complete_task', 'create_project', 'delete_project', 'list_projects',
    'move_project', 'needs_attention', 'project_details', 'recent_changes', 'set_project_fields', 'tidy_suggestions',
    'undo_change', 'write_notes',
  ]);
  checks++;

  const listed = await client.call('list_projects', { query: 'alpha react', filter: 'all' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, project);
  const details = await client.call('project_details', { project: 'alpha' });
  assert.equal(details.tasks.length, 2);
  assert.equal(details.sessions.length, 1);
  assert.equal(details.agentItems.length, 1);
  assert.ok(details.agentSessions.some(session => session.provider === 'codex' && session.cwd === project));
  const attention = await client.call('needs_attention');
  assert.ok(attention.projects.some(node => node.path === project));
  assert.ok(attention.warnings.some(warning => warning.code === 'claude-cleanup'));
  await client.call('recent_changes');
  checks++;

  await client.rejects('complete_task', { project, text: 'tokenizer' }, /More than one checkbox matches/i);
  let edited = await client.call('complete_task', { project, text: 'tokenizer parser' });
  assert.equal(edited.tasks.find(task => task.text === 'Ship tokenizer parser').done, true);
  edited = await client.call('add_next_step', { project, text: 'Ship schema validator coverage' });
  assert.ok(edited.tasks.some(task => task.file === '.laci.md' && task.text === 'Ship schema validator coverage'));
  edited = await client.call('complete_task', { project, text: 'schema validator' });
  assert.equal(edited.tasks.find(task => task.text === 'Ship schema validator coverage').done, true);
  edited = await client.call('complete_task', { project, text: 'schema validator', done: false });
  assert.equal(edited.tasks.find(task => task.text === 'Ship schema validator coverage').done, false);
  edited = await client.call('set_project_fields', { project, status: 'paused', priority: 'high', deadline: '2099-10-02' });
  assert.equal(edited.meta.status, 'paused');
  assert.equal(edited.meta.priority, 'high');
  assert.equal(edited.meta.deadline, '2099-10-02');
  await client.call('write_notes', { project, notes: 'Initial migration note.', mode: 'replace' });
  edited = await client.call('write_notes', { project, notes: 'Second migration note.', mode: 'append' });
  assert.equal(edited.notes, 'Initial migration note.\n\nSecond migration note.');
  checks++;

  const createArgs = { parent: '~/project', name: 'created', summary: 'Created through native MCP.' };
  const createPlan = await client.call('create_project', createArgs);
  assert.ok(createPlan.plan);
  assert.equal(await exists(path.join(home, 'project', 'created')), false);
  const created = await client.call('create_project', { ...createArgs, confirm: true });
  assert.equal(created.path, path.join(home, 'project', 'created'));
  assert.equal(await exists(path.join(created.path, '.git')), true);
  assert.deepEqual(created.warnings, []);
  assert.ok((await client.call('list_projects', { query: 'created' })).some(node => node.path === created.path));
  checks++;

  const beforeSidecar = await readFile(path.join(project, '.laci.md'));
  const beforeTodo = await readFile(path.join(project, 'TODO.md'));
  const beforeClaudeAt = (await stat(claudeFile, { bigint: true })).mtimeNs;
  const beforeCodexAt = (await stat(codexFile, { bigint: true })).mtimeNs;
  const movedPath = path.join(home, 'project', 'bravo');
  const moveArgs = { project, destination: '~/project/bravo' };
  const movePlan = await client.call('move_project', moveArgs);
  assert.equal(movePlan.destination, movedPath);
  assert.ok(movePlan.plan.some(op => op.kind === 'rename'));
  assert.ok(movePlan.plan.some(op => op.kind === 'rewrite'));
  assert.equal(await exists(project), true);
  assert.equal(await exists(movedPath), false);
  assert.equal(await readFile(claudeFile, 'utf8'), originalClaude);
  const moved = await client.call('move_project', { ...moveArgs, confirm: true });
  assert.ok(moved.journal.id);
  assert.equal(await exists(project), false);
  assert.equal(await exists(movedPath), true);
  const movedClaude = path.join(logStore, encode(movedPath), 'alpha-session.jsonl');
  assert.equal(JSON.parse((await readFile(movedClaude, 'utf8')).trim()).cwd, movedPath);
  assert.equal(JSON.parse((await readFile(codexFile, 'utf8')).trim()).payload.cwd, movedPath);
  const movedDetails = await client.call('project_details', { project: movedPath });
  assert.equal(movedDetails.agentItems.find(item => item.connector === 'codex').cwd, movedPath, 'A same-length cwd rewrite with preserved mtime must invalidate agent cache');
  assert.equal((await stat(movedClaude, { bigint: true })).mtimeNs, beforeClaudeAt);
  assert.equal((await stat(codexFile, { bigint: true })).mtimeNs, beforeCodexAt);
  const undoPlan = await client.call('undo_change', { id: moved.journal.id });
  assert.equal(undoPlan.plan.journal, moved.journal.id);
  assert.match(undoPlan.hint, /Nothing has changed yet/);
  assert.equal(await exists(movedPath), true, 'An undo must be previewed before it changes anything');
  await client.call('undo_change', { id: moved.journal.id, confirm: true });
  assert.equal(await exists(project), true);
  assert.equal(await exists(movedPath), false);
  assert.equal(await readFile(claudeFile, 'utf8'), originalClaude);
  assert.equal(await readFile(codexFile, 'utf8'), originalCodex);
  assert.deepEqual(await readFile(path.join(project, '.laci.md')), beforeSidecar);
  assert.deepEqual(await readFile(path.join(project, 'TODO.md')), beforeTodo);
  assert.equal((await stat(claudeFile, { bigint: true })).mtimeNs, beforeClaudeAt);
  assert.equal((await client.call('project_details', { project })).agentItems.find(item => item.connector === 'codex').cwd, project);
  checks++;

  const deletionPlan = await client.call('delete_project', { project });
  assert.equal(deletionPlan.plan.allowed, false);
  assert.equal(await exists(project), true);
  await client.rejects('delete_project', { project, confirm: true }, /standalone Git/i);
  checks++;

  const customArchive = path.join(home, 'project', '_archive', 'custom-alpha');
  const blockedArchive = path.join(home, 'project', '_archive', 'alpha');
  await mkdir(blockedArchive, { recursive: true });
  await client.rejects('archive_project', { project }, /already exists/i);
  assert.match((await client.call('project_details', { project })).archivePlan.error, /already exists/i);
  const customPlan = await client.call('archive_project', { project, destination: customArchive });
  assert.equal(customPlan.destination, customArchive);
  assert.equal(await exists(project), true);
  const customApplied = await client.call('archive_project', { project, destination: customArchive, confirm: true });
  assert.equal(await exists(customArchive), true);
  await client.call('undo_change', { id: customApplied.journal.id, confirm: true });
  assert.deepEqual(await readFile(path.join(project, '.laci.md')), beforeSidecar);
  await rm(blockedArchive, { recursive: true });
  checks++;

  const archivePlan = await client.call('archive_project', { project });
  assert.equal(archivePlan.destination, path.join(home, 'project', '_archive', 'alpha'));
  assert.equal(await exists(project), true);
  assert.equal(await exists(archivePlan.destination), false);
  const archived = await client.call('archive_project', { project, confirm: true });
  assert.equal(await exists(project), false);
  const archivedDetails = await client.call('project_details', { project: archivePlan.destination });
  assert.equal(archivedDetails.archived, true);
  assert.equal(archivedDetails.meta.status, 'archived');
  await client.call('undo_change', { id: archived.journal.id, confirm: true });
  assert.equal(await exists(project), true);
  assert.deepEqual(await readFile(path.join(project, '.laci.md')), beforeSidecar);
  assert.equal(await readFile(claudeFile, 'utf8'), originalClaude);
  checks++;

  const suggestions = await client.call('tidy_suggestions');
  let orphan = suggestions.find(proposal => proposal.action?.type === 'quarantine' && proposal.action.moves.some(move => move.from === orphanDir));
  assert.ok(orphan, 'The isolated missing project should produce a restorable quarantine suggestion');
  await client.call('apply_suggestion', { id: orphan.id });
  assert.equal(await exists(orphanDir), true);
  const reviewedId = orphan.id;
  await write(path.join(orphanDir, 'new-history.jsonl'), `${JSON.stringify({ cwd: ghost })}\n`);
  await client.rejects('apply_suggestion', { id: reviewedId, confirm: true }, /Unknown suggestion|changed|review/i);
  assert.equal(await exists(orphanDir), true);
  orphan = (await client.call('tidy_suggestions')).find(proposal => proposal.action?.type === 'quarantine' && proposal.action.moves.some(move => move.from === orphanDir));
  assert.ok(orphan && orphan.id !== reviewedId, 'Changed history must require a new proposal identity');
  const applied = await client.call('apply_suggestion', { id: orphan.id, confirm: true });
  assert.equal(await exists(orphanDir), false);
  await client.call('undo_change', { id: applied.journal.id, confirm: true });
  assert.equal(await exists(orphanDir), true);
  checks++;

  await client.rejects('project_details', {}, /Missing project|project.*required/i);
  await client.rejects('project_details', { project: 'missing-project' }, /Unknown project/i);
  await client.rejects('set_project_fields', { project, status: 'not-a-status' }, /Invalid status|enum/i);
  await client.rejects('set_project_fields', { project, status: 'done', deadline: 'not-a-date' }, /deadline|Invalid/i);
  assert.equal((await client.call('project_details', { project })).meta.status, 'paused', 'A bad field must not partially apply preceding valid fields');
  await client.rejects('write_notes', { project, notes: 'no', mode: 'overwrite' }, /Invalid mode|enum/i);
  await client.rejects('move_project', { project, destination: '~/project/nope', confirm: 'yes' }, /Invalid confirm|boolean/i);
  await client.rejects('move_project', { project, destination: '/tmp/laci-outside-home' }, /inside home|selected workspace/i);
  await client.rejects('create_project', { parent: '~/project', name: '../escape', confirm: true }, /Name:/i);
  await client.rejects('add_next_step', { project, text: 'x'.repeat(301) }, /length|maxLength|300/i);
  await client.rejects('complete_task', { project, text: 'does-not-match' }, /No checkbox matches/i);
  await client.rejects('apply_suggestion', { id: 'missing-suggestion' }, /Unknown suggestion/i);
  await client.rejects('undo_change', { id: 'missing-change' }, /Unknown change/i);
  await client.rejects('undo_change', { id: moved.journal.id }, /no longer be undone/i);
  await client.rejects('create_project', { parent: '~/project', name: 'extra', scanProject: true, confirm: true }, /Unknown argument scanProject/i);
  await client.rejects('recent_changes', { limit: 5 }, /Unknown argument limit/i);
  assert.equal(await exists(path.join(home, 'project', 'extra')), false);
  assert.equal(await exists(path.join(home, 'escape')), false);
  const changes = await client.call('recent_changes');
  assert.ok(changes.entries.some(entry => entry.by === 'agent'));
  assert.ok(changes.entries.some(entry => entry.undoes));

  client.close();
  child.stdin.end();
  const exit = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
  const [code, signal] = await exit;
  clearTimeout(timer);
  assert.equal(code, 0, `MCP must exit cleanly after stdin closes (${signal || code}): ${stderr}`);
  console.log(`MCP smoke passed: 15 tools, ${checks} checks, isolated plan/confirm, history move/undo, and validation.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  await rm(home, { recursive: true, force: true });
}
