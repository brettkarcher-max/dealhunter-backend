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

    // Intercept the auctions API call and capture its response
    let auctionData = null;

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/v2/autos/auctions') || url.includes('/autos/auctions')) {
        try {
          console.log('Intercepted API call:', url);
          const json = await response.json();
          console.log('API response keys:', Object.keys(json));
          auctionData = json;
        } catch (e) {
          console.log('Failed to parse intercepted response:', e.message);
        }
      }
    });

    console.log('Navigating to Cars & Bids...');
    await page.goto('https://carsandbids.com/auctions/', {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    console.log('Page title:', await page.title());

    // Give extra time for all API calls to complete
    await page.waitForTimeout(5000);

    if (!auctionData) {
      console.log('No auction API data intercepted. Trying direct page navigation...');
      // Try navigating to a different sort to trigger another API call
      await page.goto('https://carsandbids.com/auctions/?sort=ending-soon', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
    }

    if (!auctionData) {
      throw new Error('Could not intercept Cars & Bids API response. The site may have changed its API structure.');
    }

    console.log('Raw API data sample:', JSON.stringify(auctionData).substring(0, 500));

    // Parse the API response — Cars & Bids typically returns { auctions: [...] } or { results: [...] }
    const rawAuctions = auctionData.auctions || auctionData.results || auctionData.data || auctionData || [];
    console.log(`Found ${Array.isArray(rawAuctions) ? rawAuctions.length : 'unknown'} auctions in API response`);

    if (!Array.isArray(rawAuctions) || rawAuctions.length === 0) {
      console.log('Full API response:', JSON.stringify(auctionData).substring(0, 2000));
      throw new Error('API returned no auctions. Response structure may have changed.');
    }

    const listings = rawAuctions.map((auction, idx) => {
      // Extract fields from the API response
      // These field names are based on common C&B API patterns
      const title = auction.title || auction.name || `${auction.year} ${auction.make} ${auction.model}` || '';
      const year = auction.year || parseInt((title.match(/^\d{4}/) || [])[0]) || 0;
      const make = auction.make || '';
      const model = auction.model || '';
      const trim = auction.trim || auction.series || '';
      const currentBid = auction.current_bid || auction.currentBid || auction.bid || auction.price || 0;
      const noReserve = auction.no_reserve || auction.noReserve || auction.reserve === false || false;
      const bidCount = auction.bid_count || auction.bidCount || auction.bids || 0;
      const location = auction.location || auction.seller_location || auction.city || 'United States';
      const slug = auction.slug || auction.id || '';
      const url = slug ? `https://carsandbids.com/auctions/${slug}` : 'https://carsandbids.com/auctions/';
      const image = auction.thumbnail || auction.image || auction.photo ||
        (auction.images && auction.images[0]) ||
        (auction.photos && auction.photos[0]) || '';

      // Parse time remaining
      const endsAt = auction.ends_at || auction.endsAt || auction.end_time || auction.closing_at || null;
      let hoursLeft = 48;
      if (endsAt) {
        const msLeft = new Date(endsAt).getTime() - Date.now();
        hoursLeft = Math.max(0, msLeft / 1000 / 60 / 60);
      }

      const mileage = auction.mileage || auction.miles || 0;
      const marketValue = estimateMarketValue(year, make, model, currentBid);
      const discountPct = marketValue > 0 ? Math.round(((marketValue - currentBid) / marketValue) * 100) : 0;
      const dealScore = calcDealScore(discountPct, hoursLeft, bidCount, noReserve);

      return {
        id: `cnb-${idx}-${Date.now()}`,
        year, make, model, trim, title,
        currentBid, marketValue, discountPct, dealScore,
        hoursLeft, bids: bidCount, noReserve,
        location, url, image, mileage,
        scrapedAt: new Date().toISOString(),
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
