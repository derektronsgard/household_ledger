// Household Ledger API — a single Vercel serverless function.
// It checks the family passcode, then reads/writes Supabase with a secret key
// that never leaves the server.
//
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   FAMILY_PASSCODE       the passcode you and your wife type to open the app
//   SUPABASE_URL          e.g. https://abcdxyz.supabase.co
//   SUPABASE_SECRET_KEY   Supabase "secret" key (sb_secret_...) or legacy service_role key

const crypto = require('crypto');

const TABLES = {
  categories: { order: 'sort.asc,name.asc' },
  transactions: { order: 'date.desc,id.asc' },
  rules: { order: 'created_at.asc' },
  budgets: { order: 'month.asc' },
  settings: { order: 'id.asc' },
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sbHeaders(extra) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key && key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key; // legacy JWT keys
  return h;
}

function sbUrl(path) {
  return process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path;
}

async function sbFetch(path, opts) {
  const r = await fetch(sbUrl(path), opts);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Database error ${r.status}: ${body.slice(0, 300)}`);
  }
  return r;
}

async function loadTable(table) {
  const all = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const r = await sbFetch(`${table}?select=*&order=${TABLES[table].order}`, {
      headers: sbHeaders({ 'Range-Unit': 'items', Range: `${from}-${from + page - 1}` }),
    });
    const rows = await r.json();
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all;
}

async function upsert(table, rows, ignoreDuplicates) {
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await sbFetch(`${table}?on_conflict=id`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: `resolution=${ignoreDuplicates ? 'ignore' : 'merge'}-duplicates,return=minimal` }),
      body: JSON.stringify(chunk),
    });
    written += chunk.length;
  }
  return written;
}

async function remove(table, ids) {
  for (let i = 0; i < ids.length; i += 200) {
    const list = ids.slice(i, i + 200).map(id => '"' + String(id).replace(/"/g, '') + '"').join(',');
    await sbFetch(`${table}?id=in.(${encodeURIComponent(list)})`, { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const missing = ['FAMILY_PASSCODE', 'SUPABASE_URL'].filter(k => !process.env[k]);
  if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SECRET_KEY');
  if (missing.length) return res.status(500).json({ error: 'Missing Vercel environment variables: ' + missing.join(', ') });

  const pass = req.headers['x-passcode'] || '';
  if (!pass || !safeEqual(pass, process.env.FAMILY_PASSCODE)) {
    await new Promise(r => setTimeout(r, 600)); // slow down guessing
    return res.status(401).json({ error: 'Wrong passcode' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { action, table } = body;

  try {
    if (action === 'ping') return res.json({ ok: true });

    if (action === 'load') {
      const [categories, transactions, rules, budgets, settings] = await Promise.all(Object.keys(TABLES).map(loadTable));
      return res.json({ categories, transactions, rules, budgets, settings });
    }

    if (!TABLES[table]) return res.status(400).json({ error: 'Unknown table' });

    if (action === 'upsert') {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const n = await upsert(table, rows, !!body.ignoreDuplicates);
      return res.json({ ok: true, written: n });
    }

    if (action === 'delete') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      await remove(table, ids);
      return res.json({ ok: true, deleted: ids.length });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
