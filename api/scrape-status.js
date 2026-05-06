// Vercel Serverless Function: GET /api/scrape-status?runId=xxx&apifyToken=yyy
// Returns the current status of an Apify run. Designed to be called every 5s
// from the client until status === 'SUCCEEDED' or terminal error.

const APIFY_BASE = 'https://api.apify.com/v2';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  // Accept both GET (with query params) and POST (with body)
  let runId, token;
  if (req.method === 'GET') {
    const u = new URL(req.url, `http://${req.headers.host}`);
    runId = u.searchParams.get('runId');
    token = u.searchParams.get('apifyToken');
  } else if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    } catch (e) {
      return json(res, 400, { error: 'Invalid JSON body' });
    }
    runId = body.runId;
    token = body.apifyToken;
  } else {
    return json(res, 405, { error: 'GET or POST only' });
  }

  if (!runId) return json(res, 400, { error: 'Missing runId' });
  if (!token) return json(res, 400, { error: 'Missing apifyToken' });

  // Apify run details endpoint
  const url = `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j?.error?.message || JSON.stringify(j); }
      catch { detail = await r.text().catch(() => ''); }
      return json(res, r.status, { error: `Apify HTTP ${r.status}: ${detail.slice(0, 300)}` });
    }
    const data = await r.json();
    const run = data?.data;
    if (!run) return json(res, 502, { error: 'Apify returned no run data' });

    // Compute elapsed seconds
    const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
    const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
    const elapsedSec = startedAt
      ? Math.round(((finishedAt || Date.now()) - startedAt) / 1000)
      : null;

    return json(res, 200, {
      ok: true,
      runId: run.id,
      status: run.status,            // READY, RUNNING, SUCCEEDED, FAILED, ABORTED, TIMED-OUT
      datasetId: run.defaultDatasetId,
      elapsedSec,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      // Useful stats during running
      stats: {
        runtimeSecs: run.stats?.runTimeSecs,
        netRxBytes: run.stats?.netRxBytes,
        computeUnits: run.stats?.computeUnits,
      },
    });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
}

module.exports = handler;
