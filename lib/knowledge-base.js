'use strict';

/*
 * Rupeyantra Knowledge Base (lib/knowledge-base.js)
 *
 * Aam "X kya hai?" / "X kaise nikalte hain?" sawalon ka tayyar Hinglish jawab.
 * Fayde: AI/API ka quota nahi lagta, jawab turant aata hai, aur API key na ho tab bhi chalta hai.
 *
 * Niyam (tests/knowledge-base.test.js mein lock):
 *  - Jawab mein koi number/digit nahi hota (koi example amount, rate ya return nahi); numbers ke liye user ko
 *    apne inputs dene ko kaha jaata hai, jise calculator tool sambhalta hai.
 *  - Sirf tab chalta hai jab sawal chhota aur seedha definition/formula jaisa ho; "risk", "fayde", "farak",
 *    "kitna", "tax" jaise sawal AI ko jaate hain.
 *  - Sirf Hinglish (Roman) sawalon par; English/Hindi sawal AI ko jaate hain taaki usi bhasha mein jawab mile.
 */

const TOPICS = {
  emi: {
    label: 'EMI',
    ask: 'Mere numbers se EMI nikalo',
    text:
      'EMI (Equated Monthly Installment) wo fixed rakam hai jo aap loan chukane ke liye har mahine bank ko dete ho. ' +
      'Isme loan ka mool (principal) aur uska byaj dono shamil hote hain.\n\n' +
      'Reducing balance method mein shuruat ki EMI mein byaj ka hissa zyada hota hai aur dheere dheere principal ka hissa badhta jaata hai. ' +
      'EMI teen cheezon par depend karti hai: loan amount, byaj dar aur loan ki avadhi. ' +
      'Avadhi badhane se EMI kam hoti hai, par total byaj zyada dena padta hai.\n\n' +
      'Apne numbers (loan amount, interest rate aur kitne saal) batao to main aapki EMI nikaal dunga.'
  },
  sip: {
    label: 'SIP',
    ask: 'Mere numbers se SIP nikalo',
    text:
      'SIP (Systematic Investment Plan) mein aap mutual fund mein har mahine ek tay rakam lagate ho, ek saath badi rakam lagane ki jagah. ' +
      'Isse aap bazaar ke upar-neeche hone par alag-alag bhav par units kharidte ho aur investment ki aadat bhi banti hai.\n\n' +
      'Time ke saath compounding se paisa badh sakta hai, par mutual fund ke returns market par depend karte hain. ' +
      'Koi return guaranteed nahi hota aur nuksaan bhi ho sakta hai. SIP ka future value sirf ek andaza hota hai, pakka nahi.\n\n' +
      'Mahine ki rakam, expected return aur avadhi batao to main estimate nikaal dunga.'
  },
  fd_lumpsum: {
    label: 'FD',
    ask: 'Mere numbers se FD maturity nikalo',
    text:
      'FD (Fixed Deposit) mein aap ek tay avadhi ke liye bank ko ek saath paisa dete ho aur bank us par tay byaj deta hai. ' +
      'Lumpsum investment ka matlab bhi ek saath ek badi rakam lagana hai.\n\n' +
      'Byaj kitni baar judta hai (compounding, jaise tirmahi ya masik) usse maturity amount par farak padta hai. ' +
      'Avadhi se pehle FD todne par aam taur par penalty lag sakti hai, aur FD ke byaj par tax lag sakta hai.\n\n' +
      'Rakam, byaj dar aur avadhi batao to main maturity amount nikaal dunga.'
  },
  cagr: {
    label: 'CAGR',
    ask: 'Mere numbers se CAGR nikalo',
    text:
      'CAGR (Compound Annual Growth Rate) batata hai ki kisi investment ne shuru ki value se ant ki value tak, ' +
      'har saal barabar dar se badhte hue, salana kitni growth di.\n\n' +
      'Formula: (ant ki value ÷ shuru ki value) ka avadhi (saal) ke hisaab se root, usme se ek ghatao, phir percent mein badlo. ' +
      'Isse alag-alag investments ki tulna aasaan hoti hai, par ye beech ke utaar-chadhav nahi dikhata.\n\n' +
      'Shuru ki value, ant ki value aur kitne saal, ye teen batao to main CAGR nikaal dunga.'
  },
  simple_interest: {
    label: 'simple interest',
    ask: 'Mere numbers se simple interest nikalo',
    text:
      'Simple interest mein byaj sirf mool rakam (principal) par lagta hai, byaj par byaj nahi judta. ' +
      'Isliye har saal ka byaj barabar rehta hai.\n\n' +
      'Formula: principal × byaj dar × saal ÷ sau. ' +
      'Compound interest mein byaj par bhi byaj judta hai, isliye wo time ke saath zyada badhta hai.\n\n' +
      'Principal, byaj dar aur saal batao to main simple interest nikaal dunga.'
  },
  gst: {
    label: 'GST',
    ask: 'Mere numbers se GST nikalo',
    text:
      'GST (Goods and Services Tax) bharat mein saaman aur sevaon par lagne wala tax hai. Final bill = base price + GST.\n\n' +
      'Agar GST extra hai to GST = base price × GST dar. Agar price mein GST pehle se included hai to ' +
      'base price nikalne ke liye total ko "ek plus GST dar" (decimal mein) se bhaag dete hain.\n\n' +
      'GST ki dar saaman ya seva ke type par depend karti hai aur badal sakti hai, isliye sahi dar ke liye gst.gov.in dekho. ' +
      'Amount, GST dar aur included/extra batao to main nikaal dunga.'
  },
  inflation: {
    label: 'inflation',
    ask: 'Mere numbers se inflation ka asar nikalo',
    text:
      'Inflation (mehngai) ka matlab hai ki time ke saath cheezon ke daam badhte hain, isliye aaj ke paise ki kharid-shakti kal kam ho jaati hai.\n\n' +
      'Agar inflation ek dar se chalti rahe to future cost = aaj ka kharcha × (ek plus inflation dar) ka avadhi ke hisaab se power. ' +
      'Isliye lambe goals (jaise padhai ya retirement) ke liye inflation ka dhyan rakhna zaroori hai. ' +
      'Future inflation guaranteed nahi hoti, ye sirf andaza hai.\n\n' +
      'Aaj ki amount, maani hui inflation aur saal batao to main future cost nikaal dunga.'
  },
  budget: {
    label: 'budget',
    ask: 'Mera budget banao',
    text:
      'Budget aapki income aur kharche ka plan hai, taaki pata rahe ki paisa kahan ja raha hai aur kitna bach raha hai.\n\n' +
      'Ek aam rule ye hai ki income ka aadha hissa zaruraton (needs) par, tees percent wants par aur bees percent bachat par rakho. ' +
      'Surplus = income minus kharcha. Pehle bachat alag nikalo, phir bacha hua kharch karo.\n\n' +
      'Mahine ki income aur kharcha batao to main surplus aur savings rate nikaal dunga.'
  }
};
TOPICS.savings = TOPICS.budget;

