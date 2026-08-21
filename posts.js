const router = require('express').Router();
const pool = require('./db');
const { rateImageWithClaude } = require('./ai');

// Idempotent migration on boot: older databases predate these columns, and without them every
// rating write fails silently. Safe to run on every start.
(async () => {
  const cols = [
    "alter table posts add column if not exists ai_verdict text",
    "alter table posts add column if not exists poster_note text",
    "alter table posts add column if not exists ai_health int",
    "alter table posts add column if not exists ai_score int"
  ];
  for (const sql of cols) {
    try { await pool.query(sql); } catch (e) { console.error('[migrate] ' + sql + ' -> ' + e.message); }
  }
  console.log('[migrate] posts AI columns ensured');
})();

// Diagnostic: open /api/posts/ai-status in a browser to see why rating is or isn't working.
// Pass ?image_url=<absolute url of a posted plate> to run a real end-to-end rating attempt.
router.get('/ai-status', async (req, res) => {
  const out = {
    api_key_present: !!process.env.ANTHROPIC_API_KEY,
    public_url: process.env.PUBLIC_URL || '(not set - uploads fall back to the request host)'
  };
  if (!out.api_key_present) {
    out.problem = 'ANTHROPIC_API_KEY is not set in the server environment. Set it and restart the server.';
    return res.json(out);
  }
  if (!req.query.image_url) {
    // No URL supplied — grab the most recent post and test that, so this works with a bare URL.
    try {
      const recent = await pool.query('select id, image_url, ai_health, ai_verdict, created_at from posts order by created_at desc limit 1');
      if (!recent.rowCount) {
        out.problem = 'No posts in the database yet — post a plate first, then reload this.';
        return res.json(out);
      }
      out.tested_post = { id: recent.rows[0].id, image_url: recent.rows[0].image_url, stored_ai_health: recent.rows[0].ai_health, stored_ai_verdict: recent.rows[0].ai_verdict };
      req.query.image_url = recent.rows[0].image_url;
    } catch (e) {
      out.problem = 'Could not read posts table: ' + e.message;
      return res.json(out);
    }
  }
  try {
    const rating = await rateImageWithClaude(req.query.image_url);
    out.rating = rating;
    out.result = rating ? 'Rating succeeded.' : 'Call returned no parsable rating.';
  } catch (e) {
    out.result = 'Rating threw an error.';
    out.error = e.message;
  }
  res.json(out);
});

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
        (select count(*) from votes v where v.post_id=p.id and v.vote_type='fry')::int as fry_count,
        greatest(0, least(10, coalesce(p.ai_health,6) + coalesce(praise_count,0) - coalesce(fry_count,0)))::numeric(3,1) as adjusted_score
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
        (select count(*) from votes v where v.post_id=p.id and v.vote_type='fry')::int as fry_count,
        greatest(0, least(10,
          coalesce(p.ai_health,6)
          + (select count(*) from votes v where v.post_id=p.id and v.vote_type='praise')
          - (select count(*) from votes v where v.post_id=p.id and v.vote_type='fry')
        ))::numeric(3,1) as adjusted_score
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
          'update posts set ai_health=$1, ai_verdict=$2 where id=$3 returning *',
          [rating.health, rating.verdict, post.id]
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
        const upd = await pool.query('update posts set ai_health=$1, ai_verdict=$2 where id=$3 returning *', [rating.health, rating.verdict, post.id]);
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

// Poster flags the AI got it wrong and describes what's actually on the plate — re-rates using that context
router.post('/:id/recheck', async (req, res) => {
  const { seat_id, note } = req.body;
  if (!seat_id || !note) return res.status(400).json({ error: 'seat_id and note required' });
  try {
    const postResult = await pool.query('select * from posts where id=$1', [req.params.id]);
    if (!postResult.rowCount) return res.status(404).json({ error: 'Post not found' });
    const post = postResult.rows[0];
    if (post.seat_id !== seat_id) return res.status(403).json({ error: 'Only the poster can correct this' });
    const rating = await rateImageWithClaude(post.image_url, note.slice(0, 300));
    if (!rating) return res.status(502).json({ error: 'Re-rating unavailable right now' });
    const upd = await pool.query(
      'update posts set ai_health=$1, ai_verdict=$2, poster_note=$3 where id=$4 returning *',
      [rating.health, rating.verdict, note.slice(0, 300), req.params.id]
    );
    res.json({ post: upd.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to re-check post' });
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
