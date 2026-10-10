import http from 'node:http';
import type { Connection } from 'mongoose';
import type { Pool } from 'pg';
import type { DatabaseEngine } from '../types.js';

// `efc db studio`: a read-only data browser. Binds to 127.0.0.1 only and never
// writes — it lists tables/collections and pages through their rows.

interface Source {
  collections(): Promise<{ name: string; count: number }[]>;
  rows(name: string, skip: number, limit: number): Promise<{ rows: unknown[]; total: number }>;
}

function mongoSource(conn: Connection): Source {
  const db = conn.db!;
  return {
    async collections() {
      const cols = (await db.listCollections({}, { nameOnly: true }).toArray())
        .map((c) => c.name)
        .filter((n) => !n.startsWith('system.'))
        .sort();
      return Promise.all(
        cols.map(async (name) => ({
          name,
          count: await db.collection(name).estimatedDocumentCount(),
        })),
      );
    },
    async rows(name, skip, limit) {
      const col = db.collection(name);
      const [rows, total] = await Promise.all([
        col.find({}).sort({ _id: -1 }).skip(skip).limit(limit).toArray(),
        col.countDocuments(),
      ]);
      return { rows, total };
    },
  };
}

function pgSource(pool: Pool): Source {
  const tables = async () =>
    (
      await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
      )
    ).rows.map((r) => r.table_name);
  const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
  return {
    async collections() {
      return Promise.all(
        (await tables()).map(async (name) => ({
          name,
          count: (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q(name)}`))
            .rows[0]!.n,
        })),
      );
    },
    async rows(name, skip, limit) {
      // Only names that exist in information_schema are ever interpolated.
      if (!(await tables()).includes(name))
        throw Object.assign(new Error('Unknown table'), { status: 404 });
      const [rows, total] = await Promise.all([
        pool.query(`SELECT * FROM ${q(name)} LIMIT $1 OFFSET $2`, [limit, skip]),
        pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q(name)}`),
      ]);
      return { rows: rows.rows, total: total.rows[0]!.n };
    },
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>EFC Studio</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1115;--panel:#161a21;--line:#262c36;--text:#e6e9ef;--dim:#8b93a3;--acc:#5cc8ff}
*{box-sizing:border-box}body{margin:0;font:13px/1.45 ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;height:100vh}
aside{width:240px;border-right:1px solid var(--line);overflow:auto;background:var(--panel)}
aside h1{font-size:13px;margin:0;padding:14px 16px;border-bottom:1px solid var(--line);letter-spacing:.04em}
aside h1 span{color:var(--dim);font-weight:400}
aside button{display:flex;justify-content:space-between;width:100%;padding:8px 16px;border:0;background:none;color:var(--text);cursor:pointer;text-align:left;font:inherit}
aside button:hover,aside button.on{background:#1f2530}aside button small{color:var(--dim)}
main{flex:1;display:flex;flex-direction:column;min-width:0}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line)}
header b{font-size:14px}header .sp{flex:1}header button{background:#1f2530;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
header button:disabled{opacity:.4;cursor:default}#meta{color:var(--dim)}
.wrap{overflow:auto;flex:1}table{border-collapse:collapse;width:max-content;min-width:100%}
th,td{border-bottom:1px solid var(--line);padding:6px 12px;text-align:left;vertical-align:top;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px}
th{position:sticky;top:0;background:var(--panel);color:var(--dim);font-weight:500}
td.obj{color:var(--acc);cursor:pointer}td.null{color:var(--dim)}
.empty{padding:40px;color:var(--dim)}pre{white-space:pre-wrap;margin:0}
</style></head><body>
<aside><h1>EFC STUDIO <span id="engine"></span></h1><div id="list"></div></aside>
<main><header><b id="title">Select a table</b><span id="meta"></span><span class="sp"></span>
<button id="prev" disabled>‹ Prev</button><button id="next" disabled>Next ›</button></header>
<div class="wrap" id="grid"><div class="empty">Read-only view of your database.</div></div></main>
<script>
const LIMIT=50;let cur=null,skip=0;
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p){const r=await fetch(p);if(!r.ok)throw new Error((await r.json()).error);return r.json()}
async function loadList(){const d=await api('/api/collections');document.getElementById('engine').textContent='· '+d.engine;
const el=document.getElementById('list');el.innerHTML='';
for(const c of d.collections){const b=document.createElement('button');b.innerHTML=esc(c.name)+'<small>'+c.count+'</small>';
b.onclick=()=>{cur=c.name;skip=0;[...el.children].forEach(x=>x.classList.remove('on'));b.classList.add('on');loadRows()};el.appendChild(b)}
if(!d.collections.length)el.innerHTML='<div class="empty">No tables yet.</div>'}
async function loadRows(){const d=await api('/api/collections/'+encodeURIComponent(cur)+'?skip='+skip+'&limit='+LIMIT);
document.getElementById('title').textContent=cur;
document.getElementById('meta').textContent=d.total?(skip+1)+'–'+Math.min(skip+LIMIT,d.total)+' of '+d.total:'empty';
document.getElementById('prev').disabled=skip===0;document.getElementById('next').disabled=skip+LIMIT>=d.total;
const cols=[...new Set(d.rows.flatMap(r=>Object.keys(r)))];const g=document.getElementById('grid');
if(!d.rows.length){g.innerHTML='<div class="empty">No rows.</div>';return}
let h='<table><thead><tr>'+cols.map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr></thead><tbody>';
for(const r of d.rows){h+='<tr>'+cols.map(c=>{const v=r[c];if(v===null||v===undefined)return '<td class="null">null</td>';
if(typeof v==='object'){const j=JSON.stringify(v);return '<td class="obj" title="click to expand" data-j="'+esc(j)+'">'+esc(j)+'</td>'}
return '<td title="'+esc(v)+'">'+esc(v)+'</td>'}).join('')+'</tr>'}
g.innerHTML=h+'</tbody></table>';
g.querySelectorAll('td.obj').forEach(td=>td.onclick=()=>{td.innerHTML='<pre>'+esc(JSON.stringify(JSON.parse(td.dataset.j),null,2))+'</pre>';td.style.whiteSpace='normal';td.onclick=null})}
document.getElementById('prev').onclick=()=>{skip=Math.max(0,skip-LIMIT);loadRows()};
document.getElementById('next').onclick=()=>{skip+=LIMIT;loadRows()};
loadList().catch(e=>document.getElementById('grid').innerHTML='<div class="empty">'+esc(e.message)+'</div>');
</script></body></html>`;

export function startStudio(
  engine: DatabaseEngine,
  client: unknown,
  port: number,
): Promise<{ server: http.Server; url: string }> {
  const source =
    engine === 'postgresql' ? pgSource(client as Pool) : mongoSource(client as Connection);
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'GET') return json(res, 405, { error: 'Studio is read-only' });
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      if (url.pathname === '/api/collections') {
        return json(res, 200, { engine, collections: await source.collections() });
      }
      const m = /^\/api\/collections\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const skip = Math.max(0, Number(url.searchParams.get('skip')) || 0);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        return json(res, 200, await source.rows(decodeURIComponent(m[1]!), skip, limit));
      }
      json(res, 404, { error: 'Not found' });
    })().catch((err: Error & { status?: number }) =>
      json(res, err.status ?? 500, { error: err.message }),
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}
