const router = require('express').Router();
const pool = require('./db');

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

// Scoreboard: escalating praise/fry points (1st vote=1, 2nd=1, 3rd=2, 4th=4 — doubles from the 3rd vote on,
// same scale for Fry as negative points) plus each seat's average health score / 10.
router.get('/:code/scores', async (req, res) => {
  try {
    const tableResult = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!tableResult.rowCount) return res.status(404).json({ error: 'Table not found' });
    const result = await pool.query(
      `select s.id, s.seat_index, s.name, s.emoji,
        round(coalesce(pv.vote_score,0) + coalesce(pv.avg_health,0)/10.0, 1)::float as score
       from seats s
       left join (
         select p.seat_id,
           sum(vs.signed_pts) as vote_score,
           avg(p.ai_score) as avg_health
         from posts p
         left join (
           select post_id, vote_type,
             (case when rn=1 then 1 when rn=2 then 1 else power(2::numeric, (rn-2)::numeric) end) *
             (case when vote_type='fry' then -1 else 1 end) as signed_pts
           from (
             select post_id, vote_type,
               row_number() over (partition by post_id, vote_type order by created_at) as rn
             from votes
           ) ranked
         ) vs on vs.post_id = p.id
         group by p.seat_id
       ) pv on pv.seat_id = s.id
       where s.table_id = $1
       order by score desc`,
      [tableResult.rows[0].id]
    );
    res.json({ scores: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

module.exports = router;
