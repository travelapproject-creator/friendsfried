const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';

// Downloads the posted image and asks Claude to name the dish and give a 0-10 healthiness read to one
// decimal (e.g. 7.4). That score
// is the plate's BASE score; each praise/fry vote then moves it by 1 (clamped 0-10). Returns null if no API
// key is set or the response can't be parsed — callers treat this as best-effort, never blocking a post.
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
          { type: 'text', text: 'Look at this plate of food. Name the dish in 5 words or fewer, based on what you actually see. Then name the dish and give it a precise 0-10 score for how healthy/nutritious/balanced it looks, to ONE decimal place (e.g. 7.4, 3.8, 6.1). Use the decimal to be exact — do not default to round numbers. Then write a short, plain, factual one-line reason describing what you see on the plate. No jokes, no wordplay, no addressing the eater directly. Max 20 words for the reason.' + (note ? ' The poster says the photo shows: "' + note + '" \u2014 trust this description of what the food actually is over your own visual read, for both the name and the score.' : '') + ' Respond with ONLY JSON: {"name": "<dish name>", "health": <number 0-10 with one decimal>}' }
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
  // Keep one decimal — rounding to an integer was collapsing every read onto 7 or 8.
  const health = Math.round(Math.max(0, Math.min(10, Number(parsed.health))) * 10) / 10;
  const name = String(parsed.name || '').slice(0, 60);
  return { name, health };
}

module.exports = { rateImageWithClaude };
