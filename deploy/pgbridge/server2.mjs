// pgbridge v2 - minimal PostgreSQL wire-protocol server, NO external deps.
// Accepts simple-query clients (psql, pgx with default_query_exec_mode=simple_protocol),
// forwards each SQL to the PHP gateway over HTTP, returns text-format results.
// Runs ON THE RUNNER -> shared host has no long-running process.
import net from 'node:net';

const PORT = Number(process.env.PGBRIDGE_PORT || 5432);
const PANEL_URL = process.env.PG_PANEL_URL || '';
const PANEL_TOKEN = process.env.PG_PANEL_TOKEN || '';
const GATEWAY = '/virtual/xjiejie/pgapi.php';
if (!PANEL_URL || !PANEL_TOKEN) { console.error('FATAL creds'); process.exit(1); }

const log = (...a) => console.error('[bridge]', ...a);

// ---------- wire encoding ----------
function frame(type, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const out = Buffer.alloc(5 + b.length);
  out.write(type, 0, 'ascii');
  out.writeInt32BE(b.length + 4, 1);
  b.copy(out, 5);
  return out;
}
const cs = (s) => Buffer.from(String(s).replace(/\0/g, '') + '\0', 'utf8');
function i16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function concat(...bufs) { return Buffer.concat(bufs.flat()); }

const AuthenticationOk = () => frame('R', i32(0));
const ParameterStatus = (k, v) => frame('S', concat(cs(k), cs(v)));
const BackendKeyData = () => frame('K', concat(i32(12345), i32(67890)));
const ReadyForQuery = () => frame('Z', Buffer.from('I'));
const CommandComplete = (tag) => frame('C', cs(tag));
const ErrorResponse = (m) => frame('E', concat(Buffer.from('S'), cs('ERROR'), Buffer.from('C'), cs('XX000'), Buffer.from('M'), cs(m), Buffer.from([0])));
function RowDescription(cols) {
  const parts = [i16(cols.length)];
  for (const c of cols) parts.push(cs(c), i32(0), i16(0), i32(25), i16(-1), i32(-1), i16(0));
  return frame('T', concat(...parts));
}
function DataRow(vals) {
  const parts = [i16(vals.length)];
  for (const v of vals) {
    if (v == null) { parts.push(i32(-1)); continue; }
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const buf = Buffer.from(s, 'utf8');
    parts.push(i32(buf.length), buf);
  }
  return frame('D', concat(...parts));
}

// ---------- gateway HTTP ----------
async function gateway(action, extra = {}) {
  const b64 = Buffer.from(JSON.stringify({ action, ...extra })).toString('base64');
  const cmd = `echo ${b64} | php -q ${GATEWAY}`;
  const body = new URLSearchParams({ k: PANEL_TOKEN, a: 'exec', c: cmd, t: '90' }).toString();
  const resp = await fetch(PANEL_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(120000) });
  let raw = (await resp.text()).trim();
  if (/^content-type:/i.test(raw)) raw = raw.split('\n').slice(1).join('\n').trim();
  try { return JSON.parse(raw); } catch { return { ok: false, error: 'non-JSON: ' + raw.slice(0,160) }; }
}
const isRead = (sql) => /^(select|with|show|explain|values|table)\b/i.test(sql.trim()) || /\breturning\b/i.test(sql);

