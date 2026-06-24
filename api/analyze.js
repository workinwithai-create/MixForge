// api/analyze.js
// Vercel serverless function — proxies the Claude API call from MixForge.
// The ANTHROPIC_API_KEY lives as a Vercel environment variable, never in
// browser code. The browser POSTs measurements here; we forward to Claude
// and return the chain/diagnosis JSON.

export default async function handler(req, res) {
  // CORS — allow your MixForge domains
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set in Vercel environment variables');

    const { prompt } = req.body;
    if (!prompt) throw new Error('No prompt provided');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    if (!data.content || !Array.isArray(data.content)) throw new Error('Unexpected Claude response');

    const text = data.content.map(b => b.type === 'text' ? b.text : '').join('');
    return res.status(200).json({ ok: true, text });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }
}
