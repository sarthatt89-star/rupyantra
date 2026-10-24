'use strict';

/*
 * Sawal report (lib/question-report.js)
 *
 * Roz ke topic-wise hisaab: kaun sa topic kitna poochha gaya (asked) aur kahan jawab nahi mila / fallback hua (missed).
 * Data stats ki ginti se aata hai: sirf topic ka naam (intent) aur count. User ka text kabhi nahi.
 * Read-only.
 */

const defaultStats = require('./stats');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function createQuestionReport(deps = {}) {
  const store = deps.stats || defaultStats;

  async function build(day) {
    const d = day && DAY_RE.test(day) ? day : store.today();
    const r = store.isConfigured && store.isConfigured()
      ? await store.readDay(d)
      : { counters: {}, available: false };
    const c = r.counters || {};

    const topics = {};
    for (const [key, value] of Object.entries(c)) {
      const m = key.match(/^(intent|miss)\.([a-z_]{2,30})$/);
      if (!m) continue;
      const t = m[2];
      topics[t] = topics[t] || { topic: t, asked: 0, missed: 0 };
      if (m[1] === 'intent') topics[t].asked += Number(value) || 0;
      else topics[t].missed += Number(value) || 0;
    }
    const list = Object.values(topics)
      .sort((a, b) => b.asked - a.asked || b.missed - a.missed)
      .slice(0, 15);

    return {
      day: d,
      available: Boolean(r.available),
      totals: {
        asked: Number(c.requests) || 0,
        answered: Number(c.ok) || 0,
        failed: Number(c.fail) || 0,
        fallback: Number(c.fallback) || 0,
        glossary: Number(c.glossary_hit) || 0,
        knowledge: Number(c.kb_hit) || 0,
      },
      topics: list,
    };
  }

  return { build };
}

module.exports = { createQuestionReport };
