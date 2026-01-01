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

    // SEO Indexing details - viktig for å finne indekseringsproblemer
    const seoIndexing = {
      // Er siden blokket fra indeksering?
      isCrawlable: {
        passed: audits['is-crawlable']?.score === 1,
        title: audits['is-crawlable']?.title,
        description: audits['is-crawlable']?.description,
        details: audits['is-crawlable']?.details?.items || []
      },
      // Robots.txt sjekk
      robotsTxt: {
        passed: audits['robots-txt']?.score === 1,
        title: audits['robots-txt']?.title,
        description: audits['robots-txt']?.description
      },
      // Canonical URL
      canonical: {
        passed: audits['canonical']?.score === 1,
        title: audits['canonical']?.title,
        description: audits['canonical']?.description,
        url: audits['canonical']?.details?.items?.[0]?.href || null
      },
      // Meta description
      metaDescription: {
        passed: audits['meta-description']?.score === 1,
        title: audits['meta-description']?.title,
        description: audits['meta-description']?.description,
        content: audits['meta-description']?.details?.items?.[0]?.description || null
      },
      // HTTP status
      httpStatusCode: {
        passed: audits['http-status-code']?.score === 1,
        statusCode: audits['http-status-code']?.numericValue || null
      },
      // Hreflang
      hreflang: {
        passed: audits['hreflang']?.score === 1,
        title: audits['hreflang']?.title
      },
      // Plugins (Flash etc)
      plugins: {
        passed: audits['plugins']?.score === 1,
        title: audits['plugins']?.title
      },
      // Tap targets (mobilvennlighet)
      tapTargets: {
        passed: audits['tap-targets']?.score === 1,
        title: audits['tap-targets']?.title,
        description: audits['tap-targets']?.description
      },
      // Font størrelse
      fontSize: {
        passed: audits['font-size']?.score === 1,
        title: audits['font-size']?.title
      },
      // Alle SEO-problemer samlet
      problems: []
    };

    // Samle alle SEO-problemer
    if (!seoIndexing.isCrawlable.passed) {
      seoIndexing.problems.push({
        severity: 'critical',
        type: 'noindex',
        title: 'Siden er blokkert fra indeksering!',
        description: 'Siden har noindex-tag eller er blokkert i robots.txt. Google vil IKKE indeksere denne siden.',
        fix: 'Fjern noindex fra meta-tag eller X-Robots-Tag header. I WordPress/Yoast: Gå til innlegget → Yoast SEO → Avansert → Sett "Tillat søkemotorer å vise dette innholdet" til Ja.'
      });
    }
    if (!seoIndexing.robotsTxt.passed) {
      seoIndexing.problems.push({
        severity: 'warning',
        type: 'robots',
        title: 'Robots.txt problem',
        description: 'Det er et problem med robots.txt-filen.',
        fix: 'Sjekk robots.txt på ' + finalUrl + '/robots.txt'
      });
    }
    if (!seoIndexing.canonical.passed) {
      seoIndexing.problems.push({
        severity: 'warning',
        type: 'canonical',
        title: 'Mangler canonical URL',
        description: 'Siden mangler eller har ugyldig canonical URL. Dette kan føre til duplikat innhold-problemer.',
        fix: 'Legg til <link rel="canonical" href="URL"> i <head>. I WordPress/Yoast settes dette automatisk.'
      });
    }
    if (!seoIndexing.metaDescription.passed) {
      seoIndexing.problems.push({
        severity: 'medium',
        type: 'meta-description',
        title: 'Mangler meta description',
        description: 'Siden mangler meta description. Dette påvirker hvordan siden vises i søkeresultater.',
        fix: 'Legg til en beskrivende meta description (150-160 tegn). I WordPress/Yoast: Rediger innlegget → Yoast SEO → Skriv inn meta description.'
      });
    }

    const rapport = {
      URL: finalUrl,
      timestamp: new Date().toISOString(),
      SEO: categories.seo.score,
      Performance: categories.performance.score,
      Accessibility: categories.accessibility.score,
      BestPractices: categories["best-practices"].score,
      CoreWebVitals: coreWebVitals,
      PerformanceDetails: performanceDetails,
      SEOIndexing: seoIndexing
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

    // Bygg SEO-problemer tekst
    const seoProblems = analysisData.SEOIndexing?.problems?.length > 0
      ? analysisData.SEOIndexing.problems.map(p => `- [${p.severity.toUpperCase()}] ${p.title}: ${p.description}`).join('\n')
      : 'Ingen kritiske SEO-indekseringsproblemer funnet';

    const prompt = `Du er en ekspert på weboptimalisering og SEO, og skal gi KONKRETE, HANDLINGSRETTEDE anbefalinger på norsk.

Analysedata for nettsiden ${analysisData.URL}:

SCORES:
- Performance: ${Math.round(analysisData.Performance * 100)}%
- SEO: ${Math.round(analysisData.SEO * 100)}%
- Accessibility: ${Math.round(analysisData.Accessibility * 100)}%
- Best Practices: ${Math.round(analysisData.BestPractices * 100)}%

SEO INDEKSERING (KRITISK!):
- Kan Google indeksere siden: ${analysisData.SEOIndexing?.isCrawlable?.passed ? 'JA ✓' : 'NEI ✗ (BLOKKERT!)'}
- Robots.txt OK: ${analysisData.SEOIndexing?.robotsTxt?.passed ? 'JA ✓' : 'NEI ✗'}
- Canonical URL: ${analysisData.SEOIndexing?.canonical?.passed ? 'OK ✓' : 'MANGLER ✗'}
- Meta description: ${analysisData.SEOIndexing?.metaDescription?.passed ? 'OK ✓' : 'MANGLER ✗'}

SEO-PROBLEMER FUNNET:
${seoProblems}

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
Gi 3-5 KONKRETE anbefalinger basert på de VERSTE problemene. PRIORITER SEO-INDEKSERINGSPROBLEMER FØRST hvis siden er blokkert fra indeksering!

For HVER anbefaling, gi:
1. Hva problemet er
2. Steg-for-steg instruksjoner for å fikse det (spesifikt for WordPress/Yoast hvis relevant)
3. Spesifikke verktøy eller kode som trengs

FORMAT (bruk denne strukturen for HVER anbefaling):

### [Prioritet 1-5]: [Kort tittel]

**Problem:** [Beskriv problemet kort]

**Steg for å fikse:**
1. [Konkret steg med detaljer - inkluder menyvalg i WordPress]
2. [Neste steg]
3. [osv.]

**Kode/Eksempel:**
\`\`\`
[Vis konkret kode eller konfigurasjon hvis relevant]
\`\`\`

---

Vær SPESIFIKK og gi WordPress-spesifikke instruksjoner når mulig. For eksempel: "Gå til WordPress Admin → Innlegg → [artikkelnavn] → Scroll ned til Yoast SEO → Klikk på Avansert-fanen → Sett 'Tillat søkemotorer å vise dette innholdet' til Ja → Klikk Oppdater"`;

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