const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data', 'db.json');

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

function textTokens(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function similarityScore(a, b) {
  const sa = new Set(textTokens(a));
  const sb = new Set(textTokens(b));
  if (!sa.size || !sb.size) return 0;
  const intersection = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return intersection / union;
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

function extractCompetitorDishes(html) {
  const blocks = html.match(/<(article|li|div|section)[\s\S]*?<\/\1>/gi) || [];
  const dishes = [];
  const seen = new Set();

  for (const block of blocks.slice(0, 500)) {
    const text = stripTags(block);
    const lines = text.split(/\s{2,}|\n/).map((x) => x.trim()).filter(Boolean);
    const name = lines.find((l) => /[a-zA-Z]/.test(l) && l.length > 4 && l.length < 80);
    if (!name) continue;

    const prices = (text.match(/\$\s?\d+[\.,]?\d*/g) || [])
      .map((p) => Number(p.replace(/[^\d.,]/g, '').replace(',', '.')))
      .filter(Boolean);

    if (!prices.length && lines.length < 2) continue;

    const description = lines.slice(1, 3).join(' ');
    const key = `${name.toLowerCase()}|${description.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    dishes.push({
      name,
      description,
      fullPrice: prices[0] || null,
      promoPrice: prices[1] || null,
      image: ''
    });

    if (dishes.length >= 40) break;
  }

  return dishes;
}

function buildComparison(ourDishes, competitorDishes) {
  return competitorDishes.map((comp) => {
    let bestMatch = null;
    let bestScore = 0;

    for (const ours of ourDishes) {
      const scoreName = similarityScore(ours.name, comp.name);
      const scoreDesc = similarityScore(ours.description, comp.description);
      const scoreCategory = similarityScore(ours.category, `${comp.name} ${comp.description}`);
      const score = scoreName * 0.65 + scoreDesc * 0.25 + scoreCategory * 0.1;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = ours;
      }
    }

    return {
      competitor: comp,
      ours: bestMatch,
      matchScore: Number((bestScore * 100).toFixed(1)),
      status: bestScore >= 0.25 ? 'Coincidencia' : 'Sin coincidencia fuerte'
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
