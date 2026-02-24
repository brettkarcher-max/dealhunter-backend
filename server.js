const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Stores the last scraped results so the frontend can fetch instantly
// without waiting for a new scrape every time.
let cache = {
  listings: [],
  lastScraped: null,
  scraping: false,
  error: null,
};

const SCRAPE_INTERVAL_MS = 20 * 60 * 1000; // re-scrape every 20 minutes

// ─── Scraper ──────────────────────────────────────────────────────────────────
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
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    // Mask automation signals
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    // Block images/fonts to speed up loading
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', (route) =>
      route.abort()
    );

    console.log('Navigating to Cars & Bids...');
    await page.goto('https://carsandbids.com/auctions/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for auction listings to appear
    await page.waitForSelector('[class*="auction"]', { timeout: 15000 }).catch(() => {
      console.log('Auction selector not found, trying fallback...');
    });

  // Give JS a moment to hydrate
    await page.waitForTimeout(2000);

    const pageHTML = await page.content();
    console.log('PAGE SNAPSHOT:', pageHTML.substring(0, 3000));
	console.log('PAGE TITLE:', await page.title());
	console.log('PAGE URL:', page.url());

    // Scrape all visible auction cards
    const rawListings = await page.evaluate(() => {
      const results = [];

      // Cars & Bids uses various class patterns — we cast a wide net
      const cards = document.querySelectorAll(
        'li[class*="auction"], div[class*="auction-item"], article[class*="auction"]'
      );

      cards.forEach((card) => {
        try {
          // Title / year / make / model
          const titleEl =
            card.querySelector('[class*="title"] h2') ||
            card.querySelector('h2') ||
            card.querySelector('[class*="title"]');
          const title = titleEl?.innerText?.trim() || '';

          // Current bid
          const bidEl =
            card.querySelector('[class*="bid"] [class*="amount"]') ||
            card.querySelector('[class*="current-bid"]') ||
            card.querySelector('[class*="bid-amount"]');
          const bidText = bidEl?.innerText?.trim() || '';
          const bid = parseInt(bidText.replace(/[^0-9]/g, '')) || 0;

          // Time remaining
          const timeEl =
            card.querySelector('[class*="countdown"]') ||
            card.querySelector('[class*="time"]') ||
            card.querySelector('time');
          const timeText = timeEl?.innerText?.trim() || '';

          // Bid count
          const bidsEl = card.querySelector('[class*="bid-count"]') ||
            card.querySelector('[class*="bids"]');
          const bidsText = bidsEl?.innerText?.trim() || '';
          const bidCount = parseInt(bidsText.replace(/[^0-9]/g, '')) || 0;

          // No reserve indicator
          const noReserve =
            card.innerText?.toLowerCase().includes('no reserve') ||
            !!card.querySelector('[class*="no-reserve"]');

          // Location
          const locationEl = card.querySelector('[class*="location"]');
          const location = locationEl?.innerText?.trim() || '';

          // Auction URL
          const linkEl = card.querySelector('a[href*="/auctions/"]');
          const href = linkEl?.getAttribute('href') || '';
          const url = href.startsWith('http') ? href : `https://carsandbids.com${href}`;

          // Thumbnail image
          const imgEl = card.querySelector('img');
          const image = imgEl?.src || imgEl?.dataset?.src || '';

          if (title && bid > 0) {
            results.push({ title, bid, timeText, bidCount, noReserve, location, url, image });
          }
        } catch (e) {
          // Skip malformed cards
        }
      });

      return results;
    });

    console.log(`Found ${rawListings.length} raw listings.`);

    // ── Parse & enrich each listing ──────────────────────────────────────────
    const listings = rawListings.map((raw, idx) => {
      const parsed = parseTitle(raw.title);
      const hoursLeft = parseTimeLeft(raw.timeText);
      const marketValue = estimateMarketValue(parsed.year, parsed.make, parsed.model, raw.bid);
      const discountPct = marketValue > 0
        ? Math.round(((marketValue - raw.bid) / marketValue) * 100)
        : 0;
      const dealScore = calcDealScore(discountPct, hoursLeft, raw.bidCount, raw.noReserve);

      return {
        id: `cnb-${idx}-${Date.now()}`,
        year: parsed.year,
        make: parsed.make,
        model: parsed.model,
        trim: parsed.trim,
        title: raw.title,
        currentBid: raw.bid,
        marketValue,
        discountPct,
        dealScore,
        hoursLeft,
        bids: raw.bidCount,
        noReserve: raw.noReserve,
        location: raw.location || 'United States',
        url: raw.url,
        image: raw.image,
        timeText: raw.timeText,
        scrapedAt: new Date().toISOString(),
      };
    });

    cache.listings = listings;
    cache.lastScraped = new Date().toISOString();
    console.log(`[${new Date().toISOString()}] Scrape complete. ${listings.length} listings cached.`);

  } catch (err) {
    console.error('Scrape failed:', err.message);
    cache.error = err.message;
  } finally {
    if (browser) await browser.close();
    cache.scraping = false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseTitle(title) {
  // e.g. "2003 BMW M5 (E39)" or "1995 Porsche 911 Carrera"
  const match = title.match(/^(\d{4})\s+([A-Za-z\-]+)\s+(.+?)(?:\s*\((.+)\))?$/);
  if (match) {
    const [, year, make, rest, trim] = match;
    const parts = rest.trim().split(/\s+/);
    const model = parts[0];
    const subTrim = parts.slice(1).join(' ');
    return {
      year: parseInt(year),
      make: make.trim(),
      model: model.trim(),
      trim: trim || subTrim || '',
    };
  }
  return { year: 0, make: '', model: title, trim: '' };
}

function parseTimeLeft(text) {
  if (!text) return 48;
  text = text.toLowerCase();

  // "2d 4h" or "2 days 4 hours"
  const days = (text.match(/(\d+)\s*d/) || [])[1];
  const hours = (text.match(/(\d+)\s*h/) || [])[1];
  const mins = (text.match(/(\d+)\s*m/) || [])[1];

  let total = 0;
  if (days) total += parseInt(days) * 24;
  if (hours) total += parseInt(hours);
  if (mins) total += parseInt(mins) / 60;

  // If we got "Ending soon" type text
  if (total === 0 && (text.includes('ending') || text.includes('soon'))) return 0.5;

  return total || 48;
}

function estimateMarketValue(year, make, model, currentBid) {
  // Heuristic market value estimator based on make/model/year
  // In a production app you'd call KBB API or similar
  const makeModel = `${make} ${model}`.toLowerCase();

  let base = currentBid * 1.3; // Default: assume 30% above current bid

  // Premium multipliers for known desirable cars
  const premiums = [
    [/porsche.*911/, 2.2],
    [/porsche.*boxster|cayman/, 1.4],
    [/bmw.*m3/, 1.8],
    [/bmw.*m5/, 1.7],
    [/bmw.*m2|m4/, 1.6],
    [/mercedes.*amg|c63|e63|s63/, 1.7],
    [/honda.*s2000/, 1.9],
    [/honda.*nsx|acura.*nsx/, 2.5],
    [/toyota.*supra/, 2.4],
    [/toyota.*land cruiser/, 1.6],
    [/mazda.*rx-7/, 1.8],
    [/mazda.*miata|mx-5/, 1.3],
    [/nissan.*skyline|gtr|gt-r/, 2.2],
    [/nissan.*370z|350z/, 1.3],
    [/mitsubishi.*evo|evolution/, 1.7],
    [/subaru.*sti|wrx/, 1.5],
    [/ford.*mustang.*gt500|shelby/, 1.8],
    [/ford.*gt/, 3.0],
    [/chevrolet.*corvette.*z06/, 1.6],
    [/chevrolet.*corvette/, 1.4],
    [/dodge.*viper/, 1.8],
    [/ferrari/, 2.0],
    [/lamborghini/, 2.0],
    [/aston martin/, 1.8],
    [/mclaren/, 2.0],
    [/lotus/, 1.5],
    [/land rover.*defender/, 1.8],
    [/land rover.*range rover/, 1.4],
    [/lexus.*lfa/, 3.0],
    [/lexus.*is-f|is f/, 1.4],
    [/audi.*rs/, 1.6],
    [/volkswagen.*gti|golf r/, 1.3],
    [/volkswagen.*r32/, 1.5],
  ];

  for (const [pattern, multiplier] of premiums) {
    if (pattern.test(makeModel)) {
      base = currentBid * multiplier;
      break;
    }
  }

  // Age adjustments: older cars in certain ranges can be worth more
  if (year && year >= 1970 && year <= 1985) base *= 1.15;
  if (year && year >= 1986 && year <= 1995) base *= 1.05;

  return Math.round(base / 100) * 100; // round to nearest $100
}

function calcDealScore(discountPct, hoursLeft, bidCount, noReserve) {
  let score = 0;

  // Discount is the biggest factor
  if (discountPct >= 40) score += 50;
  else if (discountPct >= 30) score += 42;
  else if (discountPct >= 20) score += 32;
  else if (discountPct >= 15) score += 22;
  else if (discountPct >= 10) score += 12;
  else score += 0;

  // Urgency bonus — closing soon = opportunity
  if (hoursLeft <= 1) score += 20;
  else if (hoursLeft <= 3) score += 15;
  else if (hoursLeft <= 6) score += 10;
  else if (hoursLeft <= 12) score += 5;

  // No reserve is a huge bonus — guaranteed to sell
  if (noReserve) score += 20;

  // Low bid count = less competition
  if (bidCount < 5) score += 10;
  else if (bidCount < 15) score += 5;

  return Math.min(score, 99);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastScraped: cache.lastScraped, scraping: cache.scraping });
});

