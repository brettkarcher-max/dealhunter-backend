const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

let cache = {
  listings: [],
  lastScraped: null,
  scraping: false,
  error: null,
  debugHTML: null,
};

const SCRAPE_INTERVAL_MS = 20 * 60 * 1000;

async function scrapeCarBids() {
  if (cache.scraping) {
    console.log('Scrape already in progress, skipping.');
    return;
  }

  cache.scraping = true;
  cache.error = null;
  console.log(`[${new Date().toISOString()}] Starting scrape...`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--single-process',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    await page.route('**/*.{woff,woff2,ttf,eot}', route => route.abort());

    console.log('Navigating to Cars & Bids auctions page...');
    const response = await page.goto('https://carsandbids.com/auctions/', {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    console.log('HTTP status:', response?.status());
    console.log('Final URL:', page.url());
    console.log('Page title:', await page.title());

    await page.waitForTimeout(4000);

    const html = await page.content();
    cache.debugHTML = html.substring(0, 5000);
    console.log('=== HTML SNAPSHOT ===');
    console.log(html.substring(0, 3000));
    console.log('=== END SNAPSHOT ===');

    const classNames = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const classes = new Set();
      all.forEach(el => {
        if (el.className && typeof el.className === 'string') {
          el.className.split(' ').forEach(c => {
            if (c && (c.includes('auction') || c.includes('listing') || c.includes('card') || c.includes('item'))) {
              classes.add(c);
            }
          });
        }
      });
      return Array.from(classes);
    });
    console.log('Relevant class names found:', JSON.stringify(classNames));

    const strategies = [
      'li[class*="auction"]',
      'div[class*="auction"]',
      'article[class*="auction"]',
      '[class*="auction-card"]',
      '[class*="auction-item"]',
      '[class*="listing-card"]',
      '[class*="AuctionCard"]',
      '[class*="AuctionItem"]',
      'ul[class*="auctions"] li',
      '[data-testid*="auction"]',
      'a[href*="/auctions/"]',
    ];

    let usedSelector = '';
    let maxFound = 0;

    for (const selector of strategies) {
      const found = await page.$$(selector);
      console.log(`Selector "${selector}": ${found.length} elements`);
      if (found.length > maxFound) {
        maxFound = found.length;
        usedSelector = selector;
      }
    }

    console.log(`Best selector: "${usedSelector}" with ${maxFound} elements`);

    if (maxFound === 0) {
      console.log('No cards found. Dumping body text:');
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      console.log(bodyText);
      cache.listings = [];
      cache.lastScraped = new Date().toISOString();
      return;
    }

    const rawListings = await page.evaluate((sel) => {
      const results = [];
      const cards = document.querySelectorAll(sel);

      cards.forEach(card => {
        try {
          const allText = card.innerText || '';
          const titleEl = card.querySelector('h2, h3, [class*="title"], [class*="name"]');
          const title = titleEl?.innerText?.trim() || '';
          const bidMatch = allText.match(/\$[\d,]+/g);
          const bidText = bidMatch ? bidMatch[0] : '';
          const bid = parseInt(bidText.replace(/[^0-9]/g, '')) || 0;
          const noReserve = allText.toLowerCase().includes('no reserve');
          const linkEl = card.tagName === 'A' ? card : card.querySelector('a[href*="/auctions/"]');
          const href = linkEl?.getAttribute('href') || '';
          const url = href.startsWith('http') ? href : `https://carsandbids.com${href}`;
          const imgEl = card.querySelector('img');
          const image = imgEl?.src || imgEl?.dataset?.src || '';
          const timeMatch = allText.match(/(\d+[dhm]\s*)+/);
          const timeText = timeMatch ? timeMatch[0].trim() : '';
          const bidsMatch = allText.match(/(\d+)\s*bid/i);
          const bidCount = bidsMatch ? parseInt(bidsMatch[1]) : 0;
          const locationEl = card.querySelector('[class*="location"], [class*="city"]');
          const location = locationEl?.innerText?.trim() || '';

          if (title || bid > 0) {
            results.push({ title, bid, timeText, bidCount, noReserve, location, url, image, snippet: allText.substring(0, 200) });
          }
        } catch (e) {}
      });
      return results;
    }, usedSelector);

    console.log(`Extracted ${rawListings.length} raw listings`);
    if (rawListings.length > 0) console.log('Sample:', JSON.stringify(rawListings[0]));

    const listings = rawListings.map((raw, idx) => {
      const parsed = parseTitle(raw.title);
      const hoursLeft = parseTimeLeft(raw.timeText);
      const marketValue = estimateMarketValue(parsed.year, parsed.make, parsed.model, raw.bid);
      const discountPct = marketValue > 0 ? Math.round(((marketValue - raw.bid) / marketValue) * 100) : 0;
      const dealScore = calcDealScore(discountPct, hoursLeft, raw.bidCount, raw.noReserve);
      return {
        id: `cnb-${idx}-${Date.now()}`,
        year: parsed.year, make: parsed.make, model: parsed.model, trim: parsed.trim,
        title: raw.title, currentBid: raw.bid, marketValue, discountPct, dealScore,
        hoursLeft, bids: raw.bidCount, noReserve: raw.noReserve,
        location: raw.location || 'United States', url: raw.url, image: raw.image,
        timeText: raw.timeText, scrapedAt: new Date().toISOString(),
      };
    });

    cache.listings = listings;
    cache.lastScraped = new Date().toISOString();
    console.log(`Scrape complete. ${listings.length} listings cached.`);

  } catch (err) {
    console.error('Scrape failed:', err.message);
    cache.error = err.message;
  } finally {
    if (browser) await browser.close();
    cache.scraping = false;
  }
}

function parseTitle(title) {
  const match = title.match(/^(\d{4})\s+([A-Za-z\-]+)\s+(.+?)(?:\s*\((.+)\))?$/);
  if (match) {
    const [, year, make, rest, trim] = match;
    const parts = rest.trim().split(/\s+/);
    return { year: parseInt(year), make: make.trim(), model: parts[0].trim(), trim: trim || parts.slice(1).join(' ') || '' };
  }
  return { year: 0, make: '', model: title, trim: '' };
}

function parseTimeLeft(text) {
  if (!text) return 48;
  text = text.toLowerCase();
  const days = (text.match(/(\d+)\s*d/) || [])[1];
  const hours = (text.match(/(\d+)\s*h/) || [])[1];
  const mins = (text.match(/(\d+)\s*m/) || [])[1];
  let total = 0;
  if (days) total += parseInt(days) * 24;
  if (hours) total += parseInt(hours);
  if (mins) total += parseInt(mins) / 60;
  if (total === 0 && (text.includes('ending') || text.includes('soon'))) return 0.5;
  return total || 48;
}

function estimateMarketValue(year, make, model, currentBid) {
  const makeModel = `${make} ${model}`.toLowerCase();
  let base = currentBid * 1.3;
  const premiums = [
    [/porsche.*911/, 2.2], [/porsche.*boxster|cayman/, 1.4],
    [/bmw.*m3/, 1.8], [/bmw.*m5/, 1.7], [/bmw.*m2|m4/, 1.6],
    [/mercedes.*amg|c63|e63|s63/, 1.7], [/honda.*s2000/, 1.9],
    [/honda.*nsx|acura.*nsx/, 2.5], [/toyota.*supra/, 2.4],
    [/toyota.*land cruiser/, 1.6], [/mazda.*rx-7/, 1.8],
    [/mazda.*miata|mx-5/, 1.3], [/nissan.*skyline|gtr|gt-r/, 2.2],
    [/nissan.*370z|350z/, 1.3], [/mitsubishi.*evo|evolution/, 1.7],
    [/subaru.*sti|wrx/, 1.5], [/ford.*mustang.*gt500|shelby/, 1.8],
    [/ford.*gt/, 3.0], [/chevrolet.*corvette.*z06/, 1.6],
    [/chevrolet.*corvette/, 1.4], [/dodge.*viper/, 1.8],
    [/ferrari/, 2.0], [/lamborghini/, 2.0], [/aston martin/, 1.8],
    [/mclaren/, 2.0], [/lotus/, 1.5], [/land rover.*defender/, 1.8],
    [/land rover.*range rover/, 1.4], [/lexus.*lfa/, 3.0],
    [/lexus.*is-f|is f/, 1.4], [/audi.*rs/, 1.6],
    [/volkswagen.*gti|golf r/, 1.3], [/volkswagen.*r32/, 1.5],
  ];
  for (const [pattern, multiplier] of premiums) {
    if (pattern.test(makeModel)) { base = currentBid * multiplier; break; }
  }
  if (year >= 1970 && year <= 1985) base *= 1.15;
  if (year >= 1986 && year <= 1995) base *= 1.05;
  return Math.round(base / 100) * 100;
}

function calcDealScore(discountPct, hoursLeft, bidCount, noReserve) {
  let score = 0;
  if (discountPct >= 40) score += 50;
  else if (discountPct >= 30) score += 42;
  else if (discountPct >= 20) score += 32;
  else if (discountPct >= 15) score += 22;
  else if (discountPct >= 10) score += 12;
  if (hoursLeft <= 1) score += 20;
  else if (hoursLeft <= 3) score += 15;
  else if (hoursLeft <= 6) score += 10;
  else if (hoursLeft <= 12) score += 5;
  if (noReserve) score += 20;
  if (bidCount < 5) score += 10;
  else if (bidCount < 15) score += 5;
  return Math.min(score, 99);
}

app.get('/health', (req, res) => res.json({ status: 'ok', lastScraped: cache.lastScraped, scraping: cache.scraping }));
app.get('/debug', (req, res) => res.json({ html: cache.debugHTML, error: cache.error }));

app.get('/api/listings', async (req, res) => {
  const { closeHours = 24, minDiscount = 0, maxBudget, noReserveOnly = 'false' } = req.query;
  const cacheAge = cache.lastScraped ? (Date.now() - new Date(cache.lastScraped).getTime()) / 1000 / 60 : Infinity;
  if (cache.listings.length === 0 || cacheAge > 20) {
    if (!cache.scraping) scrapeCarBids();
    if (cache.listings.length === 0) {
      let waited = 0;
      while (cache.scraping && waited < 60000) { await new Promise(r => setTimeout(r, 500)); waited += 500; }
    }
  }
  if (cache.error && cache.listings.length === 0) return res.status(500).json({ error: cache.error });
  let filtered = cache.listings.filter(l => {
    if (parseFloat(closeHours) && l.hoursLeft > parseFloat(closeHours)) return false;
    if (parseFloat(minDiscount) && l.discountPct < parseFloat(minDiscount)) return false;
    if (maxBudget && l.currentBid > parseFloat(maxBudget)) return false;
    if (noReserveOnly === 'true' && !l.noReserve) return false;
    return true;
  });
  filtered.sort((a, b) => b.dealScore - a.dealScore);
  res.json({ listings: filtered, total: filtered.length, lastScraped: cache.lastScraped, scraping: cache.scraping });
});

app.post('/api/scrape', (req, res) => { if (!cache.scraping) scrapeCarBids(); res.json({ isScanning: true }); });
app.post('/api/scan', (req, res) => { if (!cache.scraping) scrapeCarBids(); res.json({ isScanning: true }); });
app.get('/api/status', (req, res) => res.json({ isScanning: cache.scraping, cachedCount: cache.listings.length, lastScraped: cache.lastScraped, error: cache.error }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`DealHunter backend running on port ${PORT}`);
  scrapeCarBids();
  setInterval(scrapeCarBids, SCRAPE_INTERVAL_MS);
});
