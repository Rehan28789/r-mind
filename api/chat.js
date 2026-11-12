// =====================================================================
//  R-Mind backend (Vercel serverless function)  -  /api/chat
//  Needs ONE secret in Vercel > Settings > Environment Variables:
//      GROQ_API_KEY
// =====================================================================

// ---------- Settings you may want to change ----------
// Firebase WEB API key (same apiKey as in index.html). It is a public identifier, not a secret.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCiuSsBScIA4BIQtziLfanhULx3nX0NMvQ';

const TEXT_MODEL        = 'openai/gpt-oss-120b';
const BACKUP_TEXT_MODEL = 'openai/gpt-oss-20b';   // used automatically if the main text model is rate-limited or unavailable
const IMAGE_MODEL       = 'qwen/qwen3.8-27b';     // used only when an image is attached
const TITLE_MODEL       = 'openai/gpt-oss-20b';   // writes short chat names

const MAX_MESSAGES_PER_HOUR = 30;   // per user
const MAX_TITLES_PER_HOUR   = 30;   // per user (chat-name requests are counted separately)
const MAX_HISTORY           = 12;   // only the last N messages are sent to the AI (keeps you under Groq's token limits)
const MAX_MESSAGE_CHARS     = 8000; // a single message longer than this is cut

const HOUR = 60 * 60 * 1000;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// NOTE: these counters live in the memory of a running server instance. On Vercel's free plan that is
// "best effort" (a cold start resets them). It stops casual abuse; a database would make it exact.
const messageHits = new Map(); // uid -> [timestamps]
const titleHits = new Map();
const verifiedUsers = new Map(); // login token -> { uid, until }  (avoids asking Firebase on every message)

// ---------- Helpers ----------
async function checkUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, code: 401 };

  const cached = verifiedUsers.get(token);
  if (cached && cached.until > Date.now()) return { ok: true, uid: cached.uid };

  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token })
  });
  if (!r.ok) return { ok: false, code: 401 };

  const data = await r.json();
  const user = data.users && data.users[0];
  if (!user || user.disabled) return { ok: false, code: 401 };
  if (!user.emailVerified) return { ok: false, code: 403 }; // email accounts must verify their email first

  if (verifiedUsers.size > 500) verifiedUsers.clear();
  verifiedUsers.set(token, { uid: user.localId, until: Date.now() + 5 * 60 * 1000 });
  return { ok: true, uid: user.localId };
}

function takeSlot(store, uid, limit) {
  const now = Date.now();
  const hits = (store.get(uid) || []).filter(t => now - t < HOUR);
  if (hits.length >= limit) {
    store.set(uid, hits);
    return { ok: false, minutes: Math.max(1, Math.ceil((hits[0] + HOUR - now) / 60000)) };
  }
  hits.push(now);
  store.set(uid, hits);
  if (store.size > 2000) {
    for (const [k, v] of store) if (!v.length || now - v[v.length - 1] >= HOUR) store.delete(k);
  }
  return { ok: true, refund: () => { const h = store.get(uid); if (h && h.length) h.pop(); } };
}

// Keep only real user/assistant text, cut long ones, keep the last MAX_HISTORY, and start with a user message.
function cleanMessages(list) {
  if (!Array.isArray(list)) return [];
  let out = list
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
  out = out.slice(-MAX_HISTORY);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function systemPrompt(botName, langRule) {
  return `You are ${String(botName || 'R-Mind').slice(0, 40)}, a smart, friendly, general-purpose AI assistant made by Rehan.

LANGUAGE RULE: ${String(langRule || 'Reply in English ONLY.').slice(0, 200)}

You can help with ANY topic: general knowledge, study and homework, science, math, history, coding and tech, writing and editing, translation, business, finance and accounting, health and lifestyle (general information only), career advice, creative ideas, everyday questions, and analysing images the user uploads.

RESPONSE STYLE:
- Answer the question that was actually asked, directly and accurately.
- Match the depth to the question: short for simple questions, detailed for complex ones.
- Use ## headings, bullet points, numbered steps, and tables only when they make the answer clearer.
- Put code in code blocks. Show calculations step by step.
- Use examples when explaining concepts.
- If you are unsure or lack current information, say so honestly instead of guessing.
- Be polite and clear. Do not push the conversation toward any one subject.

If asked who made you: say Rehan created you.`;
}

function buildPayload(model, system, messages, maxTokens) {
  const isQwen = model.startsWith('qwen/');
  return {
    model,
    max_tokens: maxTokens || (isQwen ? 800 : 1500), // Qwen free tier allows ~1000 output tokens/min
    // Qwen: switch thinking off (saves output tokens). GPT-OSS: short thinking, and don't send it back.
    ...(isQwen ? { reasoning_effort: 'none' } : { reasoning_effort: 'low', include_reasoning: false }),
    messages: [{ role: 'system', content: system }, ...messages]
  };
}

async function callGroq(key, payload) {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(payload)
  });
  let data;
  try { data = await response.json(); }
  catch (e) { data = { error: { message: `Groq sent an unreadable reply (HTTP ${response.status})` } }; }
  return { response, data };
}