// Main listings endpoint — supports filtering
app.get('/api/listings', async (req, res) => {
  const {
    closeHours = 24,
    minDiscount = 0,
    maxBudget,
    noReserveOnly = 'false',
    refresh = 'false',
  } = req.query;

  // Trigger a fresh scrape if requested or cache is stale/empty
  const cacheAge = cache.lastScraped
    ? (Date.now() - new Date(cache.lastScraped).getTime()) / 1000 / 60
    : Infinity;

  if (refresh === 'true' || cache.listings.length === 0 || cacheAge > 20) {
    if (!cache.scraping) {
      scrapeCarBids(); // fire async, don't await — return cached data immediately if available
    }

    // If we have no data at all, wait for the first scrape
    if (cache.listings.length === 0) {
      let waited = 0;
      while (cache.scraping && waited < 60000) {
        await new Promise((r) => setTimeout(r, 500));
        waited += 500;
      }
    }
  }

  if (cache.error && cache.listings.length === 0) {
    return res.status(500).json({ error: cache.error });
  }

  // Apply filters
  let filtered = cache.listings.filter((l) => {
    if (parseFloat(closeHours) && l.hoursLeft > parseFloat(closeHours)) return false;
    if (parseFloat(minDiscount) && l.discountPct < parseFloat(minDiscount)) return false;
    if (maxBudget && l.currentBid > parseFloat(maxBudget)) return false;
    if (noReserveOnly === 'true' && !l.noReserve) return false;
    return true;
  });

  // Sort by deal score
  filtered.sort((a, b) => b.dealScore - a.dealScore);

  res.json({
    listings: filtered,
    total: filtered.length,
    lastScraped: cache.lastScraped,
    scraping: cache.scraping,
    cacheAgeMinutes: Math.round(cacheAge),
  });
});

// Force a manual re-scrape
app.post('/api/scrape', (req, res) => {
  if (cache.scraping) {
    return res.json({ message: 'Scrape already in progress', scraping: true });
  }
  scrapeCarBids();
  res.json({ message: 'Scrape started', scraping: true });
});

// Alias used by the frontend
app.post('/api/scan', (req, res) => {
  if (cache.scraping) {
    return res.json({ message: 'Scrape already in progress', isScanning: true });
  }
  scrapeCarBids();
  res.json({ message: 'Scrape started', isScanning: true });
});

// Status endpoint polled by the frontend during a scrape
app.get('/api/status', (req, res) => {
  res.json({
    isScanning: cache.scraping,
    cachedCount: cache.listings.length,
    lastScraped: cache.lastScraped,
    error: cache.error,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`DealHunter backend running on port ${PORT}`);
  console.log('Running initial scrape...');
  scrapeCarBids();

  // Schedule recurring scrapes
  setInterval(scrapeCarBids, SCRAPE_INTERVAL_MS);
});
