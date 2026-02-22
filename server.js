require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 💰 TABELA DE PREÇOS DA ANTHROPIC
const MODEL_PRICING = {
  'claude-sonnet-4': {
    input: 3.00 / 1_000_000,
    output: 15.00 / 1_000_000,
    name: 'Claude Sonnet 4'
  },
  'claude-3-5-haiku-20241022': {
    input: 1.00 / 1_000_000,
    output: 5.00 / 1_000_000,
    name: 'Claude Haiku 3.5'
  }
};

function calculateCost(inputTokens, outputTokens, modelId) {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return { cost: 0, inputCost: 0, outputCost: 0 };

  const inputCost = inputTokens * pricing.input;
  const outputCost = outputTokens * pricing.output;
  const totalCost = inputCost + outputCost;

  return {
    cost: totalCost,
    inputCost,
    outputCost,
    inputTokens,
    outputTokens,
    modelName: pricing.name
  };
}

function normalizeModel(modelName) {
  const m = modelName || 'claude-sonnet-4';
  if (m.includes('sonnet')) return 'claude-sonnet-4';
  if (m.includes('haiku')) return 'claude-3-5-haiku-20241022';
  return 'claude-sonnet-4';
}

function authenticate(req, res, next) {
  const password = req.headers['x-password'];
  if (password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 💰 NOVA ROTA: Estatísticas
app.get('/stats', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('cost_data, created_at');

    if (error) throw error;

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let messageCount = 0;
    const dailyStats = {};

    data.forEach(conv => {
      if (conv.cost_data && Array.isArray(conv.cost_data)) {
        conv.cost_data.forEach(cost => {
          totalCost += cost.cost || 0;
          totalInputTokens += cost.inputTokens || 0;
          totalOutputTokens += cost.outputTokens || 0;
          messageCount++;

          const date = new Date(conv.created_at).toISOString().split('T')[0];
          if (!dailyStats[date]) {
            dailyStats[date] = { cost: 0, messages: 0 };
          }
          dailyStats[date].cost += cost.cost || 0;
          dailyStats[date].messages++;
        });
      }
    });

    res.json({
      totalCost: totalCost.toFixed(4),
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      messageCount,
      dailyStats,
      conversationCount: data.length
    });

  } catch (error) {
    console.error('❌ Erro ao obter estatísticas:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/conversations', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .insert([{ 
        title: 'Nova Conversa', 
        messages: [],
        cost_data: []
      }])
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Erro ao criar conversa:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/conversations', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Erro ao listar conversas:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/conversations/:id', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Erro ao obter conversa:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/conversations/:id', authenticate, async (req, res) => {
  try {
    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao deletar conversa:', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/conversations/:id', authenticate, async (req, res) => {
  try {
    const { title } = req.body;
    const { data, error } = await supabase
      .from('conversations')
      .update({ title })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Erro ao renomear conversa:', error);
    res.status(500).json({ error: error.message });
  }
});

async function summarizeOldMessages(messages, systemPrompt) {
  if (messages.length <= 10) return messages;

  const oldMessages = messages.slice(0, -8);
  const recentMessages = messages.slice(-8);

  const conversationText = oldMessages
    .map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`)
    .join('\n\n');

  try {
    const summaryMessage = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 500,
      system: 'Você é um assistente que resume conversas de forma concisa.',
      messages: [{
        role: 'user',
        content: `Resuma esta conversa:\n\n${conversationText}`
      }]
    });

    const summary = summaryMessage.content[0].text;

    return [
      { role: 'user', content: '[RESUMO DA CONVERSA ANTERIOR]' },
      { role: 'assistant', content: summary },
      ...recentMessages
    ];
  } catch (error) {
    console.error('❌ Erro ao resumir:', error);
    return messages;
  }
}

function processAttachments(attachments) {
  if (!attachments || attachments.length === 0) return null;

  return attachments.map(att => {
    if (att.type === 'image') {
      const base64Data = att.data.split(',')[1];
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mimeType || 'image/jpeg',
          data: base64Data,
        },
      };
    } else if (att.type === 'document') {
      const base64Data = att.data.split(',')[1];
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: att.mimeType || 'application/pdf',
          data: base64Data,
        },
      };
    } else if (att.type === 'text') {
      return { type: 'text', text: att.data };
    }
    return null;
  }).filter(Boolean);
}

app.post('/chat', authenticate, async (req, res) => {
  try {
    const { message, model, conversationId, attachments, systemPrompt } = req.body;
    const chosenModel = normalizeModel(model);

    if (!message) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }

    let conversation;
    if (conversationId) {
      const { data } = await supabase
        .from('conversations')
        .select('*')
        .eq('id', conversationId)
        .single();
      conversation = data;
    }

    let messages = conversation?.messages || [];

    if (messages.length > 10) {
      messages = await summarizeOldMessages(messages, systemPrompt);
    }

    const processedAttachments = processAttachments(attachments);

    let userContent = [];
    if (processedAttachments && processedAttachments.length > 0) {
      userContent.push(...processedAttachments);
    }
    userContent.push({ type: 'text', text: message });

    messages.push({ role: 'user', content: userContent });

    const finalSystemPrompt = systemPrompt || 
      'Você é Claude, um assistente de IA útil, criado pela Anthropic.';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullResponse = '';
    let usage = null;

    const stream = await anthropic.messages.stream({
      model: chosenModel,
      max_tokens: 8192,
      system: finalSystemPrompt,
      messages: messages.map(msg => ({
        role: msg.role,
        content: Array.isArray(msg.content) 
          ? msg.content 
          : [{ type: 'text', text: msg.content }]
      }))
    });

    stream.on('text', (text) => {
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    stream.on('message', (message) => {
      if (message.usage) {
        usage = message.usage;
      }
    });

    stream.on('end', async () => {
      messages.push({ role: 'assistant', content: fullResponse });

      let costInfo = null;
      if (usage) {
        costInfo = calculateCost(usage.input_tokens, usage.output_tokens, chosenModel);
        console.log(`💰 Custo: $${costInfo.cost.toFixed(6)}`);
        res.write(`data: ${JSON.stringify({ type: 'cost', cost: costInfo })}\n\n`);
      }

      try {
        if (conversationId) {
          const { data: existingConv } = await supabase
            .from('conversations')
            .select('cost_data')
            .eq('id', conversationId)
            .single();

          const costData = existingConv?.cost_data || [];
          if (costInfo) costData.push(costInfo);

          await supabase
            .from('conversations')
            .update({ 
              messages,
              cost_data: costData,
              updated_at: new Date().toISOString()
            })
            .eq('id', conversationId);
        } else {
          const title = message.substring(0, 50) + (message.length > 50 ? '...' : '');
          const { data } = await supabase
            .from('conversations')
            .insert([{ 
              title, 
              messages,
              cost_data: costInfo ? [costInfo] : [],
              updated_at: new Date().toISOString()
            }])
            .select()
            .single();
          
          res.write(`data: ${JSON.stringify({ type: 'conversationId', id: data.id })}\n\n`);
        }
      } catch (dbError) {
        console.error('❌ Erro ao salvar:', dbError);
      }

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    stream.on('error', (error) => {
      console.error('❌ Erro no streaming:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    });

  } catch (error) {
    console.error('❌ Erro no chat:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📱 Acesse: http://localhost:${PORT}`);
});