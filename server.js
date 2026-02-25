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

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendDailyEmail() {
  const topDeals = cache.listings
    .filter(l => l.hoursLeft <= 24 && l.dealScore >= 60)
    .sort((a, b) => b.dealScore - a.dealScore)
    .slice(0, 10);

  if (topDeals.length === 0) {
    console.log('No deals to email today.');
    return;
  }

  const dealsHtml = topDeals.map(car => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #eee">
        <a href="${car.url}" style="font-weight:bold;color:#e85d26;text-decoration:none">${car.title}</a><br>
        <span style="color:#666;font-size:13px">${car.subTitle || car.mileage || ''}</span>
      </td>
      <td style="padding:12px;border-bottom:1px solid #eee;text-align:right">
        <strong>$${car.currentBid.toLocaleString()}</strong><br>
        <span style="color:#666;font-size:13px">Est. $${car.marketValue.toLocaleString()}</span>
      </td>
      <td style="padding:12px;border-bottom:1px solid #eee;text-align:center">
        <span style="background:${car.dealScore >= 90 ? '#ff4444' : car.dealScore >= 75 ? '#ff8c00' : '#4CAF50'};color:white;padding:4px 10px;border-radius:12px;font-size:13px">
          ${car.dealScore >= 90 ? '🔥' : '⭐'} ${car.dealScore}
        </span>
      </td>
      <td style="padding:12px;border-bottom:1px solid #eee;text-align:center;color:#666;font-size:13px">
        ${car.discountPct}% below est.<br>
        ${car.hoursLeft < 1 ? 'Ending soon!' : car.hoursLeft < 24 ? Math.round(car.hoursLeft) + 'h left' : Math.round(car.hoursLeft / 24) + 'd left'}
        ${car.noReserve ? '<br><span style="color:#e85d26;font-weight:bold">NO RESERVE</span>' : ''}
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:#1a1a2e;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="color:white;margin:0;font-size:24px">🔥 DealHunter Daily Digest</h1>
        <p style="color:#aaa;margin:8px 0 0">${new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })} · ${cache.listings.length} auctions scanned</p>
      </div>
      <div style="background:white;padding:24px;border-radius:0 0 8px 8px;border:1px solid #eee">
        <h2 style="color:#333;margin-top:0">Top ${topDeals.length} Deals Closing Today</h2>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px">VEHICLE</th>
              <th style="padding:10px 12px;text-align:right;color:#666;font-size:13px">BID / EST VALUE</th>
              <th style="padding:10px 12px;text-align:center;color:#666;font-size:13px">SCORE</th>
              <th style="padding:10px 12px;text-align:center;color:#666;font-size:13px">DETAILS</th>
            </tr>
          </thead>
          <tbody>${dealsHtml}</tbody>
        </table>
        <p style="color:#999;font-size:12px;margin-top:24px">
          Market values are estimates. Always do your own research before bidding.<br>
          <a href="https://carsandbids.com" style="color:#e85d26">View all auctions on Cars & Bids →</a>
        </p>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: 'DealHunter <onboarding@resend.dev>',
      to: process.env.ALERT_EMAIL,
      subject: `🔥 ${topDeals.length} Car Deals Closing Today - DealHunter`,
      html,
    });
    console.log('Daily email sent successfully!');
  } catch (err) {
    console.error('Failed to send email:', err.message);
  }
}

function scheduleDailyEmail() {
  const now = new Date();
  const next10am = new Date();
  next10am.setHours(10, 0, 0, 0);
  if (next10am <= now) next10am.setDate(next10am.getDate() + 1);
  const msUntil = next10am.getTime() - now.getTime();
  console.log(`Daily email scheduled in ${Math.round(msUntil / 1000 / 60)} minutes`);
  setTimeout(() => {
    sendDailyEmail();
    setInterval(sendDailyEmail, 24 * 60 * 60 * 1000);
  }, msUntil);
}

