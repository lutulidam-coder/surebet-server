const express = require('express');
const puppeteer = require('puppeteer');
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_BOOKMAKERS = ['1xbet', '22bet'];
const OU_KEYWORDS = ['over', 'under', 'total'];
let cache = null, cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Install Chrome on startup if not found
async function ensureChrome() {
  try {
    const { executablePath } = require('puppeteer');
    const p = executablePath();
    if (fs.existsSync(p)) { console.log('Chrome found:', p); return p; }
  } catch(e) {}

  console.log('Chrome not found — installing now...');
  try {
    execSync('npx puppeteer browsers install chrome', { 
      stdio: 'inherit',
      timeout: 120000 
    });
    console.log('Chrome installed!');
    const { executablePath } = require('puppeteer');
    return executablePath();
  } catch(e) {
    console.error('Chrome install failed:', e.message);
    return null;
  }
}

let chromePath = null;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', chrome: chromePath || 'NOT FOUND', cached: !!cache });
});

app.get('/surebets', async (req, res) => {
  const minProfit = parseFloat(req.query.minProfit) || 0;

  if (!chromePath) {
    chromePath = await ensureChrome();
    if (!chromePath) return res.status(502).json({ error: 'Chrome could not be installed' });
  }

  if (cache && (Date.now() - cacheTime) < CACHE_TTL) {
    const filtered = filterBets(cache, minProfit);
    return res.json({ data: filtered, count: filtered.length, cached: true });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on('request', r => ['image','font','media','stylesheet'].includes(r.resourceType()) ? r.abort() : r.continue());

    let apiData = null;
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('/surebets') && url.includes('api') && !apiData) {
        try {
          const json = await response.json();
          if (json && (json.data || json.surebets || Array.isArray(json))) { apiData = json; }
        } catch(e) {}
      }
    });

    await page.goto('https://oddspedia.com/surebets', { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.surebet-item, [class*="surebet"], [class*="arb"]', { timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    let surebets = apiData ? parseApiData(apiData) : await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll('.surebet-item, .arb-row, [class*="surebet-row"], [class*="arbRow"]');
      rows.forEach(row => {
        try {
          const match = row.querySelector('[class*="match"],[class*="teams"]')?.textContent?.trim() || '';
          const market = row.querySelector('[class*="market"],[class*="bet-type"]')?.textContent?.trim() || '';
          const profit = parseFloat((row.querySelector('[class*="profit"],[class*="roi"]')?.textContent || '').replace('%','')) || 0;
          const bookmakers = [];
          row.querySelectorAll('[class*="bookmaker"],[class*="bookie"]').forEach(b => {
            const name = b.querySelector('[class*="name"]')?.textContent?.trim() || b.textContent.trim();
            const odds = parseFloat(b.querySelector('[class*="odd"],[class*="coef"]')?.textContent?.trim()) || 0;
            if (name) bookmakers.push({ name, odds });
          });
          const league = row.querySelector('[class*="league"],[class*="competition"]')?.textContent?.trim() || '';
          const startTime = row.querySelector('[class*="time"],[class*="date"]')?.textContent?.trim() || '';
          if (match || bookmakers.length) results.push({ match, market, profit, bookmakers, league, startTime });
        } catch(e) {}
      });
      return results.length ? results : [{ debug: true, html: document.body.innerText.slice(0, 500) }];
    });

    await browser.close(); browser = null;
    cache = surebets; cacheTime = Date.now();
    const filtered = filterBets(surebets, minProfit);
    res.json({ data: filtered, count: filtered.length, total: surebets.length, cached: false, fetchedAt: new Date().toISOString() });

  } catch(err) {
    if (browser) await browser.close().catch(() => {});
    res.status(502).json({ error: err.message });
  }
});

function parseApiData(json) {
  const arr = json.data || json.surebets || (Array.isArray(json) ? json : []);
  return arr.map(item => ({
    match: item.match || `${item.home||''} vs ${item.away||''}`,
    market: item.market || item.marketName || '',
    profit: parseFloat(item.profit || item.roi || 0),
    league: item.league || item.competition || '',
    startTime: item.startTime || item.date || '',
    bookmakers: (item.bookmakers || item.odds || []).map(b => ({
      name: b.name || b.bookmaker || '', odds: parseFloat(b.odds || b.odd || 0), outcome: b.outcome || b.pick || '',
    })),
  }));
}

function filterBets(bets, minProfit) {
  if (!Array.isArray(bets)) return [];
  return bets.filter(bet => {
    if (bet.debug) return false;
    const market = (bet.market || '').toLowerCase();
    if (!OU_KEYWORDS.some(k => market.includes(k))) return false;
    if (bet.profit < minProfit) return false;
    const names = (bet.bookmakers || []).map(b => (b.name || '').toLowerCase());
    return TARGET_BOOKMAKERS.some(t => names.some(n => n.includes(t)));
  }).sort((a, b) => b.profit - a.profit);
}

// Install Chrome on startup
ensureChrome().then(p => {
  chromePath = p;
  console.log('Startup Chrome check done:', p || 'NOT FOUND');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