function needsFallback(response, data) {
  const msg = (data && data.error && data.error.message) || '';
  return response.status === 429 || response.status === 404 || response.status >= 500 ||
         /does not exist|do not have access|decommission|not found/i.test(msg);
}

function waitSeconds(data) {
  const m = /try again in ([\d.]+)s/i.exec((data && data.error && data.error.message) || '');
  return m ? Math.ceil(parseFloat(m[1])) + 1 : 15;
}

// ---------- The endpoint ----------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Health check: open https://YOUR-SITE/api/chat in a browser. Shows no secrets, only yes/no flags.
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      node: process.version,
      groqKeySet: Boolean(process.env.GROQ_API_KEY),
      loginCheckSet: !FIREBASE_API_KEY.includes('PASTE'),
      textModel: TEXT_MODEL,
      backupTextModel: BACKUP_TEXT_MODEL,
      imageModel: IMAGE_MODEL,
      messagesPerHour: MAX_MESSAGES_PER_HOUR,
      historyMessages: MAX_HISTORY
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (FIREBASE_API_KEY.includes('PASTE')) {
      return res.status(500).json({ error: 'Server login check is not set up yet (FIREBASE_API_KEY missing in chat.js).' });
    }

    // 1) Only logged-in users with a verified email may use the AI
    const user = await checkUser(req);
    if (!user.ok) {
      return res.status(user.code).json({
        error: user.code === 403 ? 'Please verify your email address first.' : 'Please log in to use R-Mind.'
      });
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not set in Vercel environment variables' });
    }

    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { messages, botName, langRule, image, mode } = body;

    const history = cleanMessages(messages);
    if (!history.length) return res.status(400).json({ error: 'No message to send.' });

    // 2) Chat-name request (optional extra; never shows an error to the user)
    if (mode === 'title') {
      if (!takeSlot(titleHits, user.uid, MAX_TITLES_PER_HOUR).ok) return res.status(200).json({ title: '' });
      const convo = history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`).join('\n');
      const { response, data } = await callGroq(GROQ_API_KEY, buildPayload(
        TITLE_MODEL,
        "You write short chat titles. Reply with ONLY a title of at most 5 words, in the same language as the User's message. No quotes, no ending punctuation, no explanation.",
        [{ role: 'user', content: `${convo}\n\nTitle:` }],
        120
      ));
      let title = response.ok ? ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '') : '';
      title = title.replace(/[*#]/g, '').replace(/\s+/g, ' ').trim()
                   .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/[.!?۔]+$/, '').slice(0, 40);
      return res.status(200).json({ title });
    }

    // 3) Normal chat message
    if (history[history.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'The last message must be from the user.' });
    }

    const slot = takeSlot(messageHits, user.uid, MAX_MESSAGES_PER_HOUR);
    if (!slot.ok) {
      return res.status(429).json({
        error: `You reached the limit of ${MAX_MESSAGES_PER_HOUR} messages per hour. Please try again in about ${slot.minutes} minute${slot.minutes === 1 ? '' : 's'}.`
      });
    }

    const hasImage = typeof image === 'string' && image.startsWith('data:image/') && image.length <= 4000000;
    const apiMessages = history.map((m, i) =>
      hasImage && i === history.length - 1
        ? { role: 'user', content: [
            { type: 'text', text: m.content || 'Describe this image in detail.' },
            { type: 'image_url', image_url: { url: image } }
          ] }
        : m
    );
    const system = systemPrompt(botName, langRule);

    let model = hasImage ? IMAGE_MODEL : TEXT_MODEL;
    let { response, data } = await callGroq(GROQ_API_KEY, buildPayload(model, system, apiMessages));

    // Backup model for text questions
    if (!hasImage && needsFallback(response, data)) {
      model = BACKUP_TEXT_MODEL;
      ({ response, data } = await callGroq(GROQ_API_KEY, buildPayload(model, system, apiMessages)));
    }

    if (response.status === 429) {
      slot.refund();
      return res.status(429).json({ error: `Too many requests right now. Please wait about ${waitSeconds(data)} seconds and try again.` });
    }
    if (!response.ok || data.error) {
      slot.refund();
      return res.status(400).json({ error: (data.error && data.error.message) || `AI service error (HTTP ${response.status})` });
    }

    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!reply.trim()) {
      slot.refund();
      return res.status(502).json({ error: 'The AI returned an empty answer. Please try again.' });
    }
    return res.status(200).json({ reply, model });

  } catch (error) {
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
