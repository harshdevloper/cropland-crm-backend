// AI service — Google Gemini adapter (PRD §9.4-9.5) for crop disease detection
// and smart advisory generation, with a deterministic mock fallback so the
// AI Crop Doctor & Smart Advisory screens work without an API key.

import { env } from '../../config/env.js';
import { getDownloadUrl } from '../../utils/aws.js';

const KEY = env.ai?.geminiApiKey || process.env.GEMINI_API_KEY || '';
const MODEL = env.ai?.geminiModel || 'gemini-2.5-flash';
export const aiConfigured = Boolean(KEY);

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

// Map an upstream AI HTTP status to a clean, farmer-friendly message (no vendor
// name leaked to the UI). 429 = daily/again-later quota; 4xx = key/config.
function aiError(status) {
  if (status === 429) return new Error('AI service is busy right now (daily limit reached). Please try again later.');
  if (status === 401 || status === 403) return new Error('AI service is not available right now. Please try again later.');
  if (status >= 500) return new Error('AI service is temporarily unavailable. Please try again in a moment.');
  return new Error('Could not complete AI diagnosis. Please try again.');
}

// Real-Gemini fallback chain: when the configured model's free-tier daily quota
// is exhausted (429), transparently try the next real Gemini model that still has
// quota. These are all genuine Gemini models — never a demo/mock result.
const MODEL_CHAIN = [...new Set([MODEL, 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.0-flash'])];

/**
 * POST to Gemini generateContent. Tries each model in MODEL_CHAIN: on a 429
 * (quota) it moves to the next model; on a transient 5xx it retries the same
 * model once. Only throws a clean error if every real model is quota-blocked.
 */
async function aiFetch(_model, body) {
  let lastStatus = 429;
  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await fetch(`${GEMINI}/${model}:generateContent?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status === 429) break;            // quota for this model → try next model
      if (attempt === 0 && res.status >= 500) { // transient → retry same model once
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw aiError(res.status);                 // 4xx config/key error → surface now
    }
  }
  throw aiError(lastStatus);                     // every real model is quota-blocked
}

// ── Mock knowledge base (seeded by crop+image so results are stable) ──────────
const DISEASE_DB = {
  tomato: [
    { disease: 'Early Blight', pathogen: 'Alternaria solani', symptoms: 'Concentric brown rings ("target spots") on lower leaves; yellowing and defoliation.' },
    { disease: 'Late Blight', pathogen: 'Phytophthora infestans', symptoms: 'Water-soaked greasy lesions with white fungal growth on leaf undersides; rapid collapse.' },
    { disease: 'Leaf Curl Virus', pathogen: 'Begomovirus (whitefly-borne)', symptoms: 'Upward curling, crinkling and yellowing of leaves; stunted growth.' },
  ],
  wheat: [
    { disease: 'Yellow Rust', pathogen: 'Puccinia striiformis', symptoms: 'Yellow-orange pustules in stripes along leaf veins; reduced grain fill.' },
    { disease: 'Powdery Mildew', pathogen: 'Blumeria graminis', symptoms: 'White powdery patches on leaves and stems; premature senescence.' },
  ],
  rice: [
    { disease: 'Rice Blast', pathogen: 'Magnaporthe oryzae', symptoms: 'Spindle-shaped lesions with grey centres on leaves; neck rot of panicles.' },
    { disease: 'Bacterial Leaf Blight', pathogen: 'Xanthomonas oryzae', symptoms: 'Water-soaked stripes turning yellow-white from leaf tips; wilting.' },
  ],
  paddy: [
    { disease: 'Rice Blast', pathogen: 'Magnaporthe oryzae', symptoms: 'Spindle-shaped lesions with grey centres on leaves; neck rot of panicles.' },
  ],
  cotton: [
    { disease: 'Bollworm Infestation', pathogen: 'Helicoverpa armigera', symptoms: 'Bored holes in bolls, frass at entry points; shed squares and flowers.' },
    { disease: 'Bacterial Leaf Spot', pathogen: 'Xanthomonas citri', symptoms: 'Angular water-soaked spots turning brown; blackarm on stems.' },
  ],
  chilli: [
    { disease: 'Anthracnose', pathogen: 'Colletotrichum spp.', symptoms: 'Sunken circular lesions with concentric rings on fruit; dieback of tips.' },
    { disease: 'Thrips Damage', pathogen: 'Scirtothrips dorsalis', symptoms: 'Upward leaf curling, silvering, and distorted growth.' },
  ],
  potato: [
    { disease: 'Late Blight', pathogen: 'Phytophthora infestans', symptoms: 'Dark water-soaked lesions on leaves; brown tuber rot.' },
  ],
  default: [
    { disease: 'Leaf Spot', pathogen: 'Cercospora spp.', symptoms: 'Small brown necrotic spots with chlorotic halos; coalescing under humidity.' },
    { disease: 'Aphid Infestation', pathogen: 'Aphis spp.', symptoms: 'Curled leaves, sticky honeydew and sooty mould; sap-sucking colonies on shoots.' },
  ],
};
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];

function seedFrom(s) {
  let h = 0;
  for (let i = 0; i < (s || 'x').length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function mockDiagnose(crop, imageUrl) {
  const key = String(crop || '').trim().toLowerCase();
  const list = DISEASE_DB[key] || DISEASE_DB.default;
  const seed = seedFrom(`${key}|${imageUrl || ''}`);
  const pick = list[seed % list.length];
  return {
    disease: pick.disease,
    pathogen: pick.pathogen,
    confidence: 72 + (seed % 26), // 72-97
    severity: SEVERITIES[seed % SEVERITIES.length],
    symptoms: pick.symptoms,
    recommendation: `Isolate affected plants and remove heavily infected debris. Apply a recommended ${pick.disease.toLowerCase().includes('worm') || pick.disease.toLowerCase().includes('thrips') || pick.disease.toLowerCase().includes('aphid') ? 'insecticide' : 'fungicide/bactericide'} on a 7-10 day schedule, ensuring good coverage. Maintain field sanitation and avoid overhead irrigation late in the day.`,
    source: 'mock',
  };
}

function mockAdvisory(crop, disease, type) {
  const curative = type !== 'PREVENTIVE';
  const title = `${curative ? 'Curative' : 'Preventive'} advisory — ${disease || 'crop health'} in ${crop}`;
  const body = curative
    ? `Your ${crop} shows signs of ${disease}. Act within 3-5 days:\n\n1. Remove and destroy severely affected plant parts to reduce inoculum.\n2. Spray the recommended product(s) below at the labelled dose with a spreader; repeat after 7-10 days if symptoms persist.\n3. Avoid overhead/late-evening irrigation; improve air circulation.\n4. Scout twice weekly and re-treat only affected patches.\n\nFollow all label safety and pre-harvest interval instructions.`
    : `Protect your ${crop} from ${disease || 'common diseases'} this season:\n\n1. Use certified, treated seed and resistant varieties where available.\n2. Maintain field sanitation and balanced nutrition (avoid excess nitrogen).\n3. Begin a preventive spray of the recommended product(s) at the susceptible stage.\n4. Monitor weather — tighten the schedule during prolonged humidity.\n\nFollow all label safety instructions.`;
  return { title, body, source: 'mock' };
}

// ── Gemini calls (used only when an API key is configured) ────────────────────
async function geminiJson(prompt, imageBase64, mime = 'image/jpeg') {
  const parts = [{ text: prompt }];
  if (imageBase64) parts.push({ inline_data: { mime_type: mime, data: imageBase64 } });
  // Route through aiFetch so advisories use the same real-Gemini model fallback
  // chain as diagnosis (survives a single model's daily quota cap).
  const res = await aiFetch(MODEL, { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  return JSON.parse(text);
}

// Resolve an https OR a data: URL to base64 inline-data for Gemini.
async function toInlineData(url) {
  if (!url) return null;
  const dataMatch = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(url);
  if (dataMatch) return { base64: dataMatch[2], mime: dataMatch[1] };
  // A bare S3 key (no scheme) — resolve to a signed download URL the backend can
  // fetch even when the bucket isn't public. (Fixes farmer-app photo diagnosis.)
  let fetchUrl = url;
  if (!/^https?:\/\//i.test(url)) {
    try { fetchUrl = await getDownloadUrl(url); } catch { /* fall back to raw */ }
  }
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString('base64'), mime: res.headers.get('content-type') || 'image/jpeg' };
}

const EMBED_MODEL = env.ai?.embeddingModel || 'gemini-embedding-001';
// Output dimension — must equal the Pinecone index dimension. gemini-embedding-001
// supports Matryoshka truncation (768/1536/3072); we use 768 to match the index.
const EMBED_DIM = env.ai?.embeddingDim || 768;

/** Embed text into a vector with Gemini's embedding model. Returns number[] or null. */
export async function embedText(text) {
  if (!aiConfigured || !text) return null;
  try {
    const res = await fetch(`${GEMINI}/${EMBED_MODEL}:embedContent?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text }] }, outputDimensionality: EMBED_DIM }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const data = await res.json();
    return data?.embedding?.values ?? null;
  } catch { return null; }
}

