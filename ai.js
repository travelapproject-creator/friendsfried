const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';

// Downloads the posted image and asks Claude for a 0-10 healthiness read. That score is the plate's
// BASE score; each praise/fry vote then moves it by 1 (clamped 0-10). Returns null if no API key is set
// or the response can't be parsed — callers treat this as best-effort, never blocking a post.
async function rateImageWithClaude(imageUrl, note) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[ai] ANTHROPIC_API_KEY is not set — plates will post with no health score.');
    return null;
  }
  let imgRes;
  // Defensive: older posts may hold a relative path. Node's fetch requires an absolute URL.
  let fetchUrl = imageUrl;
  if (/^\//.test(imageUrl)) {
    const base = process.env.PUBLIC_URL || 'http://localhost:' + (process.env.PORT || 3000);
    fetchUrl = base.replace(/\/$/, '') + imageUrl;
  }
  try {
    imgRes = await fetch(fetchUrl);
  } catch (e) {
    throw new Error('Server could not reach image URL (' + fetchUrl + '): ' + e.message);
  }
  if (!imgRes.ok) throw new Error('Could not fetch image for rating: HTTP ' + imgRes.status + ' from ' + fetchUrl);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const ext = (fetchUrl.split('?')[0].split('.').pop() || '').toLowerCase();
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
          { type: 'text', text: 'Give this plate of food a 0-10 score for how healthy/nutritious/balanced it looks. Then write a short, plain, factual one-line reason describing what you actually see on the plate. No jokes, no wordplay, no addressing the eater directly. Max 20 words.' + (note ? ' The poster says the photo shows: "' + note + '" \u2014 trust this description of what the food actually is over your own visual read.' : '') + ' Respond with ONLY JSON: {"health": <integer 0-10>, "verdict": "<text>"}' }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error('Claude API error ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[ai] No JSON found in model reply:', text.slice(0, 200));
    return null;
  }
  const parsed = JSON.parse(match[0]);
  const health = Math.max(0, Math.min(10, Math.round(Number(parsed.health))));
  const verdict = String(parsed.verdict || '').slice(0, 180);
  return { health, verdict };
}

module.exports = { rateImageWithClaude };
