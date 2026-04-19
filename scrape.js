const https = require("https");
const http  = require("http");
const { URL } = require("url");

// Public real estate agent directories we can scrape
const TARGETS = [
  (city, state) => `https://www.yellowpages.com/search?search_terms=real+estate+agent&geo_location_terms=${encodeURIComponent(city+", "+state)}`,
  (city, state) => `https://www.yelp.com/search?find_desc=Real+Estate+Agents&find_loc=${encodeURIComponent(city+", "+state)}`,
];

function fetchUrl(rawUrl) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(rawUrl); } catch { return resolve(null); }

    const lib = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 12000,
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(null); // skip redirects
      }
      if (res.statusCode !== 200) return resolve(null);
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function extractEmails(text) {
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const bad = ["example.com","test.com","noreply.com","no-reply.com","sentry.io","w3.org","schema.org"];
  return [...new Set((text.match(re) || []).filter(e => !bad.some(b => e.includes(b))))];
}

function extractPhones(text) {
  const re = /(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g;
  return [...new Set((text.match(re) || []).filter(p => {
    const d = p.replace(/\D/g, "");
    return d.length === 10 || (d.length === 11 && d[0] === "1");
  }))];
}

function cleanName(n) {
  if (!n) return null;
  n = n.replace(/\s+/g, " ").trim();
  if (n.length < 4 || n.length > 70) return null;
  if (/^\d/.test(n)) return null;
  if (/realt(or|y)|agency|properties|group|team|inc\.|llc|homes\b|real estate|assoc|brokerage/i.test(n)) return null;
  return n;
}

function parseHTML(html, city, state, sourceUrl) {
  const leads = [];
  // Extract from JSON-LD schema blocks
  const schemaRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = schemaRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      items.forEach(item => {
        const type = item["@type"] || "";
        if (!/Person|RealEstate|LocalBusiness/.test(type)) return;
        const name = cleanName(item.name);
        if (!name) return;
        leads.push({
          name,
          email: item.email || null,
          phone: item.telephone || null,
          city: item.address?.addressLocality || city,
          state: item.address?.addressRegion || state,
          website: item.url || null,
          source: sourceUrl,
        });
      });
    } catch {}
  }

  // Extract visible text patterns for names + phones
  const phoneMatches = extractPhones(html);
  const emailMatches = extractEmails(html);

  // Business name patterns common in YP / Yelp HTML
  const nameRe = /class="[^"]*(?:business-name|biz-name|BusinessName|result-title)[^"]*"[^>]*>[\s\S]*?<[^>]*>([^<]{4,60})</gi;
  while ((m = nameRe.exec(html)) !== null) {
    const name = cleanName(m[1].replace(/&amp;/g,"&").replace(/&#\d+;/g,"").trim());
    if (!name) continue;
    leads.push({
      name,
      email: emailMatches[leads.length] || null,
      phone: phoneMatches[leads.length] || null,
      city,
      state,
      website: null,
      source: sourceUrl,
    });
    if (leads.length >= 15) break;
  }

  return leads.slice(0, 12);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { city = "Houston", state = "TX" } = req.body || {};
  const allLeads = [];

  for (const makeUrl of TARGETS) {
    const url = makeUrl(city, state);
    try {
      const html = await fetchUrl(url);
      if (html) {
        const found = parseHTML(html, city, state, url);
        allLeads.push(...found);
      }
    } catch {}
  }

  // Deduplicate by name
  const seen = new Set();
  const unique = allLeads.filter(l => {
    if (!l.name) return false;
    const k = l.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  res.status(200).json({ success: true, count: unique.length, leads: unique });
};
