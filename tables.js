const router = require('express').Router();
const pool = require('./db');

// Idempotent migration on boot: scores_reset_at marks the point the host last reset the game. The
// scoreboard only counts plates posted at or after it, so a reset is non-destructive — old plates stay
// visible in each chair's history.
(async () => {
  try {
    await pool.query('alter table tables add column if not exists scores_reset_at timestamptz');
    console.log('[migrate] tables.scores_reset_at ensured');
  } catch (e) { console.error('[migrate] scores_reset_at -> ' + e.message); }
})();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Create a table + host seat
router.post('/', async (req, res) => {
  const { group_name, host_name, host_emoji } = req.body;
  if (!group_name || !host_name) return res.status(400).json({ error: 'group_name and host_name required' });
  try {
    let code, exists = true;
    while (exists) {
      code = genCode();
      const check = await pool.query('select 1 from tables where code=$1', [code]);
      exists = check.rowCount > 0;
    }
    const tableResult = await pool.query(
      'insert into tables (code, group_name) values ($1,$2) returning *',
      [code, group_name]
    );
    const table = tableResult.rows[0];
    const seatResult = await pool.query(
      'insert into seats (table_id, seat_index, name, emoji, is_host) values ($1,0,$2,$3,true) returning *',
      [table.id, host_name, host_emoji || null]
    );
    res.status(201).json({ table, seat: seatResult.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create table' });
  }
});

// Find table by code
router.get('/:code', async (req, res) => {
  try {
    const tableResult = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!tableResult.rowCount) return res.status(404).json({ error: 'Table not found' });
    const table = tableResult.rows[0];
    const seats = await pool.query('select * from seats where table_id=$1 order by seat_index', [table.id]);
    res.json({ table, seats: seats.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch table' });
  }
});

// Join/claim a seat
router.post('/:code/seats', async (req, res) => {
  const { name, emoji, seat_index } = req.body;
  if (!name || seat_index == null) return res.status(400).json({ error: 'name and seat_index required' });
  try {
    const tableResult = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!tableResult.rowCount) return res.status(404).json({ error: 'Table not found' });
    const table = tableResult.rows[0];
    const seatResult = await pool.query(
      'insert into seats (table_id, seat_index, name, emoji) values ($1,$2,$3,$4) returning *',
      [table.id, seat_index, name, emoji || null]
    );
    res.status(201).json({ seat: seatResult.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'Seat already taken' });
    res.status(500).json({ error: 'Failed to join seat' });
  }
});

// Remove/free a seat
router.delete('/:code/seats/:seatIndex', async (req, res) => {
  try {
    const tableResult = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!tableResult.rowCount) return res.status(404).json({ error: 'Table not found' });
    await pool.query('delete from seats where table_id=$1 and seat_index=$2', [tableResult.rows[0].id, req.params.seatIndex]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove seat' });
  }
});

// How many completed weeks each seat finished with the lowest average (i.e. was Fry of the Week).
// The in-progress week is excluded — it isn't decided yet. date_trunc('week') starts Monday in Postgres.
router.get('/:code/fry-counts', async (req, res) => {
  try {
    const t = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!t.rowCount) return res.status(404).json({ error: 'Table not found' });
    const result = await pool.query(
      `with vote_pts as (
        select post_id, (case when vote_type='fry' then -1 else 1 end) as signed_pts from votes
      ),
      post_adjusted as (
        select p.id, p.seat_id, p.post_date,
          greatest(0, least(10, coalesce(p.ai_health,6) + coalesce(sum(vp.signed_pts),0))) as adjusted_score
        from posts p
        left join vote_pts vp on vp.post_id = p.id
        group by p.id, p.seat_id, p.post_date
      ),
      weekly as (
        select pa.seat_id, date_trunc('week', pa.post_date) as wk, avg(pa.adjusted_score) as avg_score
        from post_adjusted pa
        join seats s on s.id = pa.seat_id
        where s.table_id = $1 and date_trunc('week', pa.post_date) < date_trunc('week', now())
        group by pa.seat_id, wk
      ),
      ranked as (
        select wk, seat_id, avg_score, min(avg_score) over (partition by wk) as wk_min from weekly
      )
      select seat_id, count(*)::int as fry_weeks
      from ranked where avg_score = wk_min
      group by seat_id`,
      [t.rows[0].id]
    );
    res.json({ counts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch fry counts' });
  }
});

// Reset the game. Host only (seat_index 0) — verified server-side, since the client can be edited.
// Non-destructive: stamps scores_reset_at, so the scoreboard starts fresh while old plates stay in history.
router.post('/:code/reset-scores', async (req, res) => {
  const { seat_id } = req.body;
  if (!seat_id) return res.status(400).json({ error: 'Missing seat_id' });
  try {
    const t = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!t.rowCount) return res.status(404).json({ error: 'Table not found' });
    const seat = await pool.query('select seat_index from seats where id=$1 and table_id=$2', [seat_id, t.rows[0].id]);
    if (!seat.rowCount) return res.status(404).json({ error: 'Seat not found at this table' });
    if (seat.rows[0].seat_index !== 0) return res.status(403).json({ error: 'Only the host can reset scores' });
    const updated = await pool.query('update tables set scores_reset_at=now() where id=$1 returning scores_reset_at', [t.rows[0].id]);
    res.json({ scores_reset_at: updated.rows[0].scores_reset_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reset scores' });
  }
});

// Scoreboard: each seat's score is the average of their plates' friend-adjusted scores — the AI health
// read (0-10) is each plate's base, then 1 point per praise (up) or judge (down), clamped 0-10. Sorted
// lowest first, so whoever is at the top has the lowest average.
// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD windows it to one week; omit both for all-time.
// A host reset (scores_reset_at) always applies on top of the window.
router.get('/:code/scores', async (req, res) => {
  try {
    const tableResult = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!tableResult.rowCount) return res.status(404).json({ error: 'Table not found' });
    const result = await pool.query(
      `with vote_pts as (
        select post_id, (case when vote_type='fry' then -1 else 1 end) as signed_pts
        from votes
      ),
      post_adjusted as (
        select p.id, p.seat_id,
          greatest(0, least(10, coalesce(p.ai_health,6) + coalesce(sum(vp.signed_pts),0))) as adjusted_score
        from posts p
        left join vote_pts vp on vp.post_id = p.id
        where p.created_at >= coalesce($2::timestamptz, '-infinity'::timestamptz)
          and ($3::date is null or p.post_date >= $3::date)
          and ($4::date is null or p.post_date <= $4::date)
        group by p.id, p.seat_id
      )
      select s.id, s.seat_index, s.name, s.emoji,
        round(coalesce(avg(pa.adjusted_score),6),1)::float as score
      from seats s
      left join post_adjusted pa on pa.seat_id = s.id
      where s.table_id = $1
      group by s.id
      order by score asc`,
      [tableResult.rows[0].id, tableResult.rows[0].scores_reset_at || null, req.query.from || null, req.query.to || null]
    );
    res.json({ scores: result.rows, scores_reset_at: tableResult.rows[0].scores_reset_at || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

module.exports = router;
