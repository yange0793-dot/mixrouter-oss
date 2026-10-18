'use strict';
// Transport is injected: this module does not read configuration or contact a server on require.
function parseLogsArgs(args = []) {
  const query = new URLSearchParams();
  let json = false, history = false, positional = false;
  const names = new Set(['since', 'until', 'cursor', 'limit', 'app', 'provider', 'model', 'session', 'status', 'slot', 'err_class']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--history') { history = true; continue; }
    if (arg.startsWith('--')) {
      const split = arg.indexOf('=');
      const name = arg.slice(2, split < 0 ? undefined : split);
      if (!names.has(name)) throw new Error(`Unknown logs option: --${name}`);
      const value = split < 0 ? args[++i] : arg.slice(split + 1);
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
      query.set(name, value);
      if (name === 'cursor') history = true;
    } else {
      if (positional || !/^\d+$/.test(arg)) throw new Error(`Invalid logs count: ${arg}`);
      query.set('limit', arg); positional = true;
    }
  }
  if (!query.has('limit')) query.set('limit', '20');
  if (history) query.set('history', '1');
  return { query, json, history };
}
async function runLogs(args, { request, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { query, json } = parseLogsArgs(args);
    const result = await request(`/api/logs?${query}`);
    if (result.error) throw new Error(result.error);
    if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const e of result.logs || []) stdout.write(`${e.ts || '-'} ${e.status ?? '-'} ${typeof e.slot === 'string' ? (e.slot || 'none') : 'unknown'} ${e.provider || '-'} ${e.model_in || '-'} → ${e.model_out || '-'} ${e.ms ?? 0}ms${e.err ? ` ${e.err}` : ''}\n`);
      if (result.next_cursor) stdout.write(`next_cursor: ${result.next_cursor}\n`);
      if (result.scope) stdout.write(`scope: ${JSON.stringify(result.scope)}\n`);
    }
    return 0;
  } catch (e) { stderr.write(`logs: ${e.message}\n`); return 1; }
}
module.exports = { parseLogsArgs, runLogs };
