require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

// Base64 aumenta tamanho: limite maior
app.use(express.json({ limit: "25mb" }));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Proteção por senha (configure CHAT_PASSWORD no Render)
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || "";

// ✅ CORRIGIDO: model IDs corretos
const MODEL_SONNET = "claude-sonnet-4-5-20251001";
const MODEL_HAIKU  = "claude-haiku-4-5-20251001";

// Persistência em JSON
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH  = path.join(DATA_DIR, "conversations.json");

// Cache em memória para evitar leituras desnecessárias do disco
let dbCache = null;

function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const empty = { conversations: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    dbCache = empty;
  }
}

function loadDB() {
  ensureDB();
  if (dbCache) return dbCache;
  dbCache = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  return dbCache;
}

// ✅ CORRIGIDO: escrita atômica (evita corromper o arquivo se o servidor cair no meio)
function saveDB(db) {
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
  dbCache = db;
}

function uid() {
  return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function pickTextFromAnthropic(data) {
  return (
    data?.content?.find?.((c) => c.type === "text")?.text ||
    data?.content?.[0]?.text ||
    ""
  );
}

// Middleware de autenticação
app.use((req, res, next) => {
  if (!CHAT_PASSWORD) return next();
  if (!req.path.startsWith("/api/")) return next();
  const token = req.headers["x-auth"];
  if (token === CHAT_PASSWORD) return next();
  return res.status(401).json({ error: "Não autorizado" });
});

// Resumo automático para economizar tokens (usa Haiku)
async function maybeSummarizeConversation(conversationId) {
  if (!API_KEY) return;

  const db   = loadDB();
  const conv = db.conversations[conversationId];
  if (!conv) return;

  const msgs = conv.messages || [];
  if (msgs.length < 22) return;

  const lastSum = conv.summaryUpdatedAt || 0;
  if (Date.now() - lastSum < 60_000) return;

  const keepLast = 12;
  const old = msgs.slice(0, Math.max(0, msgs.length - keepLast));
  if (old.length < 12) return;

  const transcript = old.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

  const prompt =
    "Resuma a conversa abaixo em português, de forma objetiva.\n" +
    "- Preserve fatos, decisões, preferências, nomes e números.\n" +
    "- Use bullets curtos.\n" +
    "- Se houver tarefas pendentes, liste em 'Pendências'.\n\n" +
    "CONVERSA:\n" +
    transcript;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type":      "application/json",
      "x-api-key":         API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      MODEL_HAIKU,
      max_tokens: 600,
      messages:   [{ role: "user", content: prompt }],
    }),
  });

  const data = await r.json();
  if (!r.ok) {
    console.log("ERRO AO RESUMIR:", data);
    return;
  }

  const summary = pickTextFromAnthropic(data).trim();
  if (!summary) return;

  conv.summary           = summary;
  conv.summaryUpdatedAt  = Date.now();
  conv.messages          = msgs.slice(-keepLast);
  conv.updatedAt         = Date.now();
  saveDB(db);
}

// ---- APIs de conversas ----

app.get("/api/conversations", (req, res) => {
  const db   = loadDB();
  const list = Object.entries(db.conversations).map(([id, c]) => ({
    id,
    title:     c.title || "Nova conversa",
    updatedAt: c.updatedAt || 0,
  }));
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ conversations: list });
});

app.post("/api/conversations", (req, res) => {
  const db = loadDB();
  const id = uid();
  db.conversations[id] = {
    title:            "Nova conversa",
    summary:          "",
    summaryUpdatedAt: 0,
    messages:         [],
    createdAt:        Date.now(),
    updatedAt:        Date.now(),
  };
  saveDB(db);
  res.json({ id });
});

app.get("/api/conversations/:id", (req, res) => {
  const db = loadDB();
  const c  = db.conversations[req.params.id];
  if (!c) return res.status(404).json({ error: "Conversa não encontrada" });
  res.json({ id: req.params.id, ...c });
});

app.delete("/api/conversations/:id", (req, res) => {
  const db = loadDB();
  if (!db.conversations[req.params.id])
    return res.status(404).json({ error: "Conversa não encontrada" });
  delete db.conversations[req.params.id];
  saveDB(db);
  res.json({ ok: true });
});

