'use strict';

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const PORT = process.env.PORT || 3001;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Company definitions
// ---------------------------------------------------------------------------

const STATUSPAGE_COMPANIES = [
  { id: 'openai',      name: 'OpenAI',        url: 'https://status.openai.com',          emoji: '🤖', category: 'ai' },
  { id: 'anthropic',   name: 'Anthropic',     url: 'https://status.anthropic.com',       emoji: '🧠', category: 'ai' },
  { id: 'github',      name: 'GitHub',        url: 'https://www.githubstatus.com',       emoji: '🐙', category: 'dev' },
  { id: 'vercel',      name: 'Vercel',        url: 'https://www.vercel-status.com',      emoji: '▲',  category: 'dev' },
  { id: 'discord',     name: 'Discord',       url: 'https://discordstatus.com',          emoji: '💬', category: 'social' },
  { id: 'cloudflare',  name: 'Cloudflare',    url: 'https://www.cloudflarestatus.com',   emoji: '🔶', category: 'infra' },
  { id: 'zoom',        name: 'Zoom',          url: 'https://status.zoom.us',             emoji: '📹', category: 'social' },
  { id: 'atlassian',   name: 'Atlassian',     url: 'https://status.atlassian.com',       emoji: '🔷', category: 'dev' },
  { id: 'stability',   name: 'Stability AI',  url: 'https://status.stability.ai',        emoji: '🎨', category: 'ai' },
  { id: 'elevenlabs',  name: 'ElevenLabs',   url: 'https://status.elevenlabs.io',        emoji: '🎙️', category: 'ai' },
  { id: 'groq',        name: 'Groq',         url: 'https://groqstatus.com',              emoji: '⚡', category: 'ai' },
  { id: 'cohere',      name: 'Cohere',       url: 'https://status.cohere.com',           emoji: '🔮', category: 'ai' },
  { id: 'deepseek',    name: 'DeepSeek',     url: 'https://status.deepseek.com',         emoji: '🐋', category: 'ai' },
  { id: 'heygen',      name: 'HeyGen',       url: 'https://status.heygen.com',           emoji: '🎬', category: 'ai' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function computeUptimeFromIncidents(incidents, windowDays = 90) {
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const windowStart = now - windowMs;

  let totalDownMs = 0;

  for (const incident of incidents) {
    // Skip no-impact incidents
    if (incident.impact === 'none') continue;

    const start = new Date(incident.created_at).getTime();
    const end = incident.resolved_at
      ? new Date(incident.resolved_at).getTime()
      : now; // ongoing incidents count as down until now

    // Clamp to the window
    const clampedStart = Math.max(start, windowStart);
    const clampedEnd = Math.min(end, now);

    if (clampedEnd <= clampedStart) continue;

    totalDownMs += clampedEnd - clampedStart;
  }

  const uptime = Math.max(0, (1 - totalDownMs / windowMs) * 100);
  return Math.min(100, uptime);
}

function normalizeStatuspageStatus(indicator) {
  const map = {
    none:                'operational',
    minor:               'degraded',
    major:               'partial_outage',
    critical:            'major_outage',
    maintenance:         'degraded',
  };
  return map[indicator] || 'unknown';
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchStatuspageCompany(company) {
  const [summaryRes, incidentsRes] = await Promise.all([
    fetchWithTimeout(`${company.url}/api/v2/summary.json`),
    fetchWithTimeout(`${company.url}/api/v2/incidents.json`),
  ]);

  const summary   = await summaryRes.json();
  const incidents = await incidentsRes.json();

  const allIncidents = incidents.incidents || [];
  const activeIncidents = allIncidents.filter(i => !i.resolved_at);
  const recentIncidents = allIncidents.slice(0, 5);
  const uptimePercent  = computeUptimeFromIncidents(allIncidents);
  const currentStatus  = normalizeStatuspageStatus(summary.status?.indicator);

  return {
    id:               company.id,
    name:             company.name,
    emoji:            company.emoji,
    category:         company.category,
    statusPageUrl:    company.url,
    currentStatus,
    uptimePercent:    parseFloat(uptimePercent.toFixed(4)),
    uptimeWindowDays: 90,
    activeIncidents:  activeIncidents.length,
    recentIncidents,
    lastUpdated:      new Date().toISOString(),
    error:            null,
  };
}

function buildErrorEntry(company, errorMessage) {
  return {
    id:               company.id,
    name:             company.name,
    emoji:            company.emoji || '❓',
    category:         company.category || 'unknown',
    statusPageUrl:    company.url || company.statusPageUrl || null,
    currentStatus:    'unknown',
    uptimePercent:    null,
    uptimeWindowDays: null,
    activeIncidents:  null,
    recentIncidents:  [],
    lastUpdated:      new Date().toISOString(),
    error:            errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Aggregate fetch
// ---------------------------------------------------------------------------

async function fetchAllCompanies() {
  const statuspageTasks = STATUSPAGE_COMPANIES.map(company =>
    fetchStatuspageCompany(company).catch(err => buildErrorEntry(company, err.message))
  );

  const results = await Promise.allSettled(statuspageTasks);
  return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
}

async function fetchSingleCompany(companyId) {
  const statuspageMatch = STATUSPAGE_COMPANIES.find(c => c.id === companyId);
  if (statuspageMatch) {
    return fetchStatuspageCompany(statuspageMatch).catch(err => buildErrorEntry(statuspageMatch, err.message));
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cache = null;

function isCacheValid() {
  return cache !== null && (Date.now() - cache.fetchedAtMs) < CACHE_TTL_MS;
}

function getCacheAgeSeconds() {
  if (!cache) return null;
  return Math.floor((Date.now() - cache.fetchedAtMs) / 1000);
}

async function getOrFetchAll() {
  if (isCacheValid()) return { companies: cache.companies, cacheAge: getCacheAgeSeconds() };

  const companies  = await fetchAllCompanies();
  cache = { companies, fetchedAtMs: Date.now() };

  return { companies, cacheAge: 0 };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', async (req, res) => {
  try {
    const { companies, cacheAge } = await getOrFetchAll();
    res.json({
      fetchedAt: new Date().toISOString(),
      cacheAge,
      companies,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/:company', async (req, res) => {
  const { company: companyId } = req.params;

  try {
    const result = await fetchSingleCompany(companyId);

    if (!result) {
      return res.status(404).json({ error: `Unknown company: ${companyId}` });
    }

    // Bust cache entry for this company so the next full fetch picks up fresh data
    if (cache) {
      cache.companies = cache.companies.map(c => c.id === companyId ? result : c);
    }

    res.json({
      fetchedAt: new Date().toISOString(),
      cacheAge:  0,
      company:   result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AI Downtime proxy running on http://localhost:${PORT}`);
});