// pgbridge - PostgreSQL wire-protocol -> PHP-gateway SQL bridge.
// Runs ON THE RUNNER (not the shared host), so it is never killed by shared-host
// process reaping. app(Go/pgx, simple protocol) connects to 127.0.0.1:<port>;
// each SQL is forwarded as an HTTP request to xh.php -> pgapi.php on the
// permanent host. Shared host needs NO long-running process.
//
// WHY simple protocol: pgx is launched with
//   default_query_exec_mode=simple_protocol
// so every statement arrives as a single text 'Q' message (no prepared stmts,
// no binary params). That keeps the wire handling tractable.
import net from 'node:net';
import { PostgresConnection } from 'pg-gateway';

const LISTEN_PORT = Number(process.env.PGBRIDGE_PORT || 5432);
const PANEL_URL = process.env.PG_PANEL_URL || '';
const PANEL_TOKEN = process.env.PG_PANEL_TOKEN || '';
const DB_USER = process.env.PG_DB_USER || 'xjiejie_ggg123';

if (!PANEL_URL || !PANEL_TOKEN) {
  console.error('FATAL: PG_PANEL_URL / PG_PANEL_TOKEN required');
  process.exit(1);
}

// ---- PHP gateway client (same protocol as pg_client.py) ----
const GATEWAY = '/virtual/xjiejie/pgapi.php';
async function gateway(action, extra = {}) {
  const req = JSON.stringify({ action, ...extra });
  const b64 = Buffer.from(req, 'utf8').toString('base64');
  const cmd = `echo ${b64} | php -q ${GATEWAY}`;
  const body = new URLSearchParams({ k: PANEL_TOKEN, a: 'exec', c: cmd, t: '90' });
  const resp = await fetch(PANEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(120000),
  });
  let raw = await resp.text();
  raw = raw.trim();
  if (/^content-type:/i.test(raw)) raw = raw.split('\n').slice(1).join('\n').trim();
  try { return JSON.parse(raw); }
  catch { return { ok: false, error: 'non-JSON gateway response', raw: raw.slice(0, 200) }; }
}

// ---- minimal PostgreSQL text-protocol result encoder ----
// Message framing: type byte + Int32 length (length includes itself, not type).
function msg(type, body) {
  const len = Buffer.byteLength(body) + 4;
  const out = Buffer.alloc(5 + Buffer.byteLength(body));
  out.write(type, 0, 'ascii');
  out.writeInt32BE(len, 1);
  out.write(body, 5, 'ascii');
  return out;
}
const cstring = (s) => s.replace(/\0/g, '') + '\0';

function rowDescription(cols) {
  // cols: [{name, oid}] ; text format (0)
  let body = Int16Bytes(cols.length);
  for (const c of cols) {
    body += cstring(c.name);
    body += Int32Bytes(0);   // table oid
    body += Int16Bytes(0);   // column attr
    body += Int32Bytes(c.oid ?? 25); // type oid (25=text default)
    body += Int16Bytes(-1);  // type size
    body += Int32Bytes(-1);  // type modifier
    body += Int16Bytes(0);   // format = text
  }
  return msg('T', body);
}
function dataRow(values) {
  let body = Int16Bytes(values.length);
  for (const v of values) {
    if (v == null) { body += Int32Bytes(-1); continue; }
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const buf = Buffer.from(s, 'utf8');
    body += Int32Bytes(buf.length) + buf.toString('binary');
  }
  const len = Buffer.byteLength(body, 'binary') + 4;
  const out = Buffer.alloc(5 + Buffer.byteLength(body, 'binary'));
  out.write('D', 0, 'ascii');
  out.writeInt32BE(len, 1);
  out.write(body, 5, 'binary');
  return out;
}
function commandComplete(tag) { return msg('C', cstring(tag)); }
function readyForQuery() { return msg('Z', 'I'); }
function errorResponse(message) {
  let body = 'S' + cstring('ERROR');
  body += 'C' + cstring('XX000');
  body += 'M' + cstring(message);
  body += '\0';
  return msg('E', body);
}
function Int16Bytes(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b.toString('binary'); }
function Int32Bytes(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b.toString('binary'); }

// ---- SQL classification: decide query vs exec, extract columns ----
function classifySQL(sql) {
  const s = sql.trim().toUpperCase();
  if (/^(SELECT|WITH|SHOW|EXPLAIN|VALUES|TABLE)\b/.test(s) || /\bRETURNING\b/.test(s)) return 'query';
  return 'exec';
}

// ---- main wire server ----
const server = net.createServer((socket) => {
  const connection = new PostgresConnection(socket, {
    serverVersion: '16.3 (pgbridge)',
    authMode: 'cleartextPassword',
    async validateCredentials(credentials) {
      // 网关 token 才是真凭据；这里接受任意密码，由网络隔离保护（仅监听 127.0.0.1）
      return credentials.authMode === 'cleartextPassword';
    },
    async onMessage(data, { isAuthenticated }) {
      if (!isAuthenticated) return false;
      // data is a raw wire Buffer. We only handle Simple Query ('Q').
      const type = String.fromCharCode(data[0]);
      if (type !== 'Q') return false; // let library handle others (terminate etc.)

      try {
        const sql = data.subarray(5, data.length - 1).toString('utf8').replace(/\0$/, '');
        if (!sql.trim()) {
          connection.sendData(commandComplete('SELECT 0'));
          connection.sendData(readyForQuery());
          return true;
        }
        const action = classifySQL(sql);
        const r = await gateway(action, { sql });
        if (!r.ok) {
          connection.sendData(errorResponse(r.error || 'gateway error'));
          connection.sendData(readyForQuery());
          return true;
        }
        if (action === 'query') {
          const rows = r.rows || [];
          const cols = rows.length
            ? Object.keys(rows[0]).map((name) => ({ name, oid: 25 }))
            : [{ name: '?column?', oid: 25 }];
          connection.sendData(rowDescription(cols));
          for (const row of rows) connection.sendData(dataRow(cols.map((c) => row[c.name])));
          connection.sendData(commandComplete(`SELECT ${rows.length}`));
        } else {
          connection.sendData(commandComplete(`${sql.trim().split(/\s+/)[0].toUpperCase()} ${r.affected ?? 0}`));
        }
        connection.sendData(readyForQuery());
      } catch (err) {
        connection.sendData(errorResponse(String(err && err.message ? err.message : err)));
        connection.sendData(readyForQuery());
      }
      return true;
    },
  });
  socket.on('error', () => {});
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`pgbridge listening on 127.0.0.1:${LISTEN_PORT} -> PHP gateway`);
});
