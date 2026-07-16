// api/apex.js
// Apex Legends Dashboard — data aggregation endpoint (Vercel serverless function)
//
// v1 scope: sources that work WITHOUT any API key.
//   - Google News RSS  (general Apex Legends news)
//   - Google News RSS  (ALGS / esports specific query)
//   - Reddit r/apexlegends RSS        (community / patch reactions)
//   - Reddit r/CompetitiveApex RSS    (meta / competitive discussion)
//
// Server status + map rotation are stubbed behind an optional API key
// (Apex Legends Status API, apexlegendsapi.com — free registration).
// If APEX_STATUS_API_KEY is not set in Vercel env vars, that section is
// simply omitted from the response instead of erroring.
//
// Response shape mirrors the JapanNow/ORACLE pattern: { items, report, generatedAt }

const GOOGLE_NEWS_APEX_URL =
  'https://news.google.com/rss/search?q=%22Apex%20Legends%22&hl=en-US&gl=US&ceid=US:en';
const GOOGLE_NEWS_ALGS_URL =
  'https://news.google.com/rss/search?q=ALGS%20OR%20%22Apex%20Legends%22%20esports&hl=en-US&gl=US&ceid=US:en';
const REDDIT_APEXLEGENDS_RSS = 'https://www.reddit.com/r/apexlegends/.rss';
const REDDIT_COMPETITIVEAPEX_RSS = 'https://www.reddit.com/r/CompetitiveApex/.rss';

const APEX_STATUS_API_KEY = process.env.APEX_STATUS_API_KEY || '';
const APEX_STATUS_SERVERS_URL = `https://api.mozambiquehe.re/servers?auth=${APEX_STATUS_API_KEY}`;
const APEX_STATUS_MAPROTATION_URL = `https://api.mozambiquehe.re/maprotation?auth=${APEX_STATUS_API_KEY}&version=2`;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min, same as JapanNow
let cache = { data: null, ts: 0 };

// Category keyword rules — same "keyword matching" pattern as ORACLE's risk categories.
const CATEGORY_RULES = [
  { key: 'patch', label: 'パッチ / メタ', keywords: ['patch notes', 'nerf', 'buff', 'balance update', 'hotfix', 'season', 'update', 'rework'] },
  { key: 'esports', label: 'eスポーツ / ALGS', keywords: ['algs', 'championship', 'tournament', 'esports', 'lan', 'playoffs', 'scrim'] },
  { key: 'outage', label: 'サーバー / 障害', keywords: ['servers down', 'outage', 'maintenance', 'ddos', 'connection issue', 'server status'] },
  { key: 'general', label: '一般ニュース', keywords: [] } // fallback bucket
];

function categorize(title) {
  const lower = title.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.key === 'general') continue;
    if (rule.keywords.some(k => lower.includes(k))) return rule.key;
  }
  return 'general';
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Minimal, dependency-free RSS/Atom parser (same approach as JapanNow's parseRss).
function parseRss(xml, sourceName) {
  const isAtom = xml.includes('<feed');
  const entryTag = isAtom ? 'entry' : 'item';
  const blocks = [...xml.matchAll(new RegExp(`<${entryTag}>([\\s\\S]*?)</${entryTag}>`, 'g'))];

  return blocks.map(([, block]) => {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    let title = titleMatch ? titleMatch[1] : '';
    title = title.replace('<![CDATA[', '').replace(']]>', '').trim();

    let link = '';
    if (isAtom) {
      const linkMatch = block.match(/<link[^>]*href="([^"]+)"/);
      link = linkMatch ? linkMatch[1] : '';
    } else {
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
      link = linkMatch ? linkMatch[1].trim() : '';
    }

    const dateMatch = block.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/);
    const published = dateMatch ? dateMatch[1].trim() : null;

    return {
      title,
      link,
      published,
      source: sourceName,
      category: categorize(title)
    };
  }).filter(item => item.title);
}

async function fetchRss(url, sourceName) {
  const res = await fetchWithTimeout(url, { headers: { 'user-agent': 'ApexDash/1.0' } });
  if (!res.ok) throw new Error(`${sourceName} ${res.status}`);
  const xml = await res.text();
  return parseRss(xml, sourceName);
}

function dedupeByTitleStem(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const stem = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(item);
  }
  return out;
}

async function fetchServerStatus() {
  if (!APEX_STATUS_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(APEX_STATUS_SERVERS_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchMapRotation() {
  if (!APEX_STATUS_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(APEX_STATUS_MAPROTATION_URL);
    if (!res.ok) throw new Error(`maprotation ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function buildDashboard() {
  const collectors = [
    ['Google News', () => fetchRss(GOOGLE_NEWS_APEX_URL, 'Google News')],
    ['Google News (ALGS)', () => fetchRss(GOOGLE_NEWS_ALGS_URL, 'Google News')],
    ['r/apexlegends', () => fetchRss(REDDIT_APEXLEGENDS_RSS, 'r/apexlegends')],
    ['r/CompetitiveApex', () => fetchRss(REDDIT_COMPETITIVEAPEX_RSS, 'r/CompetitiveApex')]
  ];

  const settled = await Promise.allSettled(collectors.map(([, fn]) => fn()));

  const report = settled.map((r, i) => {
    const name = collectors[i][0];
    if (r.status === 'fulfilled') return { name, ok: true, count: r.value.length };
    return { name, ok: false, count: 0, error: r.reason?.message || 'error' };
  });

  let items = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') items.push(...r.value);
  }
  items = dedupeByTitleStem(items).sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));

  const [serverStatus, mapRotation] = await Promise.all([fetchServerStatus(), fetchMapRotation()]);

  const categoryCounts = CATEGORY_RULES.reduce((acc, rule) => {
    acc[rule.key] = { label: rule.label, count: 0 };
    return acc;
  }, {});
  for (const item of items) categoryCounts[item.category].count++;

  return {
    items: items.slice(0, 60),
    categoryCounts,
    serverStatus,     // null if no API key configured
    mapRotation,       // null if no API key configured
    report,
    generatedAt: new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    if (cache.data && now - cache.ts < CACHE_TTL_MS) {
      res.setHeader('x-cache', 'HIT');
      return res.status(200).json(cache.data);
    }
    const data = await buildDashboard();
    cache = { data, ts: now };
    res.setHeader('x-cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'internal error' });
  }
};