/** Ask Gemini Vision for a compact visual description of a crop photo. */
export async function captionImage(imageUrl, crop = 'crop') {
  if (!aiConfigured || !imageUrl) return null;
  try {
    const img = await toInlineData(imageUrl);
    const prompt = `Describe this ${crop} plant photo for disease retrieval in ONE sentence: leaf colour, lesion/spot pattern, pest signs, affected part. No preamble.`;
    const res = await fetch(`${GEMINI}/${MODEL}:generateContent?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: img.mime, data: img.base64 } }] }], generationConfig: { temperature: 0.2 } }),
    });
    if (!res.ok) throw new Error(`caption ${res.status}`);
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim() || null;
  } catch { return null; }
}

/**
 * Build a retrieval embedding for a training photo: caption it, then embed
 * "label · caption". Returns { caption, vector } or null when AI is unconfigured.
 */
export async function embedSample(imageUrl, label, crop) {
  if (!aiConfigured) return null;
  const caption = await captionImage(imageUrl, crop);
  const vector = await embedText([label, caption].filter(Boolean).join('. '));
  return vector ? { caption, vector } : null;
}

/** Cosine similarity between two equal-length vectors (0..1 for normalised). */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Detect crop disease/pest from a photo or crop name alone.
 * `references` (from Train AI Doctor) are labelled example images injected as
 * multimodal few-shot context to ground the model on the company's own field data.
 * When no image is provided, a text-only Gemini prompt is used so real AI
 * results are returned even without a photo.
 */
export async function diagnoseCrop({ crop, imageUrl, references = [], lang }) {
  if (!aiConfigured) return mockDiagnose(crop, imageUrl);
  try {
    const langLine = lang === 'hi' ? ' Write the "symptoms" and "recommendation" values in Hindi (Devanagari script); keep the JSON keys and disease/pathogen names in English.' : '';
    const outputInstruction = `Respond as strict JSON with keys: disease (string), pathogen (string), confidence (number 0-100), severity ("LOW"|"MEDIUM"|"HIGH"), symptoms (string), recommendation (string, 2-3 sentences of agronomic control advice).${langLine}`;

    if (!imageUrl) {
      // Text-only diagnosis: ask Gemini for the most likely disease given the crop name.
      const refContext = references.length
        ? ` Known conditions in our system for this crop: ${references.slice(0, 4).map((r) => r.disease).filter(Boolean).join(', ')}.`
        : '';
      const prompt = `You are an expert agronomy plant-pathologist. A farmer reports a problem with their ${crop} crop but has not provided a photo.${refContext} Based on common diseases affecting ${crop} in Indian agro-climatic conditions, diagnose the most likely disease or pest. ${outputInstruction}`;
      const res = await aiFetch(MODEL, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.5 } });
      const data = await res.json();
      const j = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}');
      return {
        disease: j.disease ?? 'Unknown', pathogen: j.pathogen ?? null,
        confidence: Number(j.confidence) || 0, severity: SEVERITIES.includes(j.severity) ? j.severity : 'MEDIUM',
        symptoms: j.symptoms ?? null, recommendation: j.recommendation ?? null,
        source: 'gemini-text',
      };
    }

    // Vision diagnosis: use the uploaded photo with optional few-shot reference images.
    const queryImg = await toInlineData(imageUrl);
    const parts = [];
    let usedRefs = 0;
    if (references.length) {
      parts.push({ text: `You are an expert agronomy plant-pathologist. Below are labelled REFERENCE photos of known ${crop} crop conditions. Use them to ground your judgement.` });
      for (const ref of references.slice(0, 6)) {
        try {
          const img = await toInlineData(ref.imageUrl);
          parts.push({ text: `Reference — ${ref.disease}${ref.pathogen ? ` (${ref.pathogen})` : ''}${ref.caption ? `: ${ref.caption}` : ''}` });
          parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
          usedRefs += 1;
        } catch { /* skip unreadable reference */ }
      }
    }
    parts.push({ text: `Now diagnose THIS image of a ${crop} crop. Prefer a matching reference condition when applicable. ${outputInstruction}` });
    parts.push({ inline_data: { mime_type: queryImg.mime, data: queryImg.base64 } });

    const res = await aiFetch(MODEL, { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } });
    const data = await res.json();
    const j = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}');
    return {
      disease: j.disease ?? 'Unknown', pathogen: j.pathogen ?? null,
      confidence: Number(j.confidence) || 0, severity: SEVERITIES.includes(j.severity) ? j.severity : 'MEDIUM',
      symptoms: j.symptoms ?? null, recommendation: j.recommendation ?? null,
      source: usedRefs ? `gemini+${usedRefs}ref` : 'gemini',
    };
  } catch (err) {
    throw new Error(err?.message ?? 'AI diagnosis failed — please try again.');
  }
}

/** Generate a preventive/curative advisory for a crop+disease — real Gemini only. */
export async function generateAdvisory({ crop, disease, type }) {
  if (!aiConfigured) throw new Error('AI service is not configured. Please try again later.');
  const prompt = `Write a concise ${type === 'PREVENTIVE' ? 'preventive' : 'curative'} agronomic advisory for ${disease || 'crop health'} affecting ${crop}, for a smallholder Indian farmer. Respond as strict JSON: { "title": string, "body": string (numbered, actionable, mention spray schedule and safety) }.`;
  const j = await geminiJson(prompt, null);
  return { title: j.title ?? `Advisory for ${crop}`, body: j.body ?? '', source: 'gemini' };
}

export function aiChannelStatus() {
  return { provider: 'gemini', model: MODEL, embeddingModel: EMBED_MODEL, configured: aiConfigured };
}