// Split a multi-statement SQL script into individual statements.
// Respect $$...$$ dollar-quoted function bodies (semicolons inside are NOT separators).
function splitStatements(sql) {
  const out = [];
  let cur = '', inDollar = false, dollarTag = '';
  // Remove line comments first (but keep newlines), so ";" inside -- comments is ignored.
  const clean = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (!inDollar && ch === '$') {
      const m = /^\$([A-Za-z0-9_]*)\$/.exec(clean.slice(i));
      if (m) { inDollar = true; dollarTag = m[0]; cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (inDollar && clean.startsWith(dollarTag, i)) {
      cur += dollarTag; inDollar = false; i += dollarTag.length - 1; continue;
    }
    if (!inDollar && ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = ''; continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function isCommentOnly(s) { return !s || s.split('\n').every((l) => !l.trim()); }

// ---------- connection state machine ----------
const STARTUP_DONE = 1, SSL_SENT = 2;
const server = net.createServer((sock) => {
  let state = 0, buf = Buffer.alloc(0), inQuery = false, queryBytes = Buffer.alloc(0);
  log('client connected');
  sock.on('error', (e) => log('sock error', e.message));

  async function handleMessage(type, payload) {
    if (type === 'Q') {
      const sql = payload.subarray(0, payload.length - 1).toString('utf8');
      log('QUERY:', sql.slice(0, 100));
      // pgx ping sends "-- ping" (comment only). Treat as empty OK with a
      // valid empty result set so the driver considers the connection healthy.
      if (!sql.trim() || /^--/.test(sql.trim()) || /^\/\*/.test(sql.trim())) {
        sock.write(RowDescription(['?column?']));
        sock.write(CommandComplete('SELECT 0'));
        sock.write(ReadyForQuery());
        return;
      }
      try {
        const stmts = splitStatements(sql).filter((s) => !isCommentOnly(s));
        // Multi-statement script (e.g. schema migration): run each separately,
        // return only the last statement's result (pgx/simple-protocol semantics).
        const scripts = stmts.length > 1 ? stmts : [sql];
        log('EXEC', scripts.length, 'statement(s)');
        let lastResult = null, lastSQL = sql, failed = null;
        for (const stmt of scripts) {
          const action = isRead(stmt) ? 'query' : 'exec';
          const r = await gateway(action, { sql: stmt });
          if (!r.ok) {
            log('STATEMENT FAILED:', stmt.slice(0, 80), '->', r.error);
            failed = r.error; break;
          }
          lastResult = { r, action }; lastSQL = stmt;
        }
        if (failed) {
          sock.write(ErrorResponse(failed));
        } else if (lastResult && lastResult.action === 'query') {
          const rows = lastResult.r.rows || [];
          const cols = rows.length ? Object.keys(rows[0]) : ['?column?'];
          sock.write(RowDescription(cols));
          for (const row of rows) sock.write(DataRow(cols.map((c) => row[c])));
          sock.write(CommandComplete(`SELECT ${rows.length}`));
        } else {
          const verb = lastSQL.trim().split(/\s+/)[0].toUpperCase();
          const tag = verb === 'INSERT' ? `INSERT 0 ${lastResult?.r?.affected ?? 0}`
            : `${verb} ${lastResult?.r?.affected ?? 0}`;
          sock.write(CommandComplete(tag));
        }
      } catch (err) {
        sock.write(ErrorResponse(String(err.message || err)));
      }
      sock.write(ReadyForQuery());
      return;
    }
    if (type === 'X') { log('terminate'); sock.end(); return; }
    log('unhandled msg type', type, 'len', payload.length);
  }

  function processBuffer() {
    while (true) {
      if (state === 0) {
        if (buf.length < 4) return;
        const len = buf.readInt32BE(0);
        if (len === 8 && buf.length >= 8) {
          // SSLRequest -> reply 'N'
          log('SSLRequest -> N');
          sock.write(Buffer.from('N'));
          buf = buf.subarray(8);
          continue;
        }
        if (buf.length < len) return;
        const startup = buf.subarray(4, len);
        log('Startup len', len, 'body head', startup.subarray(0, 12).toString('hex'));
        buf = buf.subarray(len);
        // auth ok + params + ready
        sock.write(AuthenticationOk());
        sock.write(ParameterStatus('server_version', '16.3'));
        sock.write(ParameterStatus('client_encoding', 'UTF8'));
        sock.write(ParameterStatus('DateStyle', 'ISO, MDY'));
        sock.write(ParameterStatus('standard_conforming_strings', 'on'));
        sock.write(BackendKeyData());
        sock.write(ReadyForQuery());
        state = STARTUP_DONE;
        log('handshake done');
        continue;
      }
      if (buf.length < 5) return;
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (buf.length < len + 1) return;
      const payload = buf.subarray(5, len + 1);
      buf = buf.subarray(len + 1);
      handleMessage(type, payload).catch((e) => log('handler err', e.message));
    }
  }

  sock.on('data', (chunk) => {
    buf = concat(buf, chunk);
    try { processBuffer(); } catch (e) { log('process err', e.message, e.stack); sock.end(); }
  });
});

process.on('uncaughtException', (e) => log('UNCAUGHT', e.stack || e));
server.listen(PORT, '127.0.0.1', () => log(`listening 127.0.0.1:${PORT}`));
