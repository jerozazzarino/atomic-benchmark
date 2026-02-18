const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data', 'db.json');

const STOPWORDS = new Set([
  'con', 'sin', 'para', 'por', 'del', 'las', 'los', 'una', 'unos', 'unas', 'que', 'the', 'and'
]);

const TOKEN_SYNONYMS = {
  burger: 'hamburguesa',
  hamburguesa: 'hamburguesa',
  hamburguesas: 'hamburguesa',
  papas: 'fritas',
  fries: 'fritas',
  pizza: 'pizza',
  pizzeta: 'pizza',
  gaseosa: 'bebida',
  bebida: 'bebida',
  soda: 'bebida',
  pollo: 'pollo',
  chicken: 'pollo',
  carne: 'carne',
  beef: 'carne',
  queso: 'queso',
  cheese: 'queso',
  vegano: 'vegano',
  vegan: 'vegano'
};

function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('Carga útil demasiado grande'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeDish(dish) {
  return {
    brand: String(dish.brand || '').trim(),
    id: String(dish.id || '').trim(),
    category: String(dish.category || '').trim(),
    name: String(dish.name || '').trim(),
    description: String(dish.description || '').trim(),
    image: String(dish.image || '').trim(),
    fullPrice: Number(dish.fullPrice || 0),
    promoPrice: dish.promoPrice === '' || dish.promoPrice == null ? null : Number(dish.promoPrice),
    discount: dish.discount === '' || dish.discount == null ? null : Number(dish.discount)
  };
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textTokens(text) {
  const tokens = normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return tokens.map((token) => TOKEN_SYNONYMS[token] || token);
}

function tokenJaccard(a, b) {
  const sa = new Set(textTokens(a));
  const sb = new Set(textTokens(b));
  if (!sa.size || !sb.size) return 0;
  const intersection = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return intersection / union;
}

function tokenDice(a, b) {
  const aa = textTokens(a);
  const bb = textTokens(b);
  if (!aa.length || !bb.length) return 0;
  const map = new Map();
  for (const token of aa) map.set(token, (map.get(token) || 0) + 1);
  let hits = 0;
  for (const token of bb) {
    const n = map.get(token) || 0;
    if (n > 0) {
      map.set(token, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (aa.length + bb.length);
}

function normalizedLevenshtein(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);
  if (!s && !t) return 1;
  if (!s || !t) return 0;

  const dp = Array.from({ length: s.length + 1 }, () => Array(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i++) dp[i][0] = i;
  for (let j = 0; j <= t.length; j++) dp[0][j] = j;

  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  const dist = dp[s.length][t.length];
  return 1 - dist / Math.max(s.length, t.length);
}

function containmentBonus(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na.includes(nb) || nb.includes(na)) return 1;
  return 0;
}

function priceSimilarity(ourPrice, compPrice) {
  if (!ourPrice || !compPrice) return 0.25;
  const max = Math.max(ourPrice, compPrice);
  const diff = Math.abs(ourPrice - compPrice);
  return Math.max(0, 1 - diff / max);
}

function semanticSimilarity(ours, comp) {
  const ourName = ours.name || '';
  const compName = comp.name || '';
  const ourDesc = ours.description || '';
  const compDesc = comp.description || '';

  const nameJaccard = tokenJaccard(ourName, compName);
  const nameDice = tokenDice(ourName, compName);
  const descJaccard = tokenJaccard(ourDesc, compDesc);
  const crossSignal = tokenJaccard(`${ours.category} ${ourName}`, `${compName} ${compDesc}`);
  const editName = normalizedLevenshtein(ourName, compName);
  const include = containmentBonus(ourName, compName);
  const price = priceSimilarity(ours.fullPrice, comp.fullPrice);

  const score =
    nameJaccard * 0.30 +
    nameDice * 0.20 +
    editName * 0.16 +
    descJaccard * 0.12 +
    crossSignal * 0.12 +
    include * 0.05 +
    price * 0.05;

  return Math.max(0, Math.min(1, score));
}

function stripTags(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFromJsonLd(html) {
  const scriptBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const dishes = [];

  for (const block of scriptBlocks) {
    const jsonText = block.replace(/<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue;
    }

    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      const items = node?.hasMenuSection || node?.hasMenuItem || node?.itemListElement || [];
      const list = Array.isArray(items) ? items : [items];
      for (const item of list) {
        const candidate = item?.item || item;
        const name = candidate?.name || '';
        const description = candidate?.description || '';
        const offer = Array.isArray(candidate?.offers) ? candidate.offers[0] : candidate?.offers;
        const price = Number(offer?.price || candidate?.price || 0) || null;
        if (!name) continue;
        dishes.push({ name: String(name), description: String(description), fullPrice: price, promoPrice: null, image: '' });
      }
    }
  }

  return dishes;
}

function extractCompetitorDishes(html) {
  const jsonLdDishes = extractFromJsonLd(html);
  const blocks = html.match(/<(article|li|div|section)[\s\S]*?<\/\1>/gi) || [];
  const dishes = [...jsonLdDishes];
  const seen = new Set(jsonLdDishes.map((d) => `${normalizeText(d.name)}|${normalizeText(d.description)}`));

  for (const block of blocks.slice(0, 900)) {
    const text = stripTags(block);
    const lines = text.split(/\s{2,}|\n/).map((x) => x.trim()).filter(Boolean);
    const name = lines.find((l) => /[a-zA-Z]/.test(l) && l.length > 4 && l.length < 90);
    if (!name) continue;

    const prices = (text.match(/\$\s?\d+[\.,]?\d*/g) || [])
      .map((p) => Number(p.replace(/[^\d.,]/g, '').replace(',', '.')))
      .filter(Boolean);

    if (!prices.length && lines.length < 2) continue;

    const description = lines.slice(1, 4).join(' ');
    const key = `${normalizeText(name)}|${normalizeText(description)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    dishes.push({
      name,
      description,
      fullPrice: prices[0] || null,
      promoPrice: prices[1] || null,
      image: ''
    });

    if (dishes.length >= 80) break;
  }

  return dishes;
}

function buildComparison(ourDishes, competitorDishes) {
  return competitorDishes.map((comp) => {
    let bestMatch = null;
    let bestScore = 0;

    for (const ours of ourDishes) {
      const score = semanticSimilarity(ours, comp);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = ours;
      }
    }

    return {
      competitor: comp,
      ours: bestMatch,
      matchScore: Number((bestScore * 100).toFixed(1)),
      status: bestScore >= 0.5 ? 'Coincidencia' : (bestScore >= 0.3 ? 'Coincidencia parcial' : 'Sin coincidencia fuerte')
    };
  });
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json'
  };
  sendText(res, 200, fs.readFileSync(filePath), types[ext] || 'application/octet-stream');
  return true;
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsed.pathname);

  try {
    if (pathname === '/api/dishes' && req.method === 'GET') {
      return sendJson(res, 200, readDb().dishes);
    }

    if (pathname === '/api/dishes' && req.method === 'POST') {
      const db = readDb();
      const dish = sanitizeDish(await parseBody(req));
      if (!dish.id) return sendJson(res, 400, { error: 'El ID del plato es obligatorio' });
      const idx = db.dishes.findIndex((d) => d.id === dish.id);
      if (idx >= 0) db.dishes[idx] = dish;
      else db.dishes.push(dish);
      writeDb(db);
      return sendJson(res, idx >= 0 ? 200 : 201, dish);
    }

    if (pathname === '/api/dishes/bulk' && req.method === 'POST') {
      const body = await parseBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return sendJson(res, 400, { error: 'El arreglo rows es obligatorio' });
      const db = readDb();
      let created = 0;
      let updated = 0;
      for (const row of rows) {
        const dish = sanitizeDish(row);
        if (!dish.id) continue;
        const idx = db.dishes.findIndex((d) => d.id === dish.id);
        if (idx >= 0) {
          db.dishes[idx] = { ...db.dishes[idx], ...dish };
          updated++;
        } else {
          db.dishes.push(dish);
          created++;
        }
      }
      writeDb(db);
      return sendJson(res, 200, { created, updated, total: db.dishes.length });
    }

    if (pathname.startsWith('/api/dishes/') && req.method === 'PUT') {
      const id = pathname.split('/').pop();
      const db = readDb();
      const idx = db.dishes.findIndex((d) => d.id === id);
      if (idx < 0) return sendJson(res, 404, { error: 'Plato no encontrado' });
      const updated = sanitizeDish({ ...db.dishes[idx], ...(await parseBody(req)), id });
      db.dishes[idx] = updated;
      writeDb(db);
      return sendJson(res, 200, updated);
    }

    if (pathname.startsWith('/api/dishes/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      const db = readDb();
      const before = db.dishes.length;
      db.dishes = db.dishes.filter((d) => d.id !== id);
      if (db.dishes.length === before) return sendJson(res, 404, { error: 'Plato no encontrado' });
      writeDb(db);
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/api/benchmark' && req.method === 'POST') {
      const body = await parseBody(req);
      const brand = String(body.brand || '').trim();
      const url = String(body.url || '').trim();
      if (!brand || !url) return sendJson(res, 400, { error: 'brand y url son obligatorios' });

      const db = readDb();
      const ourDishes = db.dishes.filter((d) => d.brand.toLowerCase() === brand.toLowerCase());
      if (!ourDishes.length) return sendJson(res, 404, { error: 'No se encontraron platos para la marca seleccionada' });

      const response = await fetch(url, { headers: { 'User-Agent': 'Atomic Benchmark Bot' } });
      if (!response.ok) return sendJson(res, 400, { error: `No se pudo consultar la URL (${response.status})` });
      const html = await response.text();
      const competitorDishes = extractCompetitorDishes(html);
      const results = buildComparison(ourDishes, competitorDishes);

      const analysis = { id: `analysis-${Date.now()}`, date: new Date().toISOString(), brand, url, results };
      db.history.unshift(analysis);
      db.history = db.history.slice(0, 100);
      writeDb(db);
      return sendJson(res, 200, analysis);
    }

    if (pathname === '/api/benchmark/history' && req.method === 'GET') {
      const history = readDb().history.map(({ id, date, brand, url, results }) => ({
        id,
        date,
        brand,
        url,
        totalResults: results.length
      }));
      return sendJson(res, 200, history);
    }

    if (pathname.startsWith('/api/benchmark/history/') && req.method === 'GET') {
      const id = pathname.split('/').pop();
      const entry = readDb().history.find((h) => h.id === id);
      if (!entry) return sendJson(res, 404, { error: 'Análisis no encontrado' });
      return sendJson(res, 200, entry);
    }

    if (serveStatic(req, res, pathname)) return;
    sendText(res, 404, 'No encontrado');
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Error inesperado del servidor' });
  }
});

server.listen(PORT, () => {
  console.log(`Atomic Benchmark running on http://localhost:${PORT}`);
});
