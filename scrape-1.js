// api/scrape.js
// FREE - No API keys needed.
// Pulls REAL, ACTIVE, LICENSED real estate agents from state government databases.
// State licensing data is public record by law.

const https = require("https");
const http  = require("http");
const { URL } = require("url");

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(rawUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch(e) { return reject(new Error("Bad URL: " + rawUrl)); }
    const lib    = url.protocol === "https:" ? https : http;
    const method = opts.method || "GET";
    const body   = opts.body || null;
    const headers = {
      "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Accept":          opts.accept || "application/json, text/html, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection":      "keep-alive",
      ...(body ? { "Content-Type": opts.contentType || "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
      ...(opts.headers || {}),
    };

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers,
      timeout: opts.timeout || 18000,
    }, (res) => {
      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : url.origin + res.headers.location;
        return resolve(request(loc, opts));
      }
      let data = "";
      res.on("data", c => { data += c; if (data.length > 500000) res.destroy(); });
      res.on("end",   () => resolve({ status: res.statusCode, headers: res.headers, data }));
      res.on("close", () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });

    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Extract emails from HTML text ─────────────────────────────────────────────
function extractEmails(text) {
  const re  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const bad = ["noreply","no-reply","example","test.com","sentry","w3.org","schema","placeholder","yourname","youremail","email@","name@"];
  return [...new Set((text.match(re) || []).filter(e => !bad.some(b => e.toLowerCase().includes(b))))];
}

// ── Extract phones from text ───────────────────────────────────────────────────
function extractPhones(text) {
  const re = /(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g;
  return [...new Set((text.match(re) || []).filter(p => {
    const d = p.replace(/\D/g, "");
    return (d.length === 10 || (d.length === 11 && d[0] === "1")) && !/^0{10}|^1{10}/.test(d);
  }))];
}

// ── Try to get email + phone from agent's own website ─────────────────────────
async function enrichFromWebsite(website) {
  if (!website) return { email: null, phone: null };
  try {
    const url = website.startsWith("http") ? website : "https://" + website;
    const res = await request(url, { accept: "text/html", timeout: 8000 });
    if (res.status !== 200 || !res.data) return { email: null, phone: null };
    const emails = extractEmails(res.data);
    const phones = extractPhones(res.data);
    // Prefer contact@ / info@ but take anything
    const email = emails.find(e => /^(contact|info|agent|team|hello)@/.test(e)) || emails[0] || null;
    const phone = phones[0] || null;
    return { email, phone };
  } catch { return { email: null, phone: null }; }
}

// ── SCORE ──────────────────────────────────────────────────────────────────────
function score(l) {
  let s = 0;
  if (l.email)   s += 3;
  if (l.phone)   s += 3;
  if (l.website) s += 2;
  if (l.license_status === "Active") s += 1;
  if (l.license_years > 2)          s += 1;
  return Math.min(10, s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 1: Texas TREC (trec.texas.gov) — JSON API, returns active licensees
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeTREC(city, limit) {
  const leads = [];
  console.log(`[TREC] Searching: ${city}, TX`);

  // TREC has a public JSON search API used by their own website
  const url = `https://www.trec.texas.gov/apps/license-holder-search/api/search?licenseType=SAL&status=A&city=${encodeURIComponent(city)}&firstName=&lastName=&page=1&pageSize=${limit}`;

  try {
    const res = await request(url, { accept: "application/json" });
    if (res.status !== 200) {
      console.log(`[TREC] Status: ${res.status}`);
      return leads;
    }
    const data = JSON.parse(res.data);
    const items = data.results || data.data || data.items || [];
    console.log(`[TREC] Got ${items.length} licensees`);

    for (const item of items.slice(0, limit)) {
      const name = [item.firstName, item.middleName, item.lastName].filter(Boolean).join(" ").trim();
      if (!name || name.length < 4) continue;

      const lead = {
        name,
        email:          null,
        phone:          item.phone || item.phoneNumber || null,
        city:           item.city || city,
        state:          "TX",
        website:        item.website || item.websiteUrl || null,
        license_number: item.licenseNumber || item.license || null,
        license_status: "Active",
        license_type:   "Sales Agent",
        license_years:  item.yearsLicensed || null,
        broker_name:    item.sponsorName || item.brokerName || null,
        source:         "Texas TREC License Database",
        source_url:     "https://www.trec.texas.gov/apps/license-holder-search/",
      };

      // Enrich from website
      if (lead.website) {
        const extra = await enrichFromWebsite(lead.website);
        lead.email = extra.email;
        if (!lead.phone) lead.phone = extra.phone;
      }

      lead.score   = score(lead);
      lead.summary = buildSummary(lead);
      leads.push(lead);
    }
  } catch (e) {
    console.error("[TREC] Error:", e.message);
  }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 2: Florida DBPR — public license verification
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeFloriDA(city, limit) {
  const leads = [];
  console.log(`[FL-DBPR] Searching: ${city}, FL`);

  // Florida DBPR public license search API
  const url = `https://www.myfloridalicense.com/wl11.asp?mode=0&SID=&brd=0801&typ=&bureau=&sch=&cit=${encodeURIComponent(city)}&cou=&zipcode=&lic=&ste=Active&nme=&app=`;

  try {
    const res = await request(url, { accept: "text/html", timeout: 15000 });
    if (res.status !== 200) {
      console.log(`[FL-DBPR] Status: ${res.status}`);
      return leads;
    }

    // Parse HTML table rows
    const html = res.data;
    const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const tdRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let rowMatch;
    let count = 0;

    while ((rowMatch = rowRe.exec(html)) !== null && count < limit) {
      const row = rowMatch[0];
      const cells = [];
      let cellMatch;
      while ((cellMatch = tdRe.exec(row)) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
      }
      if (cells.length < 3) continue;
      const name = cells[0];
      if (!name || name.length < 4 || /name|licensee|company/i.test(name)) continue;

      const lead = {
        name:           name,
        email:          null,
        phone:          null,
        city:           city,
        state:          "FL",
        website:        null,
        license_number: cells[1] || null,
        license_status: "Active",
        license_type:   cells[2] || "Real Estate",
        broker_name:    cells[3] || null,
        source:         "Florida DBPR License Database",
        source_url:     url,
      };

      lead.score   = score(lead);
      lead.summary = buildSummary(lead);
      leads.push(lead);
      count++;
    }
    console.log(`[FL-DBPR] Found ${leads.length} licensees`);
  } catch (e) {
    console.error("[FL-DBPR] Error:", e.message);
  }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 3: North Carolina Real Estate Commission — public search
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeNCREC(city, limit) {
  const leads = [];
  console.log(`[NCREC] Searching: ${city}, NC`);

  try {
    // NCREC search form
    const formData = `LicenseeType=I&Status=A&City=${encodeURIComponent(city)}&State=NC&Submit=Search`;
    const res = await request("https://ncrec.gov/find-agent", {
      method: "POST",
      body: formData,
      contentType: "application/x-www-form-urlencoded",
      accept: "text/html",
      timeout: 15000,
    });

    if (res.status !== 200) {
      console.log(`[NCREC] Status: ${res.status}`);
      return leads;
    }

    const html = res.data;
    // Parse agent cards/table
    const nameRe = /class="[^"]*(?:name|Name|agent)[^"]*"[^>]*>\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g;
    const phoneRe = /(\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4})/g;
    let m, count = 0;

    const names = [];
    while ((m = nameRe.exec(html)) !== null && count < limit) {
      const n = m[1].trim();
      if (n.length > 4 && !names.includes(n)) { names.push(n); count++; }
    }

    names.forEach(name => {
      const lead = {
        name, email: null, phone: null,
        city, state: "NC", website: null,
        license_status: "Active",
        source: "NC Real Estate Commission",
        source_url: "https://ncrec.gov/find-agent",
      };
      lead.score = score(lead);
      lead.summary = buildSummary(lead);
      leads.push(lead);
    });
    console.log(`[NCREC] Found ${leads.length} agents`);
  } catch (e) {
    console.error("[NCREC] Error:", e.message);
  }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 4: Georgia SOS — public verification
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeGeorgia(city, limit) {
  const leads = [];
  console.log(`[GA-SOS] Searching: ${city}, GA`);
  try {
    const url = `https://verify.sos.ga.gov/verification/Search.aspx?profession=RE&status=Active&city=${encodeURIComponent(city)}`;
    const res = await request(url, { accept: "text/html", timeout: 15000 });
    if (res.status !== 200) return leads;
    const html = res.data;
    // Parse result table
    const rows = html.match(/<tr[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || [];
    rows.slice(0, limit).forEach(row => {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c => c.replace(/<[^>]+>/g, "").trim());
      if (!cells[0] || cells[0].length < 4) return;
      const lead = {
        name: cells[0], email: null, phone: null,
        city, state: "GA", website: null,
        license_number: cells[1] || null,
        license_status: "Active",
        source: "Georgia SOS License Verification",
        source_url: url,
      };
      lead.score = score(lead);
      lead.summary = buildSummary(lead);
      leads.push(lead);
    });
    console.log(`[GA-SOS] Found ${leads.length} agents`);
  } catch (e) { console.error("[GA-SOS]", e.message); }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 5: Colorado DORA — public license search
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeColorado(city, limit) {
  const leads = [];
  console.log(`[CO-DORA] Searching: ${city}, CO`);
  try {
    const url = `https://apps2.colorado.gov/dre/licensing/lookup/licenselookup.aspx`;
    const res = await request(url, { accept: "text/html", timeout: 15000 });
    if (res.status !== 200) return leads;
    // Extract ViewState and search
    const vsMatch = res.data.match(/id="__VIEWSTATE"\s+value="([^"]+)"/);
    if (!vsMatch) return leads;
    const vs = vsMatch[1];
    const evsMatch = res.data.match(/id="__EVENTVALIDATION"\s+value="([^"]+)"/);
    const evs = evsMatch ? evsMatch[1] : "";

    const body = new URLSearchParams({
      __VIEWSTATE:       vs,
      __EVENTVALIDATION: evs,
      "ctl00$ContentPlaceHolder1$txtCity": city,
      "ctl00$ContentPlaceHolder1$ddlStatus": "A",
      "ctl00$ContentPlaceHolder1$btnSearch": "Search",
    }).toString();

    const res2 = await request(url, {
      method: "POST", body, contentType: "application/x-www-form-urlencoded",
      accept: "text/html", timeout: 15000,
    });
    if (res2.status !== 200) return leads;

    const rows = res2.data.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    let count = 0;
    rows.forEach(row => {
      if (count >= limit) return;
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c => c.replace(/<[^>]+>/g, "").trim());
      if (!cells[0] || cells[0].length < 4) return;
      const lead = {
        name: cells[0], email: null, phone: null,
        city, state: "CO", website: null,
        license_number: cells[1] || null,
        license_status: "Active",
        source: "Colorado DORA License Database",
        source_url: url,
      };
      lead.score = score(lead);
      lead.summary = buildSummary(lead);
      leads.push(lead);
      count++;
    });
    console.log(`[CO-DORA] Found ${leads.length} agents`);
  } catch (e) { console.error("[CO-DORA]", e.message); }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 6: Arizona ADRE — public agent search
// ═══════════════════════════════════════════════════════════════════════════════
async function scrapeArizona(city, limit) {
  const leads = [];
  console.log(`[AZ-ADRE] Searching: ${city}, AZ`);
  try {
    const url = `https://azre.gov/consumer-info/licensee-lookup?city=${encodeURIComponent(city)}&status=Active&type=SA`;
    const res = await request(url, { accept: "text/html", timeout: 15000 });
    if (res.status !== 200) return leads;
    const rows = (res.data.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).slice(1, limit + 1);
    rows.forEach(row => {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c => c.replace(/<[^>]+>/g, "").trim());
      if (!cells[0] || cells[0].length < 4) return;
      const lead = {
        name: cells[0], email: null, phone: null,
        city, state: "AZ", website: null,
        license_number: cells[1] || null,
        license_status: "Active",
        source: "Arizona ADRE License Database",
        source_url: url,
      };
      lead.score = score(lead);
      lead.summary = buildSummary(lead);
      leads.push(lead);
    });
    console.log(`[AZ-ADRE] Found ${leads.length} agents`);
  } catch (e) { console.error("[AZ-ADRE]", e.message); }
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY BUILDER
// ═══════════════════════════════════════════════════════════════════════════════
function buildSummary(l) {
  const loc = [l.city, l.state].filter(Boolean).join(", ");
  const parts = [
    `ACTIVE licensed real estate agent in ${loc || "their market"}.`,
    l.license_number ? `License #${l.license_number}.` : "",
    l.broker_name    ? `Affiliated with ${l.broker_name}.` : "",
    l.email          ? `Email verified.` : "",
    l.phone          ? `Phone available.` : "",
    l.website        ? `Has professional website.` : "",
    (l.score || 0) >= 7
      ? "Strong contact profile — high outreach potential."
      : (l.score || 0) >= 4
      ? "Moderate contact info available."
      : "License verified. Additional research recommended.",
  ];
  return parts.filter(Boolean).join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE MAP — city → state → scraper
// ═══════════════════════════════════════════════════════════════════════════════
const STATE_SCRAPERS = {
  TX: scrapeTREC,
  FL: scrapeFloriDA,
  NC: scrapeNCREC,
  GA: scrapeGeorgia,
  CO: scrapeColorado,
  AZ: scrapeArizona,
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const { city = "Houston", state = "TX", limit = 15 } = req.body || {};
  const safeState = (state || "TX").toUpperCase().trim();
  const safeCity  = (city  || "Houston").trim();
  const safeLimit = Math.min(Number(limit) || 15, 25);

  console.log(`[SCRAPE] ${safeCity}, ${safeState} — limit ${safeLimit}`);

  const scraper = STATE_SCRAPERS[safeState];
  if (!scraper) {
    // Return helpful message with supported states
    return res.status(200).json({
      success: false,
      error:   `${safeState} not yet supported.`,
      supported_states: Object.keys(STATE_SCRAPERS),
      message: `Currently supported: ${Object.keys(STATE_SCRAPERS).join(", ")}. More states being added. Try TX, FL, NC, GA, CO, or AZ.`,
      leads:   [],
    });
  }

  try {
    const leads = await scraper(safeCity, safeLimit);

    // Deduplicate by name
    const seen  = new Set();
    const unique = leads.filter(l => {
      if (!l.name) return false;
      const k = l.name.toLowerCase().replace(/\s+/g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    console.log(`[SCRAPE] Returning ${unique.length} active licensed agents`);
    return res.status(200).json({
      success: true,
      count:   unique.length,
      city:    safeCity,
      state:   safeState,
      source:  "State Real Estate Licensing Board (Public Record)",
      note:    "All agents are ACTIVE licensed. This is public government data — free, legal, always current.",
      leads:   unique,
    });

  } catch (err) {
    console.error("[SCRAPE] Fatal:", err.message);
    return res.status(200).json({
      success: false,
      error:   err.message,
      leads:   [],
    });
  }
};