// ---- Chat streaming (SSE) ----

app.post("/api/chat/stream", async (req, res) => {
  try {
    if (!API_KEY)
      return res.status(500).json({ error: "ANTHROPIC_API_KEY não definida." });

    const { conversationId, message, model, attachments } = req.body || {};
    const userText = (message || "").trim();

    if (!conversationId)
      return res.status(400).json({ error: "conversationId obrigatório." });

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!userText && !hasAttachments)
      return res.status(400).json({ error: "Mensagem vazia (sem texto/anexo)." });

    const db   = loadDB();
    const conv = db.conversations[conversationId];
    if (!conv)
      return res.status(404).json({ error: "Conversa não encontrada." });

    conv.messages.push({
      role:    "user",
      content: userText || "[Anexo enviado]",
      ts:      Date.now(),
    });
    conv.updatedAt = Date.now();
    if (!conv.title || conv.title === "Nova conversa")
      conv.title = (userText || "Nova conversa").slice(0, 48);
    saveDB(db);

    await maybeSummarizeConversation(conversationId);

    const db2   = loadDB();
    const conv2 = db2.conversations[conversationId];

    const system = conv2.summary
      ? `Contexto resumido desta conversa (use como memória):\n${conv2.summary}`
      : "";

    // ✅ CORRIGIDO: histórico maior (últimas 20 mensagens)
    const MAX_TURNS = 20;
    const history   = (conv2.messages || []).slice(-MAX_TURNS).map((m) => ({
      role:    m.role,
      content: m.content,
    }));

    // Monta blocos multimodal para a última mensagem
    const blocks = [];
    if (userText) blocks.push({ type: "text", text: userText });

    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        if (!a || !a.kind) continue;

        if (a.kind === "image") {
          if (!a.data || !a.media_type) continue;
          blocks.push({
            type:   "image",
            source: { type: "base64", media_type: a.media_type, data: a.data },
          });
        } else if (a.kind === "pdf") {
          if (!a.data) continue;
          blocks.push({
            type:   "document",
            source: { type: "base64", media_type: "application/pdf", data: a.data },
          });
        } else if (a.kind === "text") {
          if (!a.text) continue;
          const name = a.name || "arquivo";
          blocks.push({
            type: "text",
            text: `\n\n---\nARQUIVO: ${name}\nConteúdo:\n${a.text}\n---\n`,
          });
        }
      }
    }

    history.push({
      role:    "user",
      content: blocks.length ? blocks : userText,
    });

    // Prepara SSE
    res.setHeader("Content-Type",  "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection",    "keep-alive");

    const chosenModel = (model || MODEL_SONNET).trim();

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type":      "application/json",
        "x-api-key":         API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      chosenModel,
        max_tokens: 8096, // ✅ CORRIGIDO: era 900, agora respostas longas funcionam
        stream:     true,
        system:     system || undefined,
        messages:   history,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: "Erro Anthropic", details: errText })}\n\n`
      );
      return res.end();
    }

    let assistantText = "";

    const reader  = r.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer    = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("data:")) {
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === "[DONE]") continue;

          let evt;
          try { evt = JSON.parse(jsonStr); } catch { continue; }

          const deltaText = evt?.delta?.text;
          if (typeof deltaText === "string" && deltaText.length) {
            assistantText += deltaText;
            res.write(`event: token\ndata: ${JSON.stringify({ t: deltaText })}\n\n`);
          }

          if (evt?.type === "message_stop") {
            res.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`);
          }
        }
      }
    }

    // Salva resposta do assistant
    const db3   = loadDB();
    const conv3 = db3.conversations[conversationId];
    if (conv3) {
      conv3.messages.push({ role: "assistant", content: assistantText, ts: Date.now() });
      conv3.updatedAt = Date.now();
      saveDB(db3);
    }

    res.end();
  } catch (err) {
    if (String(err).includes("AbortError")) return;
    console.log("ERRO SERVIDOR:", err);
    res.status(500).json({ error: "Erro no servidor", details: String(err) });
  }
});

// Servir front estático
app.use("/", express.static(__dirname));

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
