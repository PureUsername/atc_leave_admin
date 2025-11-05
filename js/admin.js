// main.js
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

const APPROVAL_ENDPOINT =
  process.env.APPROVAL_ENDPOINT ||
  process.env.LEAVE_APPROVAL_ENDPOINT ||
  'http://127.0.0.1:7041/atc/public/handle_approval_message';

const LOWBED_CHAT_ID = '120363406616265454@g.us';
const ADMIN_CHAT_ID = '120363368545737149@g.us';

const isNotificationChatId = (chatId) =>
  typeof chatId === 'string' && chatId.trim() === ADMIN_CHAT_ID;

// ---------- WhatsApp client ----------
const client = new Client({
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  authStrategy: new LocalAuth(),
});

let isReady = false;
const buttonContextByMessage = new Map();
const requestIdToMessageId = new Map();
const latestContextByChat = new Map();
let fetchImpl = typeof fetch === 'function' ? fetch.bind(global) : null;

client.on('ready', async () => {
  isReady = true;
  console.log('Client is ready!');
// const chats = await client.getChats();
// const groups = chats.filter(chat => chat.isGroup);
// console.log(groups.map(group => group.id));
// groups.forEach(group => {
//   console.log("Group id:", group.id);
//   console.log("Group Name:", group.name);
// });
// const clientInfo = await client.info;
// console.log("Client Name:", clientInfo.pushname || clientInfo.displayName);

  // (Optional) Example: send a base64 image on boot
  // const sampleB64 = '...'; // base64 string WITHOUT data: prefix
  // const media = new MessageMedia('image/jpeg', sampleB64, 'photo.jpg');
  // await client.sendMessage('120363406616265454@g.us', media, { caption: 'Here’s the picture 📸' });
});

client.on('disconnected', () => {
  isReady = false;
  console.warn('Client disconnected. Marking as not ready.');
});

client.on('auth_failure', (m) => {
  isReady = false;
  console.error('Auth failure:', m);
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    const groupId = chat?.id?._serialized;
    if (chat?.isGroup) {
      console.log(`Message received in group with ID: ${groupId}`);
    } else {
      console.log(`DM received from ${groupId || 'unknown chat'}`);
    }
    await handleInteractiveResponse(msg, chat);
    await handleManualApproval(msg, chat);
  } catch (e) {
    console.error('Error handling incoming message:', e);
  }
});

client.initialize();

// ---------- Lightweight HTTP API ----------
const app = express();
// IMPORTANT: raise body limit for base64 payloads
app.use(express.json({ limit: '25mb' }));

// Health / readiness
app.get('/status', (_req, res) => res.json({ ready: isReady }));

/**
 * POST /send
 * Text payload:
 *   { "chatId":"<...@g.us>", "content":"hello" }
 *
 * Base64 media payload:
 *   {
 *     "chatId":"<...@g.us>",
 *     "base64":"<BASE64-WITHOUT-DATA-PREFIX>",
 *     "mimeType":"image/jpeg",            // e.g. image/png, image/webp, video/mp4, audio/ogg, etc.
 *     "filename":"photo.jpg",
 *     "caption":"Here’s the picture 📸",  // optional
 *     "options": { "sendMediaAsHd": true } // optional wwebjs options
 *   }
 */
