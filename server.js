const http = require('http');
const https = require('https');
const url = require('url');

// ─── Config ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ORIGINS || '*';       // CORS
const RATE_PER_WINDOW = parseInt(process.env.RATE_LIMIT) || 200; // req/min
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL) || 300_000;  // 5 min

// ─── In-memory cache ──────────────────────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.url;
}
function cacheSet(key, url) {
  cache.set(key, { url, timestamp: Date.now() });
}

// ─── Simple rate limiter (per IP) ─────────────────────────────────────────
const rateCounts = new Map();
function rateCheck(ip) {
  const now = Date.now();
  let entry = rateCounts.get(ip);
  if (!entry || now - entry.windowStart > 60_000) {
    entry = { windowStart: now, count: 0 };
    rateCounts.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_PER_WINDOW;
}

// ─── Scrape avatar from X (Twitter) ──────────────────────────────────────
function scrapeAvatar(username) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'x.com',
      path: '/' + encodeURIComponent(username),
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let html = '';
      res.on('data', (chunk) => { html += chunk.toString(); });

      res.on('end', () => {
        // Try og:image first
        const ogMatch = html.match(
          /<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i
        );
        if (ogMatch && ogMatch[1]) {
          let imgUrl = ogMatch[1];
          // Upgrade to a larger variant
          imgUrl = imgUrl.replace(/_normal(?=\.\w+)/, '_400x400');
          return resolve(imgUrl);
        }

        // Try twitter:image:src
        const twMatch = html.match(
          /<meta[^>]+name\s*=\s*["']twitter:image:src["'][^>]+content\s*=\s*["']([^"']+)["']/i
        );
        if (twMatch && twMatch[1]) {
          let imgUrl = twMatch[1];
          imgUrl = imgUrl.replace(/_normal(?=\.\w+)/, '_400x400');
          return resolve(imgUrl);
        }

        // Try to find any twimg.com url in the page
        const twimgMatch = html.match(/https?:\/\/(?:pbs\.)?twimg\.com\/[^"'\s]+profile_images[^"'\s]+/i);
        if (twimgMatch) {
          let imgUrl = twimgMatch[0];
          imgUrl = imgUrl.replace(/_normal(?=\.\w+)/, '_400x400');
          return resolve(imgUrl);
        }

        reject(new Error('No avatar found for @' + username));
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ─── Try unavatar as secondary source ─────────────────────────────────────
function fetchFromUnavatar(username) {
  return new Promise((resolve) => {
    const u = `https://unavatar.io/x/${encodeURIComponent(username)}?json`;
    https.get(u, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.url) resolve(parsed.url);
          else resolve(null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─── Fetch avatar with fallback chain ─────────────────────────────────────
async function getAvatarUrl(username) {
  const cached = cacheGet(username);
  if (cached) return { source: 'cache', url: cached };

  try {
    const url = await scrapeAvatar(username);
    cacheSet(username, url);
    return { source: 'x_scrape', url };
  } catch (_) {
    // Fallback to unavatar
    const u = await fetchFromUnavatar(username);
    if (u) {
      cacheSet(username, u);
      return { source: 'unavatar', url: u };
    }
    return { source: null, url: null };
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS === '*' || ALLOWED_ORIGINS.split(',').includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!rateCheck(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests. Limit: ' + RATE_PER_WINDOW + '/min.' }));
    return;
  }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  // ── Health check ──
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cacheSize: cache.size }));
    return;
  }

  // ── Avatar endpoint: GET /avatar/:username ──
  const match = path.match(/^\/avatar\/(.+)$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /avatar/{username}' }));
    return;
  }

  const username = match[1].replace(/^@/, '').trim();
  if (!username) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Username required' }));
    return;
  }

  try {
    const result = await getAvatarUrl(username);
    if (!result.url) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Avatar not found for @' + username }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ username, avatar_url: result.url, source: result.source }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  🖼️  X Avatar Proxy running at http://localhost:${PORT}`);
  console.log(`  📦  Cache TTL: ${CACHE_TTL_MS/1000}s | Rate limit: ${RATE_PER_WINDOW}/min`);
  console.log(`  🔗  Endpoint: GET /avatar/{username}\n`);
});