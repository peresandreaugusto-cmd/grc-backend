# GRC Backend (local) — Upload XLSX + IA Claude

## Requisitos
- Node.js 18+

## Instalação
1) Copie `.env.example` para `.env` e preencha `ANTHROPIC_API_KEY`.
2) Instale dependências:
   npm install
3) Rode:
   npm start

## Rotas
- POST /api/upload (multipart/form-data)
  - file (XLSX)
  - kind = plataforma | ias | plano
  - retorna { fileId }

- POST /api/ia (JSON)
  - section, question, context, files
  - retorna { answer }

## Observação
A key fica só no backend (seguro). Seu HTML chama IA_ENDPOINT = '/api/ia'.