const MAX_WORDS = 8;
const ALLOW = /\b(kya\s+(?:hai|hota|hoti|hote|matlab)|what\s+is|meaning|matlab|samjhao|samjha\w*|explain|kaise\s+(?:nikalte|nikalta|nikalen|nikalein|kaam|banate|banta|banti)|formula)\b/;
const DENY = /\b(risk|fayde|faayde|benefit\w*|nuksan|loss|farak|fark|difference|vs|better|best|kab|kyun|kyu|why|tax|rate|dar|kitna|kitni|kitne|chahiye|should|zyada|kam|safe|guarantee\w*|aur)\b/;

const normalize = t => String(t || '').toLowerCase().replace(/[?!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();

function isDefinitionQuestion(text) {
  const t = normalize(text);
  if (!t || t.split(' ').length > MAX_WORDS) return false;
  return ALLOW.test(t) && !DENY.test(t);
}

// route = intent-router ka output. Mile to { reply, options, topic }, warna null (AI jawab dega).
function lookup(route, text) {
  try {
    if (!route || route.mode !== 'concept' || route.action !== 'answer_concept') return null;
    if (!route.language || route.language.code !== 'hinglish') return null;
    if (route.safety && route.safety.injection && route.safety.injection.flagged) return null;
    const topic = TOPICS[route.intent];
    if (!topic || !isDefinitionQuestion(text)) return null;
    return { reply: topic.text, options: [topic.ask], topic: route.intent };
  } catch (_) {
    return null;
  }
}

module.exports = { lookup, isDefinitionQuestion, TOPICS };
