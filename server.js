const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.use(bodyParser.json());

const punishments = {
  bans: new Map(),
  mutes: new Map()
};

const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1466903892163039274/V-BA7Zd9mU_uAFf5Rqs_2rj9sAy8o6pVuxpwImiN0Zo42cIr_AReZ7HEI1JQmTsreNwD";

// Verificação de assinatura do Discord
function verifyDiscordSignature(req) {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const body = JSON.stringify(req.body);
  
  // Se não houver PUBLIC_KEY configurada, aceita qualquer requisição (modo dev)
  if (!process.env.DISCORD_PUBLIC_KEY) {
    console.log('[WARN] Discord public key não configurada - aceitando requisição');
    return true;
  }
  
  try {
    const isValid = crypto.verify(
      'ed25519',
      Buffer.from(timestamp + body),
      {
        key: Buffer.from(process.env.DISCORD_PUBLIC_KEY, 'hex'),
        format: 'der',
        type: 'spki'
      },
      Buffer.from(signature, 'hex')
    );
    return isValid;
  } catch (error) {
    console.error('[ERROR] Erro ao verificar assinatura:', error);
    return false;
  }
}

app.get('/check/:userId', (req, res) => {
  const userId = req.params.userId;
  let banned = false;
  let muted = false;
  let banReason = null;
  let muteExpiry = null;
  
  if (punishments.bans.has(userId)) {
    const banData = punishments.bans.get(userId);
    if (banData.permanent || (banData.expiry && Date.now() < banData.expiry * 1000)) {
      banned = true;
      banReason = banData.reason;
    } else {
      punishments.bans.delete(userId);
    }
  }
  
  if (punishments.mutes.has(userId)) {
    const muteData = punishments.mutes.get(userId);
    if (muteData.expiry && Date.now() < muteData.expiry * 1000) {
      muted = true;
      muteExpiry = muteData.expiry;
    } else {
      punishments.mutes.delete(userId);
    }
  }
  
  res.json({ banned, muted, banReason, muteExpiry });
});

app.post('/punish', async (req, res) => {
  const { userId, type, data } = req.body;
  console.log(`[PUNISH] Aplicando ${type} para usuário ${userId}`);
  
  switch (type) {
    case 'BAN_PERM':
      punishments.bans.set(userId, {
        permanent: true,
        reason: data.reason || 'Violação dos termos',
        timestamp: Math.floor(Date.now() / 1000)
      });
      break;
    case 'BAN_7D':
      punishments.bans.set(userId, {
        permanent: false,
        expiry: data.expiry,
        reason: data.reason || 'Violações repetidas',
        timestamp: Math.floor(Date.now() / 1000)
      });
      break;
    case 'MUTE_24H':
    case 'MUTE_1H':
      punishments.mutes.set(userId, {
        expiry: data.expiry,
        timestamp: Math.floor(Date.now() / 1000)
      });
      break;
  }
  
  res.json({ success: true });
});

app.post('/discord-interaction', async (req, res) => {
  const interaction = req.body;
  
  // Responder ao PING do Discord (verificação inicial)
  if (interaction.type === 1) {
    console.log('[DISCORD] Recebido PING do Discord - respondendo PONG');
    return res.json({ type: 1 });
  }
  
  // Processar interações de botões
  if (interaction.type !== 3) {
    return res.status(400).json({ error: 'Invalid interaction type' });
  }
  
  const customId = interaction.data.custom_id;
  const parts = customId.split('_');
  const action = parts[0] + '_' + parts[1];
  const userId = parts[2];
  let responseMessage = '';
  
  switch (action) {
    case 'ban_perm':
      punishments.bans.set(userId, {
        permanent: true,
        reason: 'Ban aplicado por moderador',
        timestamp: Math.floor(Date.now() / 1000)
      });
      responseMessage = `✅ Usuário ${userId} foi **banido permanentemente**.`;
      break;
    case 'ban_7d':
      const ban7dExpiry = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
      punishments.bans.set(userId, {
        permanent: false,
        expiry: ban7dExpiry,
        reason: 'Ban temporário por moderador',
        timestamp: Math.floor(Date.now() / 1000)
      });
      responseMessage = `✅ Usuário ${userId} foi **banido por 7 dias**.`;
      break;
    case 'mute_1h':
      const mute1hExpiry = Math.floor(Date.now() / 1000) + (60 * 60);
      punishments.mutes.set(userId, {
        expiry: mute1hExpiry,
        timestamp: Math.floor(Date.now() / 1000)
      });
      responseMessage = `✅ Usuário ${userId} foi **mutado por 1 hora**.`;
      break;
    case 'ignore':
      responseMessage = `✅ Alerta para usuário ${userId} foi **ignorado**.`;
      break;
    default:
      responseMessage = '❌ Ação desconhecida.';
  }
  
  try {
    await axios.patch(
      `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      { content: responseMessage, components: [] }
    );
  } catch (error) {
    console.error('Erro ao atualizar mensagem:', error);
  }
  
  res.json({ type: 4, data: { content: responseMessage, flags: 64 } });
  console.log(`[ACTION] ${action} aplicado ao usuário ${userId}`);
});

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bans: punishments.bans.size,
    mutes: punishments.mutes.size,
    version: '2.0'
  });
});

app.get('/punishments', (req, res) => {
  const allPunishments = {
    bans: Array.from(punishments.bans.entries()).map(([userId, data]) => ({ userId, ...data })),
    mutes: Array.from(punishments.mutes.entries()).map(([userId, data]) => ({ userId, ...data }))
  };
  res.json(allPunishments);
});

app.delete('/remove/:userId', (req, res) => {
  const userId = req.params.userId;
  const hadBan = punishments.bans.delete(userId);
  const hadMute = punishments.mutes.delete(userId);
  res.json({ success: hadBan || hadMute, removed: { ban: hadBan, mute: hadMute } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🛡️ Embee Chat Moderation Server v2.0 rodando na porta ${PORT}`);
  console.log(`📡 Endpoint Discord: /discord-interaction`);
});
