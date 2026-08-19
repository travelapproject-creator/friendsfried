const router = require('express').Router();
const pool = require('./db');

// Today's posts for a table
router.get('/table/:code', async (req, res) => {
  try {
    const tableResult = await pool.query('select * from tables where code=$1', [req.params.code.toUpperCase()]);
    if (!tableResult.rowCount) return res.status(404).json({ error: 'Table not found' });
    const posts = await pool.query(
      `select p.*, s.name as seat_name, s.emoji as seat_emoji,
        (select count(*) from votes v where v.post_id=p.id and v.vote_type='praise') as praise_count,
        (select count(*) from votes v where v.post_id=p.id and v.vote_type='fry') as fry_count
       from posts p join seats s on s.id = p.seat_id
       where p.table_id=$1 and p.post_date = current_date
       order by p.created_at`,
      [tableResult.rows[0].id]
    );
    res.json({ posts: posts.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch posts' });
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
    res.status(201).json({ post: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'Already posted today' });
    res.status(500).json({ error: 'Failed to create post' });
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

module.exports = router;