app.post('/send', async (req, res) => {
  try {
    if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready yet' });

    const {
      chatId,
      content,
      base64,
      mimeType,
      filename,
      caption,
      options,
      type,
      buttons,
      body,
      title,
      footer,
      mentionNumbers,
      mentions,
      metadata,
      request_id,
    } = req.body || {};
    if (!chatId) return res.status(400).json({ error: 'chatId is required' });

    let result;

    if (type === 'buttons') {
      const buttonPayload = buildButtonsPayload(body, buttons, title, footer, metadata);
      if (!buttonPayload) {
        return res.status(400).json({ error: 'Invalid buttons payload' });
      }

      const resolvedMentions = await resolveMentions([...toArray(mentionNumbers), ...toArray(mentions)]);
      const sendOptions = {
        ...(options || {}),
      };
      if (resolvedMentions.length) {
        sendOptions.mentions = resolvedMentions;
      }

      // Create a new metadata object that includes media details if present
      const combinedMetadata = { ...metadata };
      if (base64) combinedMetadata.base64 = base64;
      if (mimeType) combinedMetadata.mimeType = mimeType;
      if (filename) combinedMetadata.filename = filename;

      if (base64 && mimeType) {
        // If base64 and mimeType are present, send as media with caption
        const media = new MessageMedia(mimeType, stripDataPrefix(base64), filename || inferFilename(mimeType));
        result = await client.sendMessage(chatId, media, {
          caption: buttonPayload.body, // Use button body as caption
          // Note: Interactive buttons will NOT be sent with a media message in whatsapp-web.js.
          // This prioritizes sending the image as requested by the user.
          ...(options || {}),
          mentions: sendOptions.mentions // Keep mentions if any
        });
      } else {
        // Otherwise, send as a regular button message (text only)
        sendOptions.buttons = buttonPayload.message;
        result = await client.sendMessage(chatId, buttonPayload.body, sendOptions);
      }
      trackButtonContext(result, buttonPayload, combinedMetadata, chatId, request_id);
    } else if (base64 && mimeType) {
      // Send media (base64)
      const media = new MessageMedia(mimeType, stripDataPrefix(base64), filename || inferFilename(mimeType));
      result = await client.sendMessage(chatId, media, { caption, ...(options || {}) });
    } else if (typeof content === 'string') {
      // Send plain text
      result = await client.sendMessage(chatId, content, options);
    } else {
      return res.status(400).json({ error: 'Provide either {content} for text OR {base64,mimeType} for media' });
    }

    return res.status(200).json({ id: result?.id?.id || null });
  } catch (e) {
    console.error('Send API error:', e);
    return res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WA gateway listening on :${PORT}`));

/** Helpers */
function stripDataPrefix(b64) {
  // Accepts both raw base64 and data URLs like "data:image/jpeg;base64,AAAA..."
  const idx = b64.indexOf('base64,');
  return idx >= 0 ? b64.slice(idx + 7) : b64;
}
function inferFilename(mime) {
  const ext = ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
  }[mime] || 'bin');
  return `file.${ext}`;
}

function buildButtonsPayload(body, buttons = [], title, footer, metadata = {}) {
  const textBody = typeof body === 'string' ? body.trim() : '';
  if (!textBody) {
    return null;
  }

  let actionMap = {};
  if (metadata && typeof metadata === 'object') {
    if (metadata.button_actions_json) {
      try {
        actionMap = JSON.parse(String(metadata.button_actions_json));
      } catch (err) {
        console.warn('Failed to parse button_actions_json:', err);
      }
    }
  }

  const finalButtons = [];
  if (Array.isArray(buttons)) {
    buttons.forEach((entry) => {
      if (!entry) return;
      const bodyText = String(entry.body || entry.label || '').trim();
      if (!bodyText) return;
      const customId = entry.id ? String(entry.id).trim() : '';
      const action = customId || actionMap[bodyText] || inferActionIdFromLabel(bodyText);
      finalButtons.push(action ? { body: bodyText, id: action } : { body: bodyText });
      if (action) {
        actionMap[bodyText] = action;
      }
    });
  }

  if (!finalButtons.length && Object.keys(actionMap).length) {
    Object.entries(actionMap).forEach(([label, action]) => {
      const bodyText = String(label || '').trim();
      const actionId = String(action || '').trim() || inferActionIdFromLabel(bodyText);
      if (!bodyText) return;
      finalButtons.push(actionId ? { body: bodyText, id: actionId } : { body: bodyText });
      if (actionId) {
        actionMap[bodyText] = actionId;
      }
    });
  }

  if (!finalButtons.length) {
    return null;
  }

  const context = {
    actionsById: {},
    actionsByLabel: {},
  };
  const messageButtons = [];

  finalButtons.forEach((btn) => {
    const label = String(btn.body || '').trim();
    if (!label) return;
    let actionId = btn.id ? String(btn.id).trim() : '';
    if (!actionId) {
      actionId = inferActionIdFromLabel(label);
    }
    const buttonId = actionId || generateButtonId();
    messageButtons.push({
      buttonId,
      buttonText: { displayText: label },
      type: 1,
    });
    if (actionId) {
      context.actionsByLabel[label] = actionId;
      context.actionsById[actionId] = { label };
    } else {
      context.actionsByLabel[label] = '';
    }
  });

  if (!messageButtons.length) {
    return null;
  }

  const payload = {
    body: textBody,
    message: {
      body: textBody,
      buttons: messageButtons,
      type: 'chat',
    },
    context,
  };

  payload.context.metadata = normalizeMetadata(metadata);

  const trimmedTitle = typeof title === 'string' ? title.trim() : '';
  if (trimmedTitle) {
    payload.message.title = trimmedTitle;
  }

  const trimmedFooter = typeof footer === 'string' ? footer.trim() : '';
  if (trimmedFooter) {
    payload.message.footer = trimmedFooter;
  }

  return payload;
}

function generateButtonId(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  while (result.length < length) {
    const bytes = crypto.randomBytes(length - result.length);
    bytes.forEach((byte) => {
      if (result.length >= length) {
        return;
      }
      result += chars[byte % chars.length];
    });
  }
  return result;
}

function inferActionIdFromLabel(label) {
  if (!label) return '';
  const lower = label.toLowerCase();
  const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  if (/lulus|approve|approved|setuju|ok/.test(lower)) {
    return `auto:approve:${slug}`;
  }
  if (/tolak|reject|rejected|batal|no/.test(lower)) {
    return `auto:reject:${slug}`;
  }
  return '';
}

function trackButtonContext(resultMessage, payload, metadata, chatId, requestId) {
  if (!resultMessage || !payload || !payload.context) {
    return;
  }
  const messageId = resultMessage?.id?._serialized;
  if (!messageId) {
    return;
  }
  const context = payload.context || {};
  const normalizedMetadata =
    context.metadata && typeof context.metadata === 'object'
      ? { ...context.metadata }
      : normalizeMetadata(metadata);
  const storedContext = {
    actionsById: { ...(context.actionsById || {}) },
    actionsByLabel: { ...(context.actionsByLabel || {}) },
    metadata: normalizedMetadata,
    chatId,
    messageId,
  };
  buttonContextByMessage.set(messageId, storedContext);
  if (chatId) {
    latestContextByChat.set(chatId, storedContext);
  }
  const reqId = requestId || normalizedMetadata.request_id;
  if (reqId) {
    requestIdToMessageId.set(reqId, messageId);
  }
}

async function resolveMentions(rawList = []) {
  const ids = new Set();
  rawList.forEach((value) => {
    if (!value) return;
    const normalized = normalizeJid(value);
    if (normalized) {
      ids.add(normalized);
    }
  });
  const mentionIds = [];
  for (const id of ids) {
    try {
      await client.getContactById(id);
    } catch (err) {
      console.warn('Unable to resolve contact for mention:', id, err);
    }
    mentionIds.push(id);
  }
  return mentionIds;
}

function normalizeJid(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (str.endsWith('@c.us') || str.endsWith('@g.us')) {
    return str;
  }
  const digits = str.replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('60')) {
    return `${digits}@c.us`;
  }
  if (digits.startsWith('0') && digits.length > 1) {
    return `6${digits.slice(1)}@c.us`;
  }
  return `${digits}@c.us`;
}

function normalizeMetadata(source = {}) {
  if (!source || typeof source !== 'object') {
    return {};
  }
  const out = {};
  Object.entries(source).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    out[key] = String(value);
  });
  return out;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

async function handleInteractiveResponse(msg, chat) {
  if (msg.type !== 'buttons_response') {
    return;
  }

  const { originMessageId, context } = await resolveContextForButton(msg);
  if (!context) {
    console.warn('No button context found for response:', msg.selectedButtonId, msg.selectedButtonText);
    return;
  }

  const chatIdCandidate =
    chat?.id?._serialized ||
    (typeof msg.from === 'string' ? msg.from : null);
  const chatId = typeof chatIdCandidate === 'string' ? chatIdCandidate.trim() : null;
  if (!isNotificationChatId(chatId)) {
    return;
  }

  const actionId = determineActionId(msg, context);
  if (!actionId) {
    console.warn('Unable to determine action for button response.');
    return;
  }

  const decision = parseDecision(actionId);
  if (!decision) {
    console.warn('Unknown decision action:', actionId);
    return;
  }

  const requestId = extractRequestId(actionId) || context.metadata?.request_id || null;

  await processDecision({
    decision,
    context,
    chat,
    msg,
    originMessageId,
    requestId,
    actionId,
    source: 'button',
  });
}

async function handleManualApproval(msg, chat) {
  const isTextMessage = msg.type === 'chat' || msg.type === 'text';
  if (!isTextMessage || msg.fromMe) {
    return;
  }
  const chatId = chat?.id?._serialized || msg.from || null;
  if (!isNotificationChatId(chatId)) {
    return;
  }
  const decisionInfo = parseDecisionFromText(msg.body);
  if (!decisionInfo) {
    return;
  }
  const { decision, leaveQuery } = decisionInfo;

  // Handle 'leave' keyword to show approved leaves without requiring context
  if (decision === 'show_leaves') {
    await handleShowLeavesRequest(msg, chat, leaveQuery);
    return;
  }
  if (decision === 'help') {
    await sendHelpMenu(msg, chat);
    return;
  }

  let { originMessageId, context } = await resolveContextForManual(msg, chat);
  if (!context) {
    console.warn('Manual approval received without context; ignoring.');
    return;
  }

  // If the message is a reply, try to extract driver info from the quoted message
  if (msg.hasQuotedMsg) {
    const quotedMsg = await msg.getQuotedMessage();
    if (quotedMsg && quotedMsg.body) {
      const driverName = extractDriverNameFromLeaveRequest(quotedMsg.body);
      if (driverName) {
        // Update metadata with the extracted driver name
        context.metadata = { ...context.metadata, applicant_display_name: driverName };
      }
    }
  }

  const requestId = context.metadata?.request_id || null;

  await processDecision({
    decision,
    context,
    chat,
    msg,
    originMessageId,
    requestId,
    actionId: `manual:${decision}:${requestId || ''}`,
    source: 'manual',
  });
}

async function processDecision({
  decision,
  context,
  chat,
  msg,
  originMessageId,
  requestId,
  actionId,
  source,
}) {
  if (!decision || !context) {
    return;
  }

  const metadata = { ...(context.metadata || {}) };
  if (requestId && !metadata.request_id) {
    metadata.request_id = requestId;
  }
  const rangeLabel = metadata.date_range_label ? ` (${metadata.date_range_label})` : '';

  const approverContact = await msg.getContact();
  const approverInfo = buildApproverInfo(approverContact);
  const approverName = approverInfo.name || 'Admin';

  const applicantJid =
    normalizeJid(metadata.applicant_jid) ||
    normalizeJid(metadata.applicant_phone_number) ||
    null;
  let applicantContact = null;
  if (applicantJid) {
    try {
      applicantContact = await client.getContactById(applicantJid);
    } catch (err) {
      console.warn('Unable to fetch applicant contact for mention:', applicantJid, err);
    }
  }
  const applicantId = applicantContact?.id?._serialized || applicantJid || null;
  const mentionHandle = applicantId ? applicantId.split('@')[0] : null;
  const mentionTag = mentionHandle
    ? `@${mentionHandle}`
    : metadata.applicant_display_name || 'Pemohon';

  const bilingual = (ms, en) => {
  const parts = [ms, en]
    .filter(v => v != null)           // drop null/undefined
    .map(v => String(v).trim())       // normalize & trim
    .filter(v => v !== '');           // drop empty after trim
  return parts.join(' / ');
};

  const metadataChatId =
    typeof metadata.chat_id === 'string' ? metadata.chat_id.trim() : '';
  const contextChatId =
    typeof context.chatId === 'string' ? context.chatId.trim() : '';
  const rawChatId = chat?.id?._serialized;
  const incomingChatIdCandidate =
    typeof rawChatId === 'string'
      ? rawChatId
      : typeof msg.from === 'string'
      ? msg.from
      : '';
  const incomingChatId = incomingChatIdCandidate.trim();

  const originalChatId = metadataChatId || contextChatId; // This is the "chatId (from db)"
  const targetChatId = originalChatId || incomingChatId || ADMIN_CHAT_ID; // Fallback to incoming or ADMIN

  const baseSendOptions = applicantId ? { mentions: [applicantId] } : {};

  // 1. Send message to the original chat (from db) in Malay/English, if it exists and is not ADMIN_CHAT_ID
  if (originalChatId && originalChatId !== ADMIN_CHAT_ID) {
    const decisionTextOriginalChat = buildDecisionText(
      decision,
      mentionTag,
      rangeLabel,
      approverName,
      bilingual,
      metadata,
      { chatId: originalChatId, language: 'ms' } // Force Malay/English for original chat
    );
    try {
      await client.sendMessage(originalChatId, decisionTextOriginalChat, baseSendOptions);
    } catch (err) {
      console.error('Failed to send decision message to original chat:', err);
    }
  }

  // 2. Always send message to ADMIN_CHAT_ID in Chinese
  const decisionTextAdminChat = buildDecisionText(
    decision,
    mentionTag,
    rangeLabel,
    approverName,
    bilingual,
    metadata,
    { chatId: ADMIN_CHAT_ID, language: 'zh' } // Force Chinese for ADMIN_CHAT_ID
  );
  try {
    await client.sendMessage(ADMIN_CHAT_ID, decisionTextAdminChat, baseSendOptions);
  } catch (err) {
    console.error('Failed to send decision message to ADMIN_CHAT_ID:', err);
  }

  await forwardDecisionToBackend(decision, metadata, targetChatId, requestId, {
    actionId,
    source,
    messageId: msg.id?._serialized || null,
    originMessageId,
    approver: approverInfo,
  });

  if (originMessageId) {
    buttonContextByMessage.delete(originMessageId);
  }
  if (requestId) {
    requestIdToMessageId.delete(requestId);
  }
  if (targetChatId) {
    latestContextByChat.delete(targetChatId);
  }
}

async function forwardDecisionToBackend(decision, metadata, chatId, requestId, context = {}) {
  const action = decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : null;
  if (!action || !APPROVAL_ENDPOINT) {
    return;
  }
  const metadataForBackend = { ...metadata };
  if (requestId && !metadataForBackend.request_id) {
    metadataForBackend.request_id = requestId;
  }
  if (context.source) {
    metadataForBackend.decision_source = metadataForBackend.decision_source || context.source;
  }

  // Create the payload structure expected by the backend
  const payloadToSend = {
    action,
    chatId,
    metadata: metadataForBackend,
  };
  
  if (requestId) {
    payloadToSend.request_id = requestId;
  }
  if (context.messageId) {
    payloadToSend.messageId = context.messageId;
  }
  if (context.originMessageId) {
    payloadToSend.originMessageId = context.originMessageId;
  }
  if (context.approver) {
    payloadToSend.approver = context.approver;
  }

  try {
    const response = await fetchWithFallback(APPROVAL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadToSend),
    });
    if (!response) {
      console.warn('Backend approval notification skipped: fetch implementation unavailable.');
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('Failed to notify backend about decision:', response.status, text);
    } else {
      // Check if the response contains rejection reason for capacity
      const responseData = await response.json().catch(() => null);
      if (responseData && responseData.rejection_reason === 'capacity_full') {
        const dateRange = metadata.date_range_label || 'the requested dates';
        const bilingual = (ms, en) => `${ms} / ${en}`;
        const capacityMessage = bilingual(
          `Permohonan cuti baharu pada ${dateRange} (kerana mencapai had maksimum 3 orang sehari)`,
          ""
        );
        
        try {
          await client.sendMessage(chatId, capacityMessage);
        } catch (err) {
          console.error('Failed to send capacity explanation message:', err);
        }
      }
    }
  } catch (err) {
    console.error('Error notifying backend about decision:', err);
  }
}

function buildApproverInfo(contact) {
  if (!contact) {
    return { name: 'Admin' };
  }
  const number = contact.number || null;
  const pushName = contact.pushname || null;
  const name =
    contact.pushname ||
    contact.name ||
    contact.shortName ||
    number ||
    'Admin';
  return {
    id: contact.id?._serialized || null,
    number,
    pushName,
    shortName: contact.shortName || null,
    name,
  };
}

async function resolveContextForButton(msg) {
  let { originMessageId, context } = await resolveContextUsingQuotedMessage(msg);
  if (!context) {
    const potentialId = extractRequestId(msg.selectedButtonId);
    const mappedMessageId = potentialId ? requestIdToMessageId.get(potentialId) : null;
    if (mappedMessageId) {
      originMessageId = mappedMessageId;
      context = buttonContextByMessage.get(mappedMessageId);
    }
  }
  return { originMessageId, context };
}

async function resolveContextForManual(msg, chat) {
  let { originMessageId, context } = await resolveContextUsingQuotedMessage(msg);
  if (context) {
    return { originMessageId, context };
  }
  const chatId = chat?.id?._serialized || msg.from;
  if (chatId) {
    const latest = latestContextByChat.get(chatId);
    if (latest) {
      return {
        originMessageId: latest.messageId || originMessageId,
        context: latest,
      };
    }
  }
  return { originMessageId, context: null };
}

async function resolveContextUsingQuotedMessage(msg) {
  let originMessageId = null;
  let context = null;
  try {
    const quoted = await msg.getQuotedMessage();
    if (quoted?.id?._serialized) {
      originMessageId = quoted.id._serialized;
      context = buttonContextByMessage.get(originMessageId);
    }
  } catch (err) {
    // No quoted message available
  }
  return { originMessageId, context };
}

function extractDriverNameFromLeaveRequest(messageBody) {
  if (!messageBody) return null;
  
  // Enhanced regex patterns to extract driver names from leave request messages
  const patterns = [
    // Pattern 1: "Permohonan cuti baharu pada [date]: [driver_name]"
    /(Permohonan cuti baharu pada|New leave request on)\s+[^:]+:\s*([^\n\r(]+)/i,
    // Pattern 2: Look for driver name after the date line
    /(Permohonan cuti baharu pada|New leave request on)\s+[^:]+:\s*\n\s*([^\n\r(]+)/i,
    // Pattern 3: Look for driver name in parentheses format "Name (CATEGORY)"
    /([A-Za-z\s]+)\s*\([A-Z]+\)/,
    // Pattern 4: Simple pattern after colon
    /(Permohonan cuti baharu pada|New leave request on)[^:]*:\s*([^\n\r]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = messageBody.match(pattern);
    if (match && match[2]) {
      let driverName = match[2].trim();
      // Clean up the driver name - remove extra whitespace and common suffixes
      driverName = driverName.replace(/\s+/g, ' ').trim();
      // Remove category info in parentheses if present
      driverName = driverName.replace(/\s*\([^)]+\)\s*$/, '').trim();
      if (driverName && driverName.length > 0) {
        return driverName;
      }
    }
  }
  
  return null;
}

function parseDecisionFromText(body) {
  if (!body) {
    return null;
  }
  const normalized = String(body).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const tokens = normalized.split(/[\s,.!?:;()\[\]-]+/).filter(Boolean);
  const firstToken = tokens[0] || normalized;

  // Check for approval keywords
  if (['y', 'yes', 'ok', 'okay', 'k'].includes(firstToken)) {
    return { decision: 'approve' };
  }
  if (['y', 'yes', 'ok', 'okay', 'k'].includes(normalized)) {
    return { decision: 'approve' };
  }

  // Check for rejection keywords (case insensitive)
  if (['no', 'n', 'cannot', 'not ok'].includes(firstToken)) {
    return { decision: 'reject' };
  }
  if (['no', 'n', 'cannot', 'not ok'].includes(normalized)) {
    return { decision: 'reject' };
  }

  // Check for help keywords
  if (firstToken === 'help' || firstToken === 'h' || normalized === 'help' || normalized === 'h') {
    return { decision: 'help' };
  }

  // Check for 'leave' keyword variations to show approved leaves
  const leaveQuery = parseLeaveCommand(body);
  if (leaveQuery) {
    return { decision: 'show_leaves', leaveQuery };
  }

  return null;
}

function parseLeaveCommand(input) {
  if (!input) {
    return null;
  }
  const raw = String(input).trim();
  if (!raw) {
    return null;
  }

  const collapsed = raw.toLowerCase().replace(/\s+/g, '');
  const pattern = /^(?<year>\d{2,4})?(?<cmd>l(?:eave)?)(?<month>\d{1,2})?$/;
  const match = collapsed.match(pattern);
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (match && match.groups?.cmd) {
    const { year: yearPart, month: monthPart } = match.groups;
    const explicitYear = Boolean(yearPart);

    if (monthPart) {
      const month = parseInt(monthPart, 10);
      if (Number.isNaN(month) || month < 1 || month > 12) {
        return null;
      }
      let year = currentYear;
      if (explicitYear) {
        year = parseLeaveYear(yearPart);
      } else if (month < currentMonth) {
        year = currentYear + 1;
      }
      return {
        type: 'month',
        year,
        month,
        explicitYear,
        raw,
      };
    }

    if (explicitYear) {
      const year = parseLeaveYear(yearPart);
      return {
        type: 'year',
        year,
        explicitYear,
        raw,
      };
    }

    // Handle commands like "leave" or "l" (no month/year specified)
    return {
      type: 'month',
      year: currentYear,
      month: currentMonth,
      explicitYear: false,
      raw,
    };
  }

  // Allow simple commands like "leave" or "l" even if the regex didn't match
  const simple = raw.toLowerCase();
  if (simple === 'leave' || simple === 'l') {
    return {
      type: 'month',
      year: currentYear,
      month: currentMonth,
      explicitYear: false,
      raw,
    };
  }

  return null;
}

function parseLeaveYear(yearText) {
  if (!yearText) {
    return new Date().getFullYear();
  }
  const intVal = parseInt(yearText, 10);
  if (Number.isNaN(intVal)) {
    return new Date().getFullYear();
  }
  if (yearText.length === 2) {
    return 2000 + intVal;
  }
  return intVal;
}

function determineActionId(msg, context) {
  const directId = msg.selectedButtonId ? String(msg.selectedButtonId).trim() : '';
  if (directId && context.actionsById[directId]) {
    return directId;
  }
  const text = String(msg.selectedButtonText || msg.body || '').trim();
  if (!text) {
    return directId || null;
  }
  const mapped = context.actionsByLabel[text];
  return mapped || directId || null;
}

function parseDecision(actionId) {
  if (!actionId) return null;
  const parts = String(actionId).split(':');
  if (parts.length < 2) {
    return null;
  }
  const decision = parts[1].toLowerCase();
  if (decision === 'approve' || decision === 'rejected') {
    return decision === 'rejected' ? 'reject' : 'approve';
  }
  if (decision === 'reject') {
    return 'reject';
  }
  if (decision === 'approved') {
    return 'approve';
  }
  return null;
}

function extractRequestId(actionId) {
  if (!actionId) return null;
  const parts = String(actionId).split(':');
  return parts.length >= 3 ? parts[2] : null;
}

function buildDecisionText(decision, mentionTag, rangeLabel, approverName, bilingual, metadata = {}, options = {}) {
  const cleanRange = rangeLabel || '';
  const targetChatId = options.chatId || null;
  let language = options.language || null;

  if (!language && targetChatId) {
    if (targetChatId === LOWBED_CHAT_ID) {
      language = 'ms';
    } else if (targetChatId === ADMIN_CHAT_ID) {
      language = 'zh';
    }
  }

  if (!language) {
    language = 'ms';
  }

  if (language === 'zh') {
    const cleanRangeText = (cleanRange || '').trim();
    const rawRange =
      cleanRangeText.replace(/[()]/g, '').trim() ||
      (metadata.date_range_label || '').trim();
    const rangeText = rawRange || '该日期';
    const applicantTag = mentionTag || '申请人';
    const approver = approverName || '管理员';

    const isCapacityReject =
      metadata &&
      (metadata.reject_reason === 'capacity_full' ||
        metadata.rejection_reason === 'capacity_full' ||
        metadata.reason === 'capacity_full');

    if (decision === 'approve') {
      return `${applicantTag} 的请假申请已被 ${approver} 接受。`;
    }
    if (decision === 'reject') {
      if (isCapacityReject && cleanRangeText) {
        return `${applicantTag} 的请假申请因当天请假人数已达上限（3人），已被 ${approver} 拒绝。`;
      }
      return `${applicantTag} 的请假申请已被 ${approver} 拒绝。`;
    }
    return `${applicantTag} 的请假申请状态已由 ${approver} 更新。`;
  }

  if (decision === 'approve') {
    return bilingual(
      `${mentionTag} permohonan cuti${cleanRange} telah diluluskan oleh ${approverName}.`,
      ""
    );
  }
  if (decision === 'reject') {
    // Check if rejection is due to capacity limit
    const isCapacityReject =
      metadata &&
      (metadata.reject_reason === 'capacity_full' ||
        metadata.rejection_reason === 'capacity_full' ||
        metadata.reason === 'capacity_full');

    if (isCapacityReject && cleanRange) {
      return bilingual(
        `${mentionTag} permohonan cuti baharu pada ${cleanRange} telah ditolak oleh ${approverName} (kerana mencapai had maksimum 3 orang sehari).`,
        ""
      );
    } else {
      return bilingual(
        `${mentionTag} permohonan cuti${cleanRange} telah ditolak oleh ${approverName}.`,
        ""
      );
    }
  }
  return bilingual(
    `${mentionTag} status permohonan cuti${cleanRange} telah dikemas kini oleh ${approverName}.`,
    ""
  );
}

async function sendHelpMenu(msg, chat) {
  const targetChatId = chat?.id?._serialized || msg.from;
  if (!targetChatId) {
    console.warn('Unable to determine chat for help menu response.');
    return;
  }

  const helpMessageLines = [
    '请假指令帮助',
    '',
    '使用以下快捷方式查看已批准的请假记录:',
    "- 'leave' 或 'l'：显示当前月份的已批准请假记录。",
    "- 'leave11'、'leave 11'、'l11' 或 'l 11'：显示指定月份的已批准请假。如果该月份在今年已过，将自动使用下一年。",
    "- '25leave10'、'25 leave 10'、'25l10' 或 '25 l 10'：以年份优先的格式查看指定月份的已批准请假（例如：2025年10月）。",
    "- '25leave'、'25 leave'、'25l' 或 '25 l'：查看该年份所有已批准的请假（例如：2025年）。",
    '',
    '快速审批快捷方式:',
    "- 'y'、'yes'、'ok'、'okay' 或 'k'：表示批准。",
    "- 'no'、'n'、'cannot' 或 'not ok'：表示拒绝。",
    "- 也可以直接回复某条请假请求的对话，输入上述任意审批指令来快速处理该请求。",
    '',
    '相关网址说明:',
    "- https://al.autocash.my ：查看所有司机请假记录及设定司机资料的管理网址（就只有你们用）",
    "- https://ll.autocash.my ：LOWBED 司机请假的网址",
    "- https://sl.autocash.my ：SAND 司机请假的网址",
    "- https://kl.autocash.my ：KSK 司机请假的网址",
    '',
    '手机日历添加链接:',
    "- 如果你希望将司机请假日历添加到手机上，可以使用以下链接：",
    "- LOWBED 的日历： f.com",
    "- SAND 的日历： g.com",
    "- KSK 的日历： h.com",
    '',
    "随时发送 'help' 或 'h' 可再次查看此菜单。",
  ];

  const helpMessage = helpMessageLines.join('\n');

  try {
    await client.sendMessage(targetChatId, helpMessage);
  } catch (err) {
    console.error('Failed to send help menu:', err);
  }
}

async function handleShowLeavesRequest(msg, chat, leaveQuery) {
  const targetChatId = chat?.id?._serialized || msg.from;
  if (!isNotificationChatId(targetChatId)) {
    return;
  }
  
  // Create a payload to request approved leaves for current month
  const payloadToSend = {
    action: 'show_leaves',
    chatId: targetChatId,
    metadata: {
      request_type: 'show_leaves',
      source: 'manual'
    }
  };
  if (leaveQuery) {
    payloadToSend.metadata.leave_query = leaveQuery;
  }
  if (msg?.body) {
    payloadToSend.command = msg.body;
  }

  try {
    const response = await fetchWithFallback(APPROVAL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadToSend),
    });
    if (!response) {
      console.warn('Backend show leaves request skipped: fetch implementation unavailable.');
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('Failed to request approved leaves from backend:', response.status, text);
    }
  } catch (err) {
    console.error('Error requesting approved leaves from backend:', err);
  }
}

async function fetchWithFallback(url, options) {
  if (!fetchImpl) {
    return null;
  }
  return fetchImpl(url, options);
}
