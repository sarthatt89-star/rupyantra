'use strict';

/*
 * Rupeyantra Mail Commands (lib/mail-commands.js)
 *
 * Mail se poochhe jaane wale tay commands ke jawab. AI/LLM ka use nahi hota: jawab seedhe ginti aur config se bante hain,
 * isliye mail mein kuch bhi likh kar AI ko bahkaya nahi ja sakta.
 *
 * Commands: help, status, keys, aaj, errors, summary
 * Jawab mein kabhi nahi: API key, password, token, user ka chat ya text.
 */

const COMMANDS = ['help', 'status', 'keys', 'aaj', 'errors', 'summary'];
const ALIASES = { today: 'aaj', error: 'errors', key: 'keys', madad: 'help', stats: 'summary' };
const PROVIDERS = ['gemini', 'groq', 'openrouter', 'openai'];

const normalize = c => {
  const w = String(c || '').trim().toLowerCase();
  return COMMANDS.includes(w) ? w : ALIASES[w] || null;
};

const NO_STATS = 'Ginti abhi chalu nahi hai. Vercel mein UPSTASH_REDIS_REST_URL aur UPSTASH_REDIS_REST_TOKEN daalo aur Redeploy karo.';

const fmtIST = iso => {
  try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }); } catch (_) { return String(iso); }
};

const pick = (counters, prefix) =>
  Object.entries(counters).filter(([k]) => k.startsWith(prefix)).sort((a, b) => b[1] - a[1]);

function dayLines(label, counters) {
  const g = k => counters[k] || 0;
  const lines = [
    label + ':',
    'Sawal: ' + g('requests') + ' | Jawab mila: ' + g('ok') + ' | Fail: ' + g('fail'),
    'Tayyar jawab (knowledge base): ' + g('kb_hit') + ' | Sirf calculator se: ' + g('engine_only') + ' | Badla hua jawab: ' + g('fallback')
  ];
  const provs = PROVIDERS
    .map(p => [p, g('provider.' + p + '.ok'), g('provider.' + p + '.fail')])
    .filter(([, ok, fail]) => ok || fail)
    .map(([p, ok, fail]) => p + ' ' + ok + ' theek / ' + fail + ' fail');
  if (provs.length) lines.push('Providers: ' + provs.join('; '));
  const rot = pick(counters, 'rotate.').filter(([k]) => k.split('.').length === 2).map(([k, n]) => k.replace('rotate.', '') + ' ' + n);
  if (rot.length) lines.push('Key badli: ' + rot.join(', '));
  const intents = pick(counters, 'intent.').filter(([k]) => k !== 'intent.general').slice(0, 5).map(([k, n]) => k.replace('intent.', '') + ' ' + n);
  if (intents.length) lines.push('Topics: ' + intents.join(', '));
  return lines;
}

// ctx = { stats, pools: { gemini: {total, available, cooling}, ... }, alertsConfigured }
async function run(command, ctx) {
  const cmd = normalize(command);
  if (!cmd) return { ok: false, reply: '' };
  const st = ctx.stats;
  const pools = ctx.pools || {};

  if (cmd === 'help') {
    return {
      ok: true, command: cmd,
      reply: [
        'Rupeyantra commands (subject mein: PIN <aapka_pin> <command>):',
        'status  - site aur setup ki halat',
        'keys    - har provider ki keys aur aaj kitni baar badli',
        'aaj     - aaj ki ginti',
        'errors  - aaj ki aur haal ki errors',
        'summary - aaj aur kal ka hisaab',
        'help    - ye list'
      ].join('\n')
    };
  }

  if (cmd === 'status' || cmd === 'keys') {
    const keyLines = PROVIDERS.map(p => {
      const s = pools[p] || { total: 0, available: 0, cooling: 0 };
      return p + ': ' + s.total + ' key' + (s.cooling ? ' (' + s.cooling + ' abhi limit par)' : '');
    });
    const day = st.isConfigured() ? await st.readDay(st.today()) : { counters: {}, available: false };
    if (cmd === 'keys') {
      const rot = pick(day.counters, 'rotate.').filter(([k]) => k.split('.').length === 3).map(([k, n]) => k.replace('rotate.', '') + ' ' + n);
      return {
        ok: true, command: cmd,
        reply: ['Keys:'].concat(keyLines, [
          day.available ? 'Aaj key badli: ' + (rot.length ? rot.join(', ') : 'koi nahi') : NO_STATS
        ]).join('\n')
      };
    }
    const g = k => day.counters[k] || 0;
    return {
      ok: true, command: cmd,
      reply: [
        'Rupeyantra status',
        'Site function: chal raha hai (ye jawab isi ka saboot hai)',
        'AI keys: ' + PROVIDERS.map(p => p + ' ' + ((pools[p] || {}).total || 0)).join(', '),
        'Gmail alert: ' + (ctx.alertsConfigured ? 'chalu' : 'band'),
        'Ginti (Upstash): ' + (st.isConfigured() ? 'chalu' : 'band'),
        day.available ? 'Aaj: ' + g('requests') + ' sawal, ' + g('fail') + ' fail' : 'Aaj ki ginti: abhi nahi'
      ].join('\n')
    };
  }

  if (!st.isConfigured()) return { ok: true, command: cmd, reply: NO_STATS };

  if (cmd === 'aaj') {
    const d = await st.readDay(st.today());
    const empty = !Object.keys(d.counters).length;
    return {
      ok: true, command: cmd,
      reply: empty
        ? 'Aaj (' + st.today() + ') abhi koi sawal darj nahi hua.'
        : dayLines('Aaj (' + st.today() + ', IST)', d.counters).join('\n')
    };
  }

  if (cmd === 'errors') {
    const d = await st.readDay(st.today());
    const byType = pick(d.counters, 'error.').map(([k, n]) => k.replace('error.', '') + ' ' + n);
    const recent = await st.readRecentErrors(10);
    const lines = ['Errors aaj: ' + (byType.length ? byType.join(', ') : 'koi nahi')];
    if (recent.length) {
      lines.push('Haal ki (naya pehle):');
      for (const e of recent) lines.push('- ' + fmtIST(e.t) + ' | ' + (e.type || '?') + (e.code ? ' ' + e.code : '') + (e.provider ? ' | ' + e.provider : ''));
    }
    return { ok: true, command: cmd, reply: lines.join('\n') };
  }

  // summary
  const [t, y] = await Promise.all([st.readDay(st.today()), st.readDay(st.yesterday())]);
  return {
    ok: true, command: cmd,
    reply: dayLines('Aaj (' + st.today() + ')', t.counters).concat([''], dayLines('Kal (' + st.yesterday() + ')', y.counters)).join('\n')
  };
}

module.exports = { run, normalize, COMMANDS, NO_STATS };
