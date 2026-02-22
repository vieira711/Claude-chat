require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const API_KEY       = process.env.ANTHROPIC_API_KEY;
const PORT          = process.env.PORT ? Number(process.env.PORT) : 3000;
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || "";

// ✅ Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const MODEL_SONNET = "claude-sonnet-4-5-20251001";
const MODEL_HAIKU  = "claude-haiku-4-5-20251001";

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

// ---- Settings (system prompt) ----
async function getSetting(key) {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", key)
    .single();
  return data?.value || "";
}

async function setSetting(key, value) {
  await supabase
    .from("settings")
    .upsert({ key, value }, { onConflict: "key" });
}

app.get("/api/settings", async (req, res) => {
  const systemPrompt = await getSetting("system_prompt");
  res.json({ systemPrompt });
});

app.post("/api/settings", async (req, res) => {
  const { systemPrompt } = req.body || {};
  await setSetting("system_prompt", systemPrompt || "");
  res.json({ ok: true });
});

// ---- Conversas ----
app.get("/api/conversations", async (req, res) => {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    conversations: (data || []).map((c) => ({
      id:        c.id,
      title:     c.title || "Nova conversa",
      updatedAt: c.updated_at || 0,
    })),
  });
});

app.post("/api/conversations", async (req, res) => {
  const id  = uid();
  const now = Date.now();
  const { error } = await supabase.from("conversations").insert({
    id,
    title:              "Nova conversa",
    summary:            "",
    summary_updated_at: 0,
    created_at:         now,
    updated_at:         now,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id });
});

app.get("/api/conversations/:id", async (req, res) => {
  const { id } = req.params;

  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", id)
    .single();

  if (convErr || !conv) return res.status(404).json({ error: "Conversa não encontrada" });

  const { data: msgs } = await supabase
    .from("messages")
    .select("role, content, ts")
    .eq("conversation_id", id)
    .order("ts", { ascending: true });

  res.json({ id, ...conv, messages: msgs || [] });
});

app.delete("/api/conversations/:id", async (req, res) => {
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---- Resumo automático ----
async function maybeSummarizeConversation(conversationId) {
  if (!API_KEY) return;

  const { data: conv } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .single();
  if (!conv) return;

  const { data: msgs } = await supabase
    .from("messages")
    .select("role, content, ts")
    .eq("conversation_id", conversationId)
    .order("ts", { ascending: true });

  if (!msgs || msgs.length < 22) return;

  const lastSum = conv.summary_updated_at || 0;
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
    "CONVERSA:\n" + transcript;

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
  if (!r.ok) { console.log("ERRO AO RESUMIR:", data); return; }

  const summary = pickTextFromAnthropic(data).trim();
  if (!summary) return;

  // Deleta mensagens antigas, mantém só as últimas
  const oldTs = msgs.slice(0, msgs.length - keepLast).map(m => m.ts);
  if (oldTs.length) {
    await supabase
      .from("messages")
      .delete()
      .eq("conversation_id", conversationId)
      .in("ts", oldTs);
  }

  await supabase
    .from("conversations")
    .update({ summary, summary_updated_at: Date.now(), updated_at: Date.now() })
    .eq("id", conversationId);
}

// ---- Chat streaming ----
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
      return res.status(400).json({ error: "Mensagem vazia." });

    const { data: conv } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", conversationId)
      .single();
    if (!conv) return res.status(404).json({ error: "Conversa não encontrada." });

    const now = Date.now();

    // Salva mensagem do usuário
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role:            "user",
      content:         userText || "[Anexo enviado]",
      ts:              now,
    });

    // Atualiza título se for nova conversa
    const newTitle = (!conv.title || conv.title === "Nova conversa")
      ? (userText || "Nova conversa").slice(0, 48)
      : conv.title;

    await supabase
      .from("conversations")
      .update({ title: newTitle, updated_at: now })
      .eq("id", conversationId);

    await maybeSummarizeConversation(conversationId);

    // Recarrega conversa e mensagens
    const { data: conv2 } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", conversationId)
      .single();

    const { data: msgs } = await supabase
      .from("messages")
      .select("role, content, ts")
      .eq("conversation_id", conversationId)
      .order("ts", { ascending: true });

    // System prompt: resumo + prompt personalizado
    const userSystemPrompt = await getSetting("system_prompt");
    let system = "";
    if (conv2?.summary) system += `Contexto resumido desta conversa:\n${conv2.summary}\n\n`;
    if (userSystemPrompt) system += userSystemPrompt;

    // Histórico
    const MAX_TURNS = 20;
    const history = (msgs || []).slice(-MAX_TURNS).map((m) => ({
      role:    m.role,
      content: m.content,
    }));

    // Blocos multimodal
    const blocks = [];
    if (userText) blocks.push({ type: "text", text: userText });

    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        if (!a?.kind) continue;
        if (a.kind === "image" && a.data && a.media_type) {
          blocks.push({ type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } });
        } else if (a.kind === "pdf" && a.data) {
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } });
        } else if (a.kind === "text" && a.text) {
          blocks.push({ type: "text", text: `\n\n---\nARQUIVO: ${a.name || "arquivo"}\n${a.text}\n---\n` });
        }
      }
    }

    history.push({ role: "user", content: blocks.length ? blocks : userText });

    // SSE
    res.setHeader("Content-Type",  "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection",    "keep-alive");

    const chosenModel = (model || MODEL_SONNET).trim();
    const controller  = new AbortController();
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
        max_tokens: 8096,
        stream:     true,
        system:     system.trim() || undefined,
        messages:   history,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Erro Anthropic", details: errText })}\n\n`);
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
        if (!trimmed || !trimmed.startsWith("data:")) continue;

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

    // Salva resposta do assistant
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role:            "assistant",
      content:         assistantText,
      ts:              Date.now(),
    });

    await supabase
      .from("conversations")
      .update({ updated_at: Date.now() })
      .eq("id", conversationId);

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
