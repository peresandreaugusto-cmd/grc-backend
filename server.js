import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import XLSX from 'xlsx';

const app = express();
app.use(express.json({ limit: '5mb' }));

// CORS simples (para permitir o HTML chamar o backend)
aplicativo.usar((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = path.join('/tmp', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname || '.xlsx') || '.xlsx';
      cb(null, `${crypto.randomBytes(12).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// Memória simples de arquivos (reinicia quando reinicia o servidor)
const FILES = new Map(); // fileId -> { filePath, kind, originalName, uploadedAt }

/**
 * POST /api/upload
 * multipart/form-data:
 *  - file: XLSX
 *  - kind: "plataforma" | "ias" | "plano"
 * Retorna: { fileId, kind, originalName }
 */
app.post('/api/upload', upload.single('file'), (req, res) => {
  const kind = String(req.body.kind || '').trim();
  if (!req.file) return res.status(400).send('Arquivo não enviado (field "file").');
  if (!kind) return res.status(400).send('Campo "kind" obrigatório.');

  const filePath = req.file.path;
  const fileId = path.basename(filePath).split('.')[0];

  FILES.set(fileId, {
    filePath,
    kind,
    originalName: req.file.originalname,
    uploadedAt: new Date().toISOString()
  });

  res.json({ fileId, kind, originalName: req.file.originalname });
});

function openWorkbook(filePath) {
  const buf = fs.readFileSync(filePath);
  return XLSX.read(buf, { type: 'buffer' });
}

function pickSheetName(wb, preferredName = null) {
  if (!wb?.SheetNames?.length) return null;
  if (preferredName && wb.SheetNames.includes(preferredName)) return preferredName;
  return wb.SheetNames[0];
}

/**
 * Filtra linhas por AdSet procurando o texto do adset em qualquer célula.
 * Retorna: { headers, rows } com limite.
 */
function filterSheetByAdSet(sheet, adset, maxRows = 80) {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!raw?.length) return { headers: [], rows: [] };

  // Heurística simples pra header (primeiras 15 linhas)
  let hdrRow = 0;
  for (let i = 0; i < Math.min(raw.length, 15); i++) {
    const joined = (raw[i] || []).map(x => String(x).toLowerCase()).join(' ');
    if (joined.includes('adset') || joined.includes('impress') || joined.includes('campaign')) {
      hdrRow = i;
      break;
    }
  }

  const headers = (raw[hdrRow] || []).map(h => String(h || '').trim()).slice(0, 80);
  const needle = String(adset || '').toLowerCase().trim();

  const rows = [];
  for (let i = hdrRow + 1; i < raw.length; i++) {
    const r = (raw[i] || []).slice(0, 80);
    const hay = r.map(x => String(x).toLowerCase()).join(' ');
    if (needle && hay.includes(needle)) {
      rows.push({ rowIndex: i + 1, values: r });
      if (rows.length >= maxRows) break;
    }
  }
  return { headers, rows };
}

async function callClaude({ section, question, context, datasets }) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
  if (!key) throw new Error('ANTHROPIC_API_KEY não configurada (veja .env.example).');

  const system =
`Você é um analista de delivery de mídia.
Responda de forma objetiva e baseada nos datasets.
Se faltar dado, diga qual coluna/aba está faltando.`;

  const user =
`SECTION: ${section}
ADSET: ${context?.adset || ''}
TOKENS: ${(context?.tokens || []).join(' | ')}

PERGUNTA:
${question}

DADOS (trechos filtrados por AdSet):
${JSON.stringify(datasets, null, 2)}
`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));

  const answer =
    data?.content?.map(c => c?.text).filter(Boolean).join('\n').trim()
    || JSON.stringify(data);

  return answer;
}

/**
 * POST /api/ia
 * JSON:
 * {
 *   section: "formato"|"compra"|"plano"|"ias"|"evid"|...,
 *   question: "...",
 *   context: { adset, tokens, partner, formato, statusOper, desvios? },
 *   files: { plataformaFileId?, iasFileId?, planoFileId? }
 * }
 */
app.post('/api/ia', async (req, res) => {
  try {
    const { section, question, context, files } = req.body || {};
    const adset = String(context?.adset || '').trim();

    if (!section || !question) return res.status(400).send('section e question são obrigatórios.');
    if (!adset) return res.status(400).send('context.adset é obrigatório.');

    const datasets = {};

    for (const [k, fileId] of Object.entries(files || {})) {
      const meta = FILES.get(String(fileId || ''));
      if (!meta?.filePath) continue;

      const wb = openWorkbook(meta.filePath);
      const sheetName = pickSheetName(wb, null);
      const sheet = wb.Sheets[sheetName];

      const filtered = filterSheetByAdSet(sheet, adset, 80);

      datasets[k] = {
        kind: meta.kind,
        originalName: meta.originalName,
        sheetName,
        matchCount: filtered.rows.length,
        headers: filtered.headers,
        rows: filtered.rows
      };
    }

    const answer = await callClaude({ section, question, context, datasets });
    res.json({ answer });
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

// Healthcheck
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`GRC backend rodando em http://localhost:${PORT}`));
