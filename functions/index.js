const {onRequest} = require("firebase-functions/v2/https");
const lighthouse = require("lighthouse").default || require("lighthouse");
const chromeLauncher = require("chrome-launcher");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

// AI-anbefalinger med Gemini
exports.getAISuggestions = onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(400).json({ error: "API-nøkkel mangler. Legg til din Gemini API-nøkkel." });
  }

  let analysisData;
  try {
    analysisData = req.body;
    if (!analysisData || !analysisData.URL) {
      return res.status(400).json({ error: "Analysedata mangler" });
    }
  } catch (e) {
    return res.status(400).json({ error: "Ugyldig JSON-data" });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

    const prompt = `Du er en ekspert på weboptimalisering og skal gi KONKRETE, HANDLINGSRETTEDE anbefalinger på norsk.

Analysedata for nettsiden ${analysisData.URL}:

SCORES:
- Performance: ${Math.round(analysisData.Performance * 100)}%
- SEO: ${Math.round(analysisData.SEO * 100)}%
- Accessibility: ${Math.round(analysisData.Accessibility * 100)}%
- Best Practices: ${Math.round(analysisData.BestPractices * 100)}%

CORE WEB VITALS:
- LCP (Largest Contentful Paint): ${analysisData.CoreWebVitals?.LCP?.toFixed(0)}ms ${analysisData.CoreWebVitals?.LCP > 2500 ? '(TREG)' : '(OK)'}
- FID (First Input Delay): ${analysisData.CoreWebVitals?.FID?.toFixed(0)}ms
- CLS (Cumulative Layout Shift): ${analysisData.CoreWebVitals?.CLS?.toFixed(3)}
- FCP (First Contentful Paint): ${analysisData.CoreWebVitals?.FCP?.toFixed(0)}ms
- Speed Index: ${analysisData.CoreWebVitals?.SI?.toFixed(0)}ms
- Time to Interactive: ${analysisData.CoreWebVitals?.TTI?.toFixed(0)}ms
- Total Blocking Time: ${analysisData.CoreWebVitals?.TBT?.toFixed(0)}ms

FORBEDRINGSMULIGHETER FRA LIGHTHOUSE:
${analysisData.PerformanceDetails?.opportunities?.map(o => `- ${o.title}: ${o.displayValue || ''}`).join('\n') || 'Ingen spesifikke muligheter funnet'}

OPPGAVE:
Gi 3-5 KONKRETE anbefalinger basert på de VERSTE problemene. For HVER anbefaling, gi:
1. Hva problemet er
2. Steg-for-steg instruksjoner for å fikse det
3. Spesifikke verktøy eller kode som trengs

FORMAT (bruk denne strukturen for HVER anbefaling):

### [Prioritet 1-5]: [Kort tittel]

**Problem:** [Beskriv problemet kort]

**Steg for å fikse:**
1. [Konkret steg med detaljer]
2. [Neste steg]
3. [osv.]

**Kode/Eksempel:**
\`\`\`
[Vis konkret kode eller konfigurasjon hvis relevant]
\`\`\`

---

Vær SPESIFIKK. Ikke si "optimaliser bilder" - si "Bildet hero.jpg på forsiden bør komprimeres med TinyPNG og konverteres til WebP-format. Gå til tinypng.com, last opp bildet, og erstatt det i /images/ mappen."`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({
      suggestions: text,
      model: "gemini-3-flash-preview",
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error("Gemini API error:", e);

    if (e.message?.includes('API_KEY_INVALID') || e.message?.includes('API key')) {
      return res.status(401).json({ error: "Ugyldig API-nøkkel. Sjekk at du har en gyldig Gemini API-nøkkel fra Google AI Studio." });
    }

    res.status(500).json({ error: "Feil ved AI-analyse: " + e.message });
  }
});