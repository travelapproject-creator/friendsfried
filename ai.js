const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';

// Downloads the posted image and asks Claude to score + one-line it. Returns null if no API key set
// or anything fails — callers should treat AI rating as best-effort, never blocking a post.
async function rateImageWithClaude(imageUrl) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error('Could not fetch image for rating');
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const ext = (imageUrl.split('.').pop() || '').toLowerCase();
  const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
          { type: 'text', text: 'Rate how healthy this plate of food looks on a scale of 1-100. Then write a two-part witty verdict a friend group chat would send: first a short line on how tasty it looks, then a short funny line on what it does to your body (e.g. "Delicious. Your arteries just filed a complaint."). Each part max 8 words. Respond with ONLY JSON: {"score": <integer 1-100>, "verdict": "<text, two sentences>"}' }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error('Claude API error: ' + res.status);
  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  const score = Math.max(1, Math.min(100, Math.round(Number(parsed.score))));
  const verdict = String(parsed.verdict || '').slice(0, 140);
  return { score, verdict };
}

module.exports = { rateImageWithClaude };
