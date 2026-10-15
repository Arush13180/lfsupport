// lfsupport — complaint ticket booking with half-hour time slots + admin panel
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('lfsupport:' + (ADMIN_PASSWORD || '')).digest('hex');
const BOOKING_DAYS_AHEAD = parseInt(process.env.BOOKING_DAYS_AHEAD || '30', 10);
const MAX_OPEN_PER_PHONE = parseInt(process.env.MAX_OPEN_PER_PHONE || '1', 10);

if (!DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD is not set'); process.exit(1); }

// Strip sslmode/channel_binding params (handled by the ssl option below)
const cleanDbUrl = (() => {
  // Accept pasted snippets like: psql 'postgresql://...'  or  DATABASE_URL="postgresql://..."
  const m = DATABASE_URL.match(/postgres(?:ql)?:\/\/[^\s'"`]+/);
  const raw = m ? m[0] : DATABASE_URL.trim();
  if (!m) console.error('DATABASE_URL does not contain a postgresql:// address. Paste the connection string from Neon.');
  try { console.log('Database host:', new URL(raw).hostname); } catch {}
  try {
    const u = new URL(raw);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch { return raw; }
})();
const pool = new Pool({
  connectionString: cleanDbUrl,
  // No SSL for localhost or Render's internal hostnames (no dot, e.g. dpg-xxxx-a)
  ssl: (() => { try { const h = new URL(cleanDbUrl).hostname; return (h === 'localhost' || h === '127.0.0.1' || !h.includes('.')) ? false : { rejectUnauthorized: false }; } catch { return { rejectUnauthorized: false }; } })(),
  max: 5,
});

// ---------- Slots: 10:00 AM to 06:00 PM, 30-minute gaps (IST) ----------
const SLOTS = [];
for (let m = 10 * 60; m < 18 * 60; m += 30) {
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  SLOTS.push(`${hh}:${mm}`);
}
function fmt12(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}
function slotLabel(start) {
  const [h, m] = start.split(':').map(Number);
  const end = h * 60 + m + 30;
  const endStr = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  return `${fmt12(start)} – ${fmt12(endStr)}`;
}

// Current date/time in India (UTC+5:30), independent of server timezone
function nowIST() {
  const d = new Date(Date.now() + 330 * 60000);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function validDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
// A slot is bookable if it's today-or-later, within the window, and hasn't started yet
function slotIsInFuture(date, slot) {
  const now = nowIST();
  if (date > now.date) return true;
  if (date < now.date) return false;
  const [h, m] = slot.split(':').map(Number);
  return h * 60 + m > now.minutes;
}

// ---------- Database ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      phone        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      slot_date    DATE NOT NULL,
      slot_time    TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',
      admin_note   TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      solved_at    TIMESTAMPTZ
    );
  `);
  // The core rule: one OPEN ticket per date+slot. Solving a ticket frees the slot.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tickets_open_slot_uniq
      ON tickets (slot_date, slot_time) WHERE status = 'open';
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS tickets_phone_idx ON tickets (phone);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status, slot_date, slot_time);`);
}

function newTicketId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return 'LF-' + s;
}

function rowToTicket(r) {
  const date = r.slot_date instanceof Date
    ? `${r.slot_date.getFullYear()}-${String(r.slot_date.getMonth() + 1).padStart(2, '0')}-${String(r.slot_date.getDate()).padStart(2, '0')}`
    : String(r.slot_date).slice(0, 10);
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    description: r.description,
    date,
    slot: r.slot_time,
    slotLabel: slotLabel(r.slot_time),
    status: r.status,
    adminNote: r.admin_note,
    createdAt: r.created_at,
    solvedAt: r.solved_at,
  };
}
// Return DATE columns as plain strings to avoid timezone shifts
require('pg').types.setTypeParser(1082, v => v);

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20kb' }));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// Simple in-memory rate limiter
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();

// ---------- Public API ----------
app.get('/api/config', (req, res) => {
  const now = nowIST();
  res.json({
    today: now.date,
    defaultDate: now.minutes >= 17 * 60 + 30 ? addDays(now.date, 1) : now.date,
    maxDate: addDays(now.date, BOOKING_DAYS_AHEAD),
    slots: SLOTS.map(s => ({ value: s, label: slotLabel(s) })),
  });
});

app.get('/api/slots', async (req, res) => {
  const date = String(req.query.date || '');
  const now = nowIST();
  if (!validDateStr(date)) return res.status(400).json({ error: 'Choose a valid date.' });
  if (date < now.date || date > addDays(now.date, BOOKING_DAYS_AHEAD)) {
    return res.json({ date, slots: [] });
  }
  try {
    const { rows } = await pool.query(
      `SELECT slot_time FROM tickets WHERE slot_date = $1 AND status = 'open'`, [date]);
    const taken = new Set(rows.map(r => r.slot_time));
    const slots = SLOTS
      .filter(s => !taken.has(s) && slotIsInFuture(date, s))
      .map(s => ({ value: s, label: slotLabel(s) }));
    res.json({ date, slots });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load time slots. Please try again.' });
  }
});

