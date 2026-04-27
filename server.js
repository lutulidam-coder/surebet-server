// server.js — Oddspedia Surebet Scraper (Puppeteer)
// Deploy on Render.com as a Node.js web service

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// Target bookmakers (must include at least one)
const TARGET_BOOKMAKERS = ['1xbet', '22bet'];

// Over/Under market keywords
const OU_KEYWORDS = ['over', 'under', 'total'];

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', cached: !!cache, cacheAge: cache ? Math.round((Date.now() - cacheTime) / 1000) + 's' : null });
});

app.get('/surebets', async (req, res) => {
  const minProfit = parseFloat(req.query.minProfit) || 0;

  // Return cache if fresh
  if (cache && (Date.now() - cacheTime) < CACHE_TTL) {
    const filtered = filterBets(cache, minProfit);
    return res.json({ data: filtered, count: filtered.length, cached: true, fetchedAt: new Date(cacheTime).toISOString() });
  }

  let browser;
  try {
    console.log('Launching Puppeteer...');
    browser = await puppeteer.launch({
      headless: true,
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

    // Mimic real browser
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Block images/fonts to speed up
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Intercept Oddspedia's own API calls
    let apiData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/surebets') && url.includes('api') && !apiData) {
        try {
          const json = await response.json();
          if (json && (json.data || json.surebets || Array.isArray(json))) {
            apiData = json;
            console.log('Intercepted Oddspedia API response!');
          }
        } catch (e) {}
      }
    });

    console.log('Navigating to Oddspedia surebets...');
    await page.goto('https://oddspedia.com/surebets', {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    // Wait for surebet cards to appear
    await page.waitForSelector('.surebet-item, .arb-row, [class*="surebet"], [class*="arb"]', {
      timeout: 20000,
    }).catch(() => console.log('Selector timeout — trying DOM scrape anyway'));

    // Small extra wait for JS to finish rendering
    await new Promise(r => setTimeout(r, 3000));

    let surebets = [];

    // Try intercepted API data first
    if (apiData) {
      surebets = parseApiData(apiData);
    } else {
      // Fallback: scrape the DOM
      surebets = await page.evaluate(() => {
        const results = [];

        // Try multiple possible selectors Oddspedia might use
        const rows = document.querySelectorAll(
          '.surebet-item, .arb-row, [class*="surebet-row"], [class*="arbRow"], .fork-item, [class*="fork-row"]'
        );

        rows.forEach(row => {
          try {
            // Match info
            const matchEl = row.querySelector('[class*="match"], [class*="event"], [class*="teams"]');
            const match = matchEl ? matchEl.textContent.trim() : '';

            // Market
            const marketEl = row.querySelector('[class*="market"], [class*="bet-type"], [class*="outcome"]');
            const market = marketEl ? marketEl.textContent.trim() : '';

            // Profit
            const profitEl = row.querySelector('[class*="profit"], [class*="roi"], [class*="margin"]');
            const profitText = profitEl ? profitEl.textContent.trim() : '';
            const profit = parseFloat(profitText.replace('%', '')) || 0;

            // Bookmakers + odds
            const bookieParts = row.querySelectorAll('[class*="bookmaker"], [class*="bookie"], [class*="book"]');
            const bookmakers = [];
            bookieParts.forEach(b => {
              const name = b.querySelector('[class*="name"]')?.textContent?.trim() || b.textContent.trim();
              const oddsEl = b.querySelector('[class*="odd"], [class*="coef"]');
              const odds = parseFloat(oddsEl?.textContent?.trim()) || 0;
              if (name) bookmakers.push({ name, odds });
            });

            // League/sport
            const leagueEl = row.querySelector('[class*="league"], [class*="competition"], [class*="tournament"]');
            const league = leagueEl ? leagueEl.textContent.trim() : '';

            // Time
            const timeEl = row.querySelector('[class*="time"], [class*="date"], [class*="start"]');
            const startTime = timeEl ? timeEl.textContent.trim() : '';

            if (match || bookmakers.length > 0) {
              results.push({ match, market, profit, bookmakers, league, startTime });
            }
          } catch (e) {}
        });

        // If no rows found, try to grab raw page text for debugging
        if (results.length === 0) {
          return [{ debug: true, html: document.body.innerText.slice(0, 500) }];
        }

        return results;
      });
    }

    await browser.close();
    browser = null;

    // Cache raw results
    cache = surebets;
    cacheTime = Date.now();

    const filtered = filterBets(surebets, minProfit);
    console.log(`Found ${surebets.length} total, ${filtered.length} after filter`);

    res.json({
      data: filtered,
      count: filtered.length,
      total: surebets.length,
      cached: false,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Scrape error:', err.message);
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

    // Must be Over/Under market
    const market = (bet.market || '').toLowerCase();
    const isOU = OU_KEYWORDS.some(k => market.includes(k));
    if (!isOU) return false;

    // Must meet min profit
    if (bet.profit < minProfit) return false;

    // Must have 1xbet or 22bet
    const bookieNames = (bet.bookmakers || []).map(b => (b.name || '').toLowerCase());
    const hasTarget = TARGET_BOOKMAKERS.some(t => bookieNames.some(n => n.includes(t)));
    if (!hasTarget) return false;

    return true;
  }).sort((a, b) => b.profit - a.profit);
}

app.listen(PORT, () => {
  console.log(`Surebet server running on port ${PORT}`);
});
