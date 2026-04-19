const https = require("https");

module.exports = async (req, res) => {
  // CORS headers so the browser can call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured. Add it in Vercel → Settings → Environment Variables." });
  }

  const { type, lead, sender_name, sender_company } = req.body || {};
  if (!lead) return res.status(400).json({ error: "lead is required" });

  const loc = [lead.city, lead.state].filter(Boolean).join(", ") || "their market";
  const sigs = [
    lead.email && "email",
    lead.phone && "phone",
    lead.website && "website",
    lead.youtube && "YouTube channel",
    lead.linkedin && "LinkedIn profile",
    lead.instagram && "Instagram",
  ].filter(Boolean);
  const missing = ["email","phone","website","YouTube","LinkedIn","Instagram"].filter(s => !sigs.includes(s));

  const configs = {
    summary: {
      system: "You write 2-sentence real estate lead summaries for a CRM. Be specific, professional, actionable. No markdown.",
      user: `Agent: ${lead.name}\nMarket: ${loc}\nScore: ${lead.score}/10\nContact signals: ${sigs.join(", ") || "none"}\nSource: ${lead.source || "unknown"}`,
      max_tokens: 150,
    },
    explain: {
      system: "Explain this lead score in exactly 2 direct sentences. Be specific about what is present and what is missing. No markdown.",
      user: `Score: ${lead.score}/10\nHas: ${sigs.join(", ") || "none"}\nMissing: ${missing.join(", ") || "none"}`,
      max_tokens: 120,
    },
    outreach: {
      system: "Write a short, warm, personalized cold outreach email for a real estate referral partnership. Exactly 3 paragraphs. Professional but human. No markdown. No subject line. Email body only. End with a clear CTA for a 15-minute call.",
      user: `Recipient: ${lead.name}, agent in ${loc}\nWebsite: ${lead.website || "N/A"}\nSender: ${sender_name || "Your Name"} at ${sender_company || "Your Company"}`,
      max_tokens: 450,
    },
    subject: {
      system: "Write exactly 3 cold email subject lines, each on its own line. No numbers, no dashes, no markdown.",
      user: `Reaching out to real estate agent ${lead.name} in ${loc} about referral partnership.`,
      max_tokens: 80,
    },
  };

  const cfg = configs[type];
  if (!cfg) return res.status(400).json({ error: `Unknown type: ${type}` });

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: cfg.max_tokens,
    system: cfg.system,
    messages: [{ role: "user", content: cfg.user }],
  });

  return new Promise((resolve) => {
    const options = {
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = "";
      apiRes.on("data", chunk => (data += chunk));
      apiRes.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            res.status(400).json({ error: parsed.error.message });
          } else {
            const text = parsed.content?.[0]?.text?.trim() || "";
            res.status(200).json({ success: true, text });
          }
        } catch (e) {
          res.status(500).json({ error: "Failed to parse AI response" });
        }
        resolve();
      });
    });

    apiReq.on("error", (e) => {
      res.status(500).json({ error: e.message });
      resolve();
    });

    apiReq.write(body);
    apiReq.end();
  });
};
