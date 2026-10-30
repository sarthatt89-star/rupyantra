'use strict';

/*
 * File banane ka API (api/file.js)
 *   POST /api/file   body { prompt, format: md|csv|html|txt|json, part, tail?, history? }
 *   => { ok, text, truncated, part, format, unverified }   (truncated=true => browser agla part maangega)
 *
 * Kaam lib/file-gen.js karta hai. Ye file sirf: rate limit, body check, friendly error, ginti.
 * Ye mehnga raasta hai (har part ek bada AI call), isliye limit chat se sakht hai.
 * Ginti (sirf naam aur count): file.started, file.parts, file.provider.<naam>, file.rejected, file.fail
 */

const eh = require('../lib/error-handler');
const stats = require('../lib/stats');

const PER_MIN = 6;
const PER_HOUR = 40;
const GLOBAL_PER_MIN = 60;
const MAX_BODY_CHARS = 80000;

const hits = new Map();
let globalHits = [];

function limited(ip) {
  const now = Date.now();
  globalHits = globalHits.filter(t => now - t < 60000);
  if (globalHits.length >= GLOBAL_PER_MIN) return true;

  const arr = (hits.get(ip) || []).filter(t => now - t < 3600000);
  const lastMinute = arr.filter(t => now - t < 60000).length;
  if (lastMinute >= PER_MIN || arr.length >= PER_HOUR) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  globalHits.push(now);

  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      if (!times.length || now - times[times.length - 1] > 3600000) hits.delete(k);
    }
  }
  return false;
}

function clientIp(req) {
  const f = req.headers && req.headers['x-forwarded-for'];
  return (typeof f === 'string' ? f.split(',')[0].trim() : '') ||
    (req.headers && typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : '') ||
    (req.socket && req.socket.remoteAddress) || 'unknown';
}

let fileGen = null;
const getFileGen = () => {
  if (!fileGen) fileGen = require('../lib/file-gen').createFileGen({});
  return fileGen;
};

function sendError(res, err, ctx) {
  const out = eh.toHttpResponse(err, ctx);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  return res.status(out.status).json({ ok: false, ...out.body });
}

async function handler(req, res, meta) {
  const requestId = (meta && meta.requestId) || eh.requestIdFrom(req);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, message: 'Sirf GET aur POST allowed hain.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body && typeof body === 'object' ? body : {};

  let size = 0;
  try { size = JSON.stringify(body).length; } catch (_) { size = MAX_BODY_CHARS + 1; }
  if (size > MAX_BODY_CHARS) {
    return res.status(413).json({ ok: false, message: 'Request bahut badi hai. Chhota request bhejo.', requestId });
  }

  if (limited(clientIp(req))) {
    return sendError(res, new eh.AppError({
      type: eh.ERROR_TYPES.RATE_LIMIT, scope: 'user', retryAfterMs: 60000, code: 'RATE_LIMITED', message: 'ip rate limit'
    }), { requestId, where: 'file', scope: 'user' });
  }

  let out;
  try {
    out = await getFileGen().generate(body);
  } catch (e) {
    eh.logError(e, { requestId, where: 'file' });
    await stats.record({ 'file.fail': 1 });
    return sendError(res, e, { requestId, where: 'file', scope: 'provider', source: 'provider' });
  }

  if (!out.ok) {
    await stats.record({ 'file.rejected': 1 });
    return res.status(out.status || 400).json({ ok: false, error: out.error, message: out.message, requestId });
  }

  await stats.record({
    'file.parts': 1,
    ['file.provider.' + out.provider]: 1,
    ...(out.part === 1 ? { 'file.started': 1 } : {})
  });
  return res.status(200).json({
    ok: true, text: out.text, truncated: out.truncated, part: out.part, format: out.format,
    unverified: out.unverified, requestId
  });
}

module.exports = eh.wrapHandler(handler, { where: 'file' });
module.exports.__test = { handler, limited };
