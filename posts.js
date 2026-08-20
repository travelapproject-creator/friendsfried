const router = require('express').Router();
const pool = require('../db');
const { rateImageWithClaude } = require('../ai');

// Posts for a table on a given date (defaults to today); optional seat_id includes that seat's my_vote
router.get('/table/:code', async (req, res) => {
  try {
    const tableResult = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!tableResult.rowCount) return res.status(404).json({ error: 'Table not found' });
    const date = req.query.date || null;
    const seatId = req.query.seat_id || null;
    const dateClause = date ? 'p.post_date = $2' : 'p.post_date = current_date';
    const params = date ? [tableResult.rows[0].id, date] : [tableResult.rows[0].id];
    const posts = await pool.query(
      `select p.*, s.name as seat_name, s.emoji as seat_emoji,
        (select count(*) from votes v where v.post_id=p.id and v.vote_type='praise')::int as praise_count,
        (select count(*) from votes v where v.post_id=p.id and v.vote_type='fry')::int as fry_count
       from posts p join seats s on s.id = p.seat_id
       where p.table_id=$1 and ${dateClause}
       order by p.created_at`,
      params
    );
    let rows = posts.rows;
    if (seatId) {
      const voteResult = await pool.query('select post_id, vote_type from votes where voter_seat_id=$1', [seatId]);
      const voteMap = {};
      voteResult.rows.forEach(v => { voteMap[v.post_id] = v.vote_type; });
      rows = rows.map(p => ({ ...p, my_vote: voteMap[p.id] || null }));
    }
    res.json({ posts: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// All posts for a single seat (history)
router.get('/seat/:seatId', async (req, res) => {
  try {
    const result = await pool.query(
      `select p.*,
        (select count(*) from votes v where v.post_id=p.id and v.vote_type='praise')::int as praise_count,
        (select count(*) from votes v where v.post_id=p.id and v.vote_type='fry')::int as fry_count
       from posts p where p.seat_id=$1 order by p.post_date desc`,
      [req.params.seatId]
    );
    res.json({ posts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seat posts' });
  }
});

// Create a post
router.post('/', async (req, res) => {
  const { table_id, seat_id, image_url, caption } = req.body;
  if (!table_id || !seat_id || !image_url) return res.status(400).json({ error: 'table_id, seat_id, image_url required' });
  try {
    const result = await pool.query(
      'insert into posts (table_id, seat_id, image_url, caption) values ($1,$2,$3,$4) returning *',
      [table_id, seat_id, image_url, caption || null]
    );
    let post = result.rows[0];
    try {
      const rating = await rateImageWithClaude(image_url);
      if (rating) {
        const upd = await pool.query(
          'update posts set ai_score=$1, ai_verdict=$2 where id=$3 returning *',
          [rating.score, rating.verdict, post.id]
        );
        post = upd.rows[0];
      }
    } catch (aiErr) {
      console.error('AI rating failed:', aiErr.message);
    }
    res.status(201).json({ post });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'Already posted today' });
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// Edit today's post (replace the photo; re-runs AI rating) — only the seat that posted it can edit
router.patch('/:id', async (req, res) => {
  const { image_url, seat_id } = req.body;
  if (!image_url || !seat_id) return res.status(400).json({ error: 'image_url and seat_id required' });
  try {
    const existing = await pool.query('select * from posts where id=$1', [req.params.id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Not found' });
    if (existing.rows[0].seat_id !== seat_id) return res.status(403).json({ error: 'Only the original poster can edit this' });
    const result = await pool.query('update posts set image_url=$1 where id=$2 returning *', [image_url, req.params.id]);
    let post = result.rows[0];
    try {
      const rating = await rateImageWithClaude(image_url);
      if (rating) {
        const upd = await pool.query('update posts set ai_score=$1, ai_verdict=$2 where id=$3 returning *', [rating.score, rating.verdict, post.id]);
        post = upd.rows[0];
      }
    } catch (aiErr) {
      console.error('AI rating failed:', aiErr.message);
    }
    res.json({ post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// Praise/fry a post
router.post('/:id/votes', async (req, res) => {
  const { voter_seat_id, vote_type } = req.body;
  if (!voter_seat_id || !['praise', 'fry'].includes(vote_type)) return res.status(400).json({ error: 'voter_seat_id and valid vote_type required' });
  try {
    const result = await pool.query(
      `insert into votes (post_id, voter_seat_id, vote_type) values ($1,$2,$3)
       on conflict (post_id, voter_seat_id) do update set vote_type=excluded.vote_type
       returning *`,
      [req.params.id, voter_seat_id, vote_type]
    );
    res.status(201).json({ vote: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

// Comment on a post
router.post('/:id/comments', async (req, res) => {
  const { seat_id, text } = req.body;
  if (!seat_id || !text) return res.status(400).json({ error: 'seat_id and text required' });
  try {
    const result = await pool.query(
      'insert into comments (post_id, seat_id, text) values ($1,$2,$3) returning *',
      [req.params.id, seat_id, text]
    );
    res.status(201).json({ comment: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Comments on a post
router.get('/:id/comments', async (req, res) => {
  try {
    const result = await pool.query(
      `select c.*, s.name as seat_name, s.emoji as seat_emoji from comments c
       join seats s on s.id = c.seat_id where c.post_id=$1 order by c.created_at`,
      [req.params.id]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Edit a comment
router.patch('/comments/:id', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const result = await pool.query('update comments set text=$1, edited_at=now() where id=$2 returning *', [text, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ comment: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to edit comment' });
  }
});

module.exports = router;
