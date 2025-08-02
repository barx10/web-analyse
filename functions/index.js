const {onRequest} = require("firebase-functions/v2/https");
const lighthouse = require("lighthouse").default || require("lighthouse");
const chromeLauncher = require("chrome-launcher");

exports.scanSite = onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  const url = req.query.url;
  if (!url) return res.status(400).send("URL mangler");

  let chrome;
  try {
    chrome = await chromeLauncher.launch({ 
      chromeFlags: ["--headless", "--no-sandbox", "--disable-dev-shm-usage"] 
    });
    const options = { port: chrome.port };

    const result = await lighthouse(url, options);
    const { categories, audits, finalUrl } = result.lhr;

    // Core Web Vitals data
    const coreWebVitals = {
      LCP: audits['largest-contentful-paint']?.numericValue || 0,
      FID: audits['max-potential-fid']?.numericValue || 0,
      CLS: audits['cumulative-layout-shift']?.numericValue || 0,
      FCP: audits['first-contentful-paint']?.numericValue || 0,
      SI: audits['speed-index']?.numericValue || 0,
      TTI: audits['interactive']?.numericValue || 0,
      TBT: audits['total-blocking-time']?.numericValue || 0
    };

    // Performance metrics with more details
    const performanceDetails = {
      score: categories.performance.score,
      metrics: coreWebVitals,
      opportunities: categories.performance.auditRefs
        .filter(ref => audits[ref.id] && audits[ref.id].scoreDisplayMode === 'binary' && audits[ref.id].score < 1)
        .slice(0, 5)
        .map(ref => ({
          title: audits[ref.id].title,
          description: audits[ref.id].description,
          score: audits[ref.id].score,
          displayValue: audits[ref.id].displayValue
        }))
    };

    const rapport = {
      URL: finalUrl,
      timestamp: new Date().toISOString(),
      SEO: categories.seo.score,
      Performance: categories.performance.score,
      Accessibility: categories.accessibility.score,
      BestPractices: categories["best-practices"].score,
      CoreWebVitals: coreWebVitals,
      PerformanceDetails: performanceDetails
    };

    res.json(rapport);
  } catch (e) {
    console.error("Lighthouse error:", e);
    res.status(500).send("Feil under analyse: " + e.message);
  } finally {
    if (chrome) {
      await chrome.kill();
    }
  }
});