async function scrapeCarBids() {
  if (cache.scraping) {
    console.log('Scrape already in progress, skipping.');
    return;
  }

  cache.scraping = true;
  cache.error = null;
  console.log(`[${new Date().toISOString()}] Starting scrape v5...`);

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

    // Block fonts only
    await page.route('**/*.{woff,woff2,ttf,eot}', route => route.abort());

    let auctionData = null;
page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('/autos/auctions') || url.includes('/v2/autos')) {
    try {
      console.log('Intercepted API:', url);
      const json = await response.json();
      if (json && (json.auctions || json.results || Array.isArray(json))) {
        auctionData = json;
        console.log('Got API data, keys:', Object.keys(json));
      }
    } catch (e) {}
  }
});

    console.log('Loading Cars and Bids auctions page...');
    await page.goto('https://carsandbids.com/auctions/', {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    console.log('Page title:', await page.title());
    console.log('Page URL:', page.url());

    // Wait for initial render
    await page.waitForTimeout(3000);

    // Incrementally scroll to trigger lazy loading of all listings
    console.log('Scrolling to load all listings...');
    for (let i = 1; i <= 15; i++) {
      await page.evaluate((step) => window.scrollTo(0, step * 600), i);
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(2000);

    // Scroll back to top then bottom again
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    if (auctionData) {
  console.log('Using intercepted API data!');
  const rawAuctions = auctionData.auctions || auctionData.results || auctionData.data || [];
  console.log('API auction count:', rawAuctions.length);
    if (rawAuctions.length > 0) console.log('Sample auction:', JSON.stringify(rawAuctions[0]));

  const listings = rawAuctions.map((auction, idx) => {
    const title = auction.title || `${auction.year} ${auction.make} ${auction.model}` || '';
    const currentBid = auction.current_bid || auction.currentBid || auction.bid || 0;
    const noReserve = auction.no_reserve || auction.noReserve || false;
    const bidCount = auction.bid_count || auction.bidCount || auction.bids || 0;
    const parsed = parseTitle(auction.title || '');
    const year = auction.year || parsed.year || 0;
    const make = auction.make || parsed.make || '';
    const model = auction.model || parsed.model || '';
    const trim = auction.trim || parsed.trim || '';
    const mileage = auction.mileage || '';
    const subTitle = auction.sub_title || '';
    const slug = auction.id || '';
    const url = slug ? `https://carsandbids.com/auctions/${slug}` : '';
    const image = auction.main_photo
      ? `https://${auction.main_photo.base_url}/${auction.main_photo.path}`
      : '';
    const endsAt = auction.auction_end || auction.ends_at || auction.endsAt || null;
    let hoursLeft = 48;
    if (endsAt) {
      const msLeft = new Date(endsAt).getTime() - Date.now();
      hoursLeft = Math.max(0, msLeft / 1000 / 60 / 60);
    }
    const marketValue = estimateMarketValue(year, make, model, currentBid);
    const discountPct = marketValue > 0 ? Math.round(((marketValue - currentBid) / marketValue) * 100) : 0;
    const dealScore = calcDealScore(discountPct, hoursLeft, bidCount, noReserve);
    return {
      id: `cnb-${idx}-${Date.now()}`,
      year, make, model, trim, title, subTitle, mileage, currentBid, marketValue,
      discountPct, dealScore, hoursLeft, bids: bidCount, noReserve,
      location: auction.location || 'United States',
      url, image, scrapedAt: new Date().toISOString(),
    };
  });

  cache.listings = listings;
  cache.lastScraped = new Date().toISOString();
  console.log(`API scrape complete. ${listings.length} listings cached.`);
  return;
}
    console.log('Extracting listings...');

    const rawListings = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="/auctions/"]');
      console.log('Total auction links found:', links.length);

      links.forEach(link => {
        try {
          const href = link.getAttribute('href') || '';

          // Only process actual auction listing pages
          if (!href.match(/\/auctions\/[a-zA-Z0-9]{6,}/)) return;
          if (href.includes('/auctions/search') || href.includes('/auctions/past') || href.includes('/auctions/results')) return;

          const allText = link.innerText || '';
          if (!allText || allText.length < 10) return;

          // Title must start with a year
          const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          const title = lines[0] || '';
          if (!title.match(/^\d{4}/)) return;

          // Bid amount - take the last $ amount found (most likely to be current bid)
          const bidMatches = allText.match(/\$[\d,]+/g);
          const bid = bidMatches ? parseInt(bidMatches[bidMatches.length - 1].replace(/[^0-9]/g, '')) : 0;
          if (bid === 0) return;

          // No reserve
          const noReserve = allText.toLowerCase().includes('no reserve');

          // Time remaining - handle all formats
          const daysMatch = allText.match(/(\d+)\s*days?/i);
          const hoursMatch = allText.match(/(\d+)\s*hours?/i);
          const hmsMatch = allText.match(/(\d+)h\s*(\d+)m/i);
          const minsMatch = allText.match(/(\d+)\s*mins?/i);
          const colonMatch = allText.match(/(\d+):(\d+):(\d+)/); // HH:MM:SS format
          const timeText = daysMatch ? daysMatch[0] :
            hoursMatch ? hoursMatch[0] :
            hmsMatch ? hmsMatch[0] :
            minsMatch ? minsMatch[0] :
            colonMatch ? colonMatch[0] : '';

          if (!timeText) console.log('NO TIME:', title, '|', allText.substring(0, 100));

          // Bid count
          const bidsMatch = allText.match(/(\d+)\s*bid/i);
          const bidCount = bidsMatch ? parseInt(bidsMatch[1]) : 0;

          // Image
          const imgEl = link.querySelector('img');
          const image = imgEl?.src || imgEl?.dataset?.src || '';

          const url = `https://carsandbids.com${href}`;

          results.push({ title, bid, timeText, bidCount, noReserve, url, image });
        } catch (e) {}
      });

      // Deduplicate by URL
      const seen = new Set();
      return results.filter(r => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });
    });

    console.log(`Found ${rawListings.length} raw listings`);
    if (rawListings.length > 0) {
      console.log('Sample:', JSON.stringify(rawListings[0]));
    }

    const listings = rawListings.map((raw, idx) => {
      const parsed = parseTitle(raw.title);

      // Parse hours left from timeText
      const timeStr = raw.timeText || '';
      const daysMatch = timeStr.match(/(\d+)\s*days?/i);
      const hoursMatch = timeStr.match(/(\d+)\s*hours?/i);
      const hmsMatch = timeStr.match(/(\d+)h\s*(\d+)m/i);
      const minsMatch = timeStr.match(/(\d+)\s*min/i);
      const colonMatch = timeStr.match(/(\d+):(\d+):(\d+)/);
      const hoursLeft = daysMatch ? parseInt(daysMatch[1]) * 24 :
        hoursMatch ? parseInt(hoursMatch[1]) :
        hmsMatch ? parseInt(hmsMatch[1]) + parseInt(hmsMatch[2]) / 60 :
        colonMatch ? parseInt(colonMatch[1]) + parseInt(colonMatch[2]) / 60 :
        minsMatch ? parseInt(minsMatch[1]) / 60 : 48;

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
        location: 'United States',
        url: raw.url,
        image: raw.image,
        timeText: raw.timeText,
        scrapedAt: new Date().toISOString(),
      };
    });

    cache.listings = listings;
    cache.lastScraped = new Date().toISOString();
    console.log(`Scrape complete. ${listings.length} listings cached.`);
    if (listings.length > 0) {
      console.log('First listing hoursLeft:', listings[0].hoursLeft, 'timeText:', listings[0].timeText);
    }

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
    return {
      year: parseInt(year),
      make: make.trim(),
      model: parts[0].trim(),
      trim: trim || parts.slice(1).join(' ') || '',
    };
  }
  return { year: 0, make: '', model: title, trim: '' };
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: 5, lastScraped: cache.lastScraped, scraping: cache.scraping, count: cache.listings.length });
});

app.get('/api/listings', async (req, res) => {
  const { closeHours = 24, minDiscount = 0, maxBudget, noReserveOnly = 'false' } = req.query;

  const cacheAge = cache.lastScraped
    ? (Date.now() - new Date(cache.lastScraped).getTime()) / 1000 / 60
    : Infinity;

  if (cache.listings.length === 0 || cacheAge > 20) {
    if (!cache.scraping) scrapeCarBids();
    if (cache.listings.length === 0) {
      let waited = 0;
      while (cache.scraping && waited < 90000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }
    }
  }

  if (cache.error && cache.listings.length === 0) {
    return res.status(500).json({ error: cache.error });
  }

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
  console.log(`DealHunter backend v5 running on port ${PORT}`);
  scrapeCarBids();
  setInterval(scrapeCarBids, SCRAPE_INTERVAL_MS);
  scheduleDailyEmail();
});