app.post('/api/tickets', async (req, res) => {
  if (!rateLimit('t:' + req.ip, 8, 3600000)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  let { name, phone, description, date, slot } = req.body || {};
  name = String(name || '').trim().replace(/\s+/g, ' ');
  phone = String(phone || '').replace(/[^\d]/g, '');
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);
  description = String(description || '').trim();
  date = String(date || '');
  slot = String(slot || '');

  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
  if (description.length > 1000) return res.status(400).json({ error: 'Keep the complaint under 1000 characters.' });
  if (!validDateStr(date)) return res.status(400).json({ error: 'Choose a valid date.' });
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: 'Choose a time slot.' });
  const now = nowIST();
  if (date > addDays(now.date, BOOKING_DAYS_AHEAD)) return res.status(400).json({ error: `You can book up to ${BOOKING_DAYS_AHEAD} days ahead.` });
  if (!slotIsInFuture(date, slot)) return res.status(400).json({ error: 'That time has already passed. Choose a later slot.' });

  try {
    const open = await pool.query(
      `SELECT id FROM tickets WHERE phone = $1 AND status = 'open' ORDER BY created_at`, [phone]);
    if (open.rows.length >= MAX_OPEN_PER_PHONE) {
      return res.status(409).json({
        error: `This number already has an open ticket (${open.rows[0].id}). You can raise a new one after it is solved.`,
        existingId: open.rows[0].id,
      });
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newTicketId();
      try {
        const { rows } = await pool.query(
          `INSERT INTO tickets (id, name, phone, description, slot_date, slot_time)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [id, name, phone, description, date, slot]);
        return res.status(201).json({ ticket: rowToTicket(rows[0]) });
      } catch (e) {
        if (e.code === '23505' && /open_slot/.test(e.constraint || '')) {
          return res.status(409).json({ error: 'Sorry, someone just booked this slot. Please pick another time.', slotTaken: true });
        }
        if (e.code === '23505') continue; // ticket id collision, retry
        throw e;
      }
    }
    res.status(500).json({ error: 'Could not create the ticket. Please try again.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create the ticket. Please try again.' });
  }
});

// Customer status check: needs ticket ID + phone
app.post('/api/tickets/status', async (req, res) => {
  if (!rateLimit('s:' + req.ip, 30, 3600000)) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  const id = String((req.body || {}).id || '').trim().toUpperCase();
  let phone = String((req.body || {}).phone || '').replace(/[^\d]/g, '').slice(-10);
  try {
    const { rows } = await pool.query(`SELECT * FROM tickets WHERE id = $1 AND phone = $2`, [id, phone]);
    if (!rows.length) return res.status(404).json({ error: 'No ticket found with that ID and mobile number.' });
    const t = rowToTicket(rows[0]);
    res.json({ ticket: { id: t.id, name: t.name, date: t.date, slotLabel: t.slotLabel, status: t.status, createdAt: t.createdAt, solvedAt: t.solvedAt } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not check status. Please try again.' });
  }
});

// ---------- Admin auth (signed cookie) ----------
function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function requireAdmin(req, res, next) {
  if (verify(getCookie(req, 'lfs_admin'))) return next();
  res.status(401).json({ error: 'Please sign in.' });
}

app.post('/api/admin/login', (req, res) => {
  if (!rateLimit('l:' + req.ip, 10, 900000)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  const pw = String((req.body || {}).password || '');
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong password.' });
  const token = sign({ role: 'admin', exp: Date.now() + 7 * 24 * 3600 * 1000 });
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `lfs_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}${secure}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', 'lfs_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/tickets', requireAdmin, async (req, res) => {
  const status = ['open', 'solved'].includes(req.query.status) ? req.query.status : null;
  try {
    const { rows } = await pool.query(
      status === 'solved'
        ? `SELECT * FROM tickets WHERE status = 'solved' ORDER BY solved_at DESC NULLS LAST LIMIT 500`
        : status === 'open'
          ? `SELECT * FROM tickets WHERE status = 'open' ORDER BY slot_date, slot_time`
          : `SELECT * FROM tickets ORDER BY created_at DESC LIMIT 500`);
    const counts = await pool.query(`
      SELECT
        count(*) FILTER (WHERE status='open') AS open,
        count(*) FILTER (WHERE status='solved') AS solved,
        count(*) FILTER (WHERE status='open' AND slot_date = $1) AS today
      FROM tickets`, [nowIST().date]);
    res.json({
      tickets: rows.map(rowToTicket),
      counts: { open: +counts.rows[0].open, solved: +counts.rows[0].solved, today: +counts.rows[0].today },
      today: nowIST().date,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load tickets.' });
  }
});

app.post('/api/admin/tickets/:id/solve', requireAdmin, async (req, res) => {
  const note = String((req.body || {}).note || '').trim().slice(0, 1000);
  try {
    const { rows } = await pool.query(
      `UPDATE tickets SET status='solved', solved_at=now(), admin_note=$2
       WHERE id=$1 AND status='open' RETURNING *`, [req.params.id, note]);
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found or already solved.' });
    res.json({ ticket: rowToTicket(rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update the ticket.' });
  }
});

// Reopen only if its slot is still free
app.post('/api/admin/tickets/:id/reopen', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE tickets SET status='open', solved_at=NULL WHERE id=$1 AND status='solved' RETURNING *`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found or already open.' });
    res.json({ ticket: rowToTicket(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That slot has been booked by someone else, so this ticket cannot be reopened.' });
    console.error(e);
    res.status(500).json({ error: 'Could not update the ticket.' });
  }
});

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- Pages ----------
const pub = __dirname;
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(pub, 'style.css'), { maxAge: '1h' }));
app.use((req, res) => res.redirect('/'));

initDb()
  .then(() => app.listen(PORT, () => console.log(`lfsupport running on :${PORT}`)))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
