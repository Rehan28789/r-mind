export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, botName, langRule, image } = req.body;

    // API key — replace with your actual Groq key
    const API_KEY = process.env.GROQ_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not set in Vercel environment variables' });
    }

    // Build messages array with image support
    const apiMessages = messages.map((msg, index) => {
      // If last user message and image exists, make it multimodal
      if (
        image &&
        msg.role === 'user' &&
        index === messages.length - 1
      ) {
        return {
          role: 'user',
          content: [
            { type: 'text', text: msg.content || 'Describe this image in detail.' },
            { type: 'image_url', image_url: { url: image } }
          ]
        };
      }
      return msg;
    });

    // Qwen (vision) only when an image is attached; plain text uses Llama,
    // which has much higher free-tier limits than Qwen's 1,000 output tokens/min.
    const hasImage = Boolean(image);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: hasImage ? 'qwen/qwen3.8-27b' : 'llama-3.3-70b-versatile',
        max_tokens: hasImage ? 800 : 1500, // Qwen free tier allows ~1000 output tokens/min
        ...(hasImage ? { reasoning_format: 'hidden' } : {}), // hide Qwen's thinking text
        messages: [
          {
            role: 'system',
            content: `You are ${botName || 'R-Mind'}, a smart, friendly, general-purpose AI assistant made by Rehan.

LANGUAGE RULE: ${langRule || 'Reply in English ONLY.'}

You can help with ANY topic: general knowledge, study and homework, science, math, history, coding and tech, writing and editing, translation, business, finance and accounting, health and lifestyle (general information only), career advice, creative ideas, everyday questions, and analysing images the user uploads.

RESPONSE STYLE:
- Answer the question that was actually asked, directly and accurately.
- Match the depth to the question: short for simple questions, detailed for complex ones.
- Use ## headings, bullet points, numbered steps, and tables only when they make the answer clearer.
- Put code in code blocks. Show calculations step by step.
- Use examples when explaining concepts.
- If you are unsure or lack current information, say so honestly instead of guessing.
- Be polite and clear. Do not push the conversation toward any one subject.

If asked who made you: say Rehan created you.`
          },
          ...apiMessages
        ]
      })
    });

    const data = await response.json();

    if (response.status === 429) {
      const m = /try again in ([\d.]+)s/i.exec(data?.error?.message || '');
      const wait = m ? Math.ceil(parseFloat(m[1])) + 1 : 15;
      return res.status(429).json({ error: `Too many requests right now. Please wait about ${wait} seconds and try again.` });
    }

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const reply = data.choices?.[0]?.message?.content || 'Something went wrong.';
    return res.status(200).json({ reply });

  } catch (error) {
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
