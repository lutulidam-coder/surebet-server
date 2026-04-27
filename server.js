// server.js — Oddspedia Surebet Scraper (Puppeteer)
// Deploy on Render.com as a Node.js web service

const express = require('express');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const TARGET_BOOKMAKERS = ['1xbet', '22bet'];
const OU_KEYWORDS = ['over', 'under', 'total'];

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Find Chrome executable
function findChrome() {
  // Try puppeteer's bundled browser first
  try {
    const { executablePath } = require('puppeteer');
    const p = executablePath();
    if (fs.existsSync(p)) {
      console.log('Found Chrome at:', p);
      return p;
    }
  } catch(e) {}

  // Common Linux paths on Render
  const paths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
    '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux/chrome',
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      console.log('Found Chrome at:', p);
      return p;
    }
  }

  // Try which command
  try {
    const p = execSync('which google-chrome || which chromium-browser || which chromium').toString().trim();
    if (p) { console.log('Found Chrome via which:', p); return p; }
  } catch(e) {}

  // Try finding in puppeteer cache
  try {
    const cacheDir = path.join(process.env.HOME || '/opt/render', '.cache', 'puppeteer');
    if (fs.existsSync(cacheDir)) {
      const result = execSync(`find ${cacheDir} -name "chrome" -type f 2>/dev/null | head -1`).toString().trim();
      if (result) { console.log('Found Chrome via find:', result); return result; }
    }
  } catch(e) {}

  return null;
}

app.get('/health', (req, res) => {
  const chromePath = findChrome();
  res.json({ 
    status: 'ok', 
    chrome: chromePath || 'NOT FOUND',
    cached: !!cache,
    cacheAge: cache ? Math.round((Date.now() - cacheTime) / 1000) + 's' : null 
  });
});

app.get('/surebets', async (req, res) => {
  const minProfit = parseFloat(req.query.minProfit) || 0;

  if (cache && (Date.now() - cacheTime) < CACHE_TTL) {
    const filtered = filterBets(cache, minProfit);
    return res.json({ data: filtered, count: filtered.length, cached: true, fetchedAt: new Date(cacheTime).toISOString() });
  }

  let browser;
  try {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found on this server. Check /health for details.');

    console.log('Launching Puppeteer with Chrome:', chromePath);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) req.abort();
      else req.continue();
    });

    let apiData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/surebets') && url.includes('api') && !apiData) {
        try {
          const json = await response.json();
          if (json && (json.data || json.surebets || Array.isArray(json))) {
            apiData = json;
            console.log('Intercepted Oddspedia API!');
          }
        } catch(e) {}
      }
    });

    console.log('Navigating to Oddspedia...');
    await page.goto('https://oddspedia.com/surebets', {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    await page.waitForSelector('.surebet-item, .arb-row, [class*="surebet"], [class*="arb"]', {
      timeout: 20000,
    }).catch(() => console.log('Selector timeout — scraping anyway'));

    await new Promise(r => setTimeout(r, 3000));

    let surebets = [];

    if (apiData) {
      surebets = parseApiData(apiData);
    } else {
      surebets = await page.evaluate(() => {
        const results = [];
        const rows = document.querySelectorAll(
          '.surebet-item, .arb-row, [class*="surebet-row"], [class*="arbRow"], .fork-item, [class*="fork-row"]'
        );
        rows.forEach(row => {
          try {
            const matchEl = row.querySelector('[class*="match"], [class*="event"], [class*="teams"]');
            const match = matchEl ? matchEl.textContent.trim() : '';
            const marketEl = row.querySelector('[class*="market"], [class*="bet-type"], [class*="outcome"]');
            const market = marketEl ? marketEl.textContent.trim() : '';
            const profitEl = row.querySelector('[class*="profit"], [class*="roi"], [class*="margin"]');
            const profit = parseFloat((profitEl ? profitEl.textContent.trim() : '').replace('%', '')) || 0;
            const bookieParts = row.querySelectorAll('[class*="bookmaker"], [class*="bookie"], [class*="book"]');
            const bookmakers = [];
            bookieParts.forEach(b => {
              const name = b.querySelector('[class*="name"]')?.textContent?.trim() || b.textContent.trim();
              const oddsEl = b.querySelector('[class*="odd"], [class*="coef"]');
              const odds = parseFloat(oddsEl?.textContent?.trim()) || 0;
              if (name) bookmakers.push({ name, odds });
            });
            const leagueEl = row.querySelector('[class*="league"], [class*="competition"], [class*="tournament"]');
            const league = leagueEl ? leagueEl.textContent.trim() : '';
            const timeEl = row.querySelector('[class*="time"], [class*="date"], [class*="start"]');
            const startTime = timeEl ? timeEl.textContent.trim() : '';
            if (match || bookmakers.length > 0) results.push({ match, market, profit, bookmakers, league, startTime });
          } catch(e) {}
        });
        if (results.length === 0) return [{ debug: true, html: document.body.innerText.slice(0, 500) }];
        return results;
      });
    }

    await browser.close();
    browser = null;

    cache = surebets;
    cacheTime = Date.now();

    const filtered = filterBets(surebets, minProfit);
    console.log(`Found ${surebets.length} total, ${filtered.length} after filter`);

    res.json({ data: filtered, count: filtered.length, total: surebets.length, cached: false, fetchedAt: new Date().toISOString() });

  } catch(err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

function parseApiData(json) {
  const arr = json.data || json.surebets || (Array.isArray(json) ? json : []);
  return arr.map(item => ({
    match: item.match || item.event || `${item.home || ''} vs ${item.away || ''}`,
    market: item.market || item.marketName || item.betType || '',
    profit: parseFloat(item.profit || item.roi || item.margin || 0),
    league: item.league || item.competition || item.tournament || '',
    startTime: item.startTime || item.date || item.time || '',
    bookmakers: (item.bookmakers || item.odds || []).map(b => ({
      name: b.name || b.bookmaker || b.bookie || '',
      odds: parseFloat(b.odds || b.odd || b.coef || 0),
      outcome: b.outcome || b.pick || b.label || '',
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
    const bookieNames = (bet.bookmakers || []).map(b => (b.name || '').toLowerCase());
    return TARGET_BOOKMAKERS.some(t => bookieNames.some(n => n.includes(t)));
  }).sort((a, b) => b.profit - a.profit);
}

app.listen(PORT, () => console.log(`Surebet server running on port ${PORT}`));
