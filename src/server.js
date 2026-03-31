require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio envoie du form-urlencoded
app.use(express.static(path.join(__dirname, '..', 'public')));

// =============================================================
//  TWILIO CLIENT
// =============================================================
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886'; // Sandbox default
const TWILIO_WA_SANDBOX_CODE = process.env.TWILIO_WHATSAPP_SANDBOX_CODE || 'join wealth-appearance';

let twilioClient = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = new twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log('📱 Twilio WhatsApp activé');
} else {
  console.log('⚠️  Twilio non configuré — WhatsApp désactivé');
}

// =============================================================
//  SENDGRID EMAIL CLIENT
// =============================================================
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL || 'noreply@fenetre-agent.com';
let sgMail = null;
if (SENDGRID_KEY) {
  sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(SENDGRID_KEY);
  console.log('📧 SendGrid Email activé');
} else {
  console.log('⚠️  SendGrid non configuré — Email désactivé');
}

// =============================================================
//  CONVERSATION SUMMARY & SEND
// =============================================================
function buildConversationSummary(conv, data) {
  const entreprise = data?.entreprise || {};
  const nom = entreprise.Nom || 'Notre entreprise';
  const tel = entreprise['Téléphone'] || '';

  // Filter out system messages, keep user + assistant
  const msgs = conv.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  
  let summary = `📋 *Récapitulatif de votre échange avec ${nom}*\n\n`;
  
  for (const msg of msgs) {
    if (msg.role === 'user') {
      summary += `👤 *Vous* : ${msg.content}\n\n`;
    } else {
      summary += `🪟 *${nom}* : ${msg.content}\n\n`;
    }
  }

  summary += `---\n`;
  summary += `📞 Pour aller plus loin : ${tel}\n`;
  summary += `📍 ${entreprise['Adresse Showroom'] || ''}\n`;
  summary += `🕐 ${entreprise.Horaires || 'Lun-Ven 8h-18h'}\n`;

  return summary;
}

function buildEmailHtml(conv, data) {
  const entreprise = data?.entreprise || {};
  const nom = entreprise.Nom || 'Notre entreprise';
  const tel = entreprise['Téléphone'] || '';

  const msgs = conv.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  
  let html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #2563EB; color: white; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 20px;">🪟 ${nom}</h1>
        <p style="margin: 5px 0 0; opacity: 0.9;">Récapitulatif de votre conversation</p>
      </div>
      <div style="background: white; border: 1px solid #E5E7EB; padding: 20px; border-radius: 0 0 12px 12px;">
  `;

  for (const msg of msgs) {
    if (msg.role === 'user') {
      html += `
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; color: #374151; margin-bottom: 4px;">👤 Vous</div>
          <div style="background: #2563EB; color: white; padding: 12px 16px; border-radius: 12px; display: inline-block; max-width: 90%;">
            ${msg.content.replace(/\n/g, '<br>')}
          </div>
        </div>`;
    } else {
      html += `
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; color: #374151; margin-bottom: 4px;">🪟 ${nom}</div>
          <div style="background: #F3F4F6; padding: 12px 16px; border-radius: 12px; display: inline-block; max-width: 90%;">
            ${msg.content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}
          </div>
        </div>`;
    }
  }

  html += `
        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;">
        <div style="text-align: center; color: #6B7280; font-size: 14px;">
          <p>📞 <strong>${tel}</strong> — ${entreprise.Horaires || 'Lun-Ven 8h-18h'}</p>
          <p>📍 ${entreprise['Adresse Showroom'] || ''}</p>
          <p style="margin-top: 16px;">Merci de votre intérêt ! N'hésitez pas à nous recontacter.</p>
        </div>
      </div>
    </div>`;

  return html;
}

async function sendSummaryWhatsApp(phone, summary) {
  if (!twilioClient) {
    console.log('⚠️  Twilio non configuré, impossible d\'envoyer le résumé WhatsApp');
    return false;
  }

  // Format phone for WhatsApp
  let waPhone = phone.replace(/[\s.-]/g, '');
  if (waPhone.startsWith('0')) {
    waPhone = '+33' + waPhone.substring(1);
  }
  if (!waPhone.startsWith('+')) {
    waPhone = '+' + waPhone;
  }

  try {
    // WhatsApp has a 1600 char limit per message, split if needed
    const chunks = [];
    let remaining = summary;
    while (remaining.length > 0) {
      if (remaining.length <= 1500) {
        chunks.push(remaining);
        break;
      }
      // Find a good split point
      let splitAt = remaining.lastIndexOf('\n\n', 1500);
      if (splitAt < 500) splitAt = 1500;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trim();
    }

    for (const chunk of chunks) {
      await twilioClient.messages.create({
        body: chunk,
        from: TWILIO_WA_NUMBER,
        to: `whatsapp:${waPhone}`,
      });
    }

    console.log(`✅ Résumé WhatsApp envoyé à ${waPhone}`);
    return true;
  } catch (err) {
    console.error(`❌ Erreur envoi WhatsApp résumé:`, err.message);
    return false;
  }
}

async function sendSummaryEmail(email, html, entrepriseNom) {
  if (!sgMail) {
    console.log('⚠️  SendGrid non configuré, impossible d\'envoyer le résumé email');
    return false;
  }

  try {
    await sgMail.send({
      to: email,
      from: SENDGRID_FROM,
      subject: `Récapitulatif de votre échange avec ${entrepriseNom}`,
      html: html,
    });
    console.log(`✅ Résumé email envoyé à ${email}`);
    return true;
  } catch (err) {
    console.error(`❌ Erreur envoi email résumé:`, err.message);
    return false;
  }
}

// Track summary send status per conversation
const summarySent = new Set();

// =============================================================
//  AIRTABLE CLIENT
// =============================================================
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = process.env.AIRTABLE_BASE_ID;
const AT_TABLES = {
  catalogue:     process.env.AIRTABLE_TABLE_CATALOGUE,
  entreprise:    process.env.AIRTABLE_TABLE_ENTREPRISE,
  leads:         process.env.AIRTABLE_TABLE_LEADS,
  conversations: process.env.AIRTABLE_TABLE_CONVERSATIONS,
  faq:           process.env.AIRTABLE_TABLE_FAQ,
};

async function airtableFetch(tableId, params = '') {
  const url = `https://api.airtable.com/v0/${AT_BASE}/${tableId}${params}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${AT_TOKEN}` },
  });
  return res.json();
}

async function airtableCreate(tableId, records) {
  const url = `https://api.airtable.com/v0/${AT_BASE}/${tableId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records }),
  });
  return res.json();
}

async function airtableUpdate(tableId, records) {
  const url = `https://api.airtable.com/v0/${AT_BASE}/${tableId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${AT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records }),
  });
  return res.json();
}

// =============================================================
//  LOAD DATA FROM AIRTABLE (with cache)
// =============================================================
let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // Refresh toutes les 60 secondes

async function loadDataFromAirtable() {
  if (cachedData && (Date.now() - cacheTime) < CACHE_TTL) {
    return cachedData;
  }

  console.log('🔄 Chargement des données depuis Airtable...');

  const [catalogueRes, entrepriseRes, faqRes] = await Promise.all([
    airtableFetch(AT_TABLES.catalogue, '?filterByFormula={Actif}=TRUE()'),
    airtableFetch(AT_TABLES.entreprise, '?filterByFormula={Actif}=TRUE()&maxRecords=1'),
    airtableFetch(AT_TABLES.faq, '?filterByFormula={Actif}=TRUE()'),
  ]);

  const entreprise = entrepriseRes.records?.[0]?.fields || {};
  const gammes = (catalogueRes.records || []).map(r => r.fields);
  const faq = (faqRes.records || []).map(r => r.fields);

  cachedData = { entreprise, gammes, faq };
  cacheTime = Date.now();

  console.log(`✅ Chargé: ${gammes.length} gammes, ${faq.length} FAQ, entreprise: ${entreprise.Nom || '?'}`);
  return cachedData;
}

// =============================================================
//  SYSTEM PROMPT BUILDER
// =============================================================
const systemPromptTemplate = fs.readFileSync(
  path.join(__dirname, 'data', 'system-prompt.md'), 'utf-8'
);

function buildSystemPrompt(data) {
  const { entreprise, gammes, faq } = data;

  let prompt = systemPromptTemplate
    .replace(/\{\{entreprise_nom\}\}/g, entreprise.Nom || 'Notre entreprise')
    .replace(/\{\{entreprise_ville\}\}/g, entreprise.Ville || '')
    .replace(/\{\{entreprise_tel\}\}/g, entreprise['Téléphone'] || '')
    .replace(/\{\{whatsapp_sandbox_code\}\}/g, TWILIO_WA_SANDBOX_CODE)
    .replace(/\{\{whatsapp_sandbox_number\}\}/g, '+1 415 523 8886')
    .replace(/\{\{whatsapp_sandbox_link\}\}/g, `https://wa.me/14155238886?text=${encodeURIComponent(TWILIO_WA_SANDBOX_CODE)}`);

  // Injection des données Airtable dans le contexte
  const catalogueContext = {
    entreprise: {
      nom: entreprise.Nom,
      ville: entreprise.Ville,
      telephone: entreprise['Téléphone'],
      email: entreprise.Email,
      horaires: entreprise.Horaires,
      showroom: entreprise['Adresse Showroom'],
      zone: entreprise['Zone Intervention'],
      anciennete: entreprise['Ancienneté'],
      certifications: entreprise.Certifications,
      garantie_pose: entreprise['Garantie Pose (ans)'],
      delai_fabrication: entreprise['Délai Fabrication'],
    },
    gammes: gammes.map(g => ({
      nom: g['Nom Gamme'],
      materiau: g['Matériau'],
      segment: g.Segment,
      vitrage: g.Vitrage,
      uw: g.Uw,
      sw: g.Sw,
      acoustique_db: g['Acoustique dB'],
      prix: {
        fenetre_1v: g['Prix Fenêtre 1v'],
        fenetre_2v: g['Prix Fenêtre 2v'],
        porte_fenetre_1v: g['Prix Porte-Fenêtre 1v'],
        porte_fenetre_2v: g['Prix Porte-Fenêtre 2v'],
        baie_coulissante: g['Prix Baie Coulissante'],
      },
      garantie_chassis_ans: g['Garantie Châssis (ans)'],
      coloris: g.Coloris,
      points_forts: g['Points Forts'],
      points_faibles: g['Points Faibles'],
      ideal_pour: g['Idéal Pour'],
    })),
    faq: faq.map(f => ({
      question: f.Question,
      reponse: f['Réponse'],
      categorie: f['Catégorie'],
    })),
  };

  prompt += `\n\n## CATALOGUE COMPLET (données internes — source Airtable)\n\`\`\`json\n${JSON.stringify(catalogueContext, null, 2)}\n\`\`\``;

  return prompt;
}

// =============================================================
//  IA CLIENT
// =============================================================
const DEMO_MODE = !process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-xxx';

let openai = null;
if (!DEMO_MODE) {
  const { OpenAI } = require('openai');
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

if (DEMO_MODE) {
  console.log('⚠️  Mode DÉMO (pas de clé OpenAI). Réponses basées sur Airtable.');
  console.log('   Pour le mode IA réel, configure OPENAI_API_KEY dans .env\n');
}

// =============================================================
//  DEMO REPLIES (uses Airtable data)
// =============================================================
function getDemoReply(message, data) {
  const msg = message.toLowerCase();
  const { entreprise, gammes, faq } = data;
  const nom = entreprise.Nom || 'Notre entreprise';
  const tel = entreprise['Téléphone'] || '';

  // Build price table dynamically from Airtable data
  function buildPriceInfo() {
    return gammes.map(g => 
      `• **${g['Nom Gamme']}** (${g['Matériau']} — ${g.Segment}) : fenêtre 2v à partir de ${g['Prix Fenêtre 2v']}€, porte-fenêtre dès ${g['Prix Porte-Fenêtre 2v']}€, baie coulissante dès ${g['Prix Baie Coulissante']}€`
    ).join('\n');
  }

  if (msg.includes('rénov') || msg.includes('changer') || msg.includes('commencer') || msg.includes('maison')) {
    const gammeList = gammes.map(g => 
      `- **${g['Nom Gamme']}** (${g['Matériau']}) — à partir de ${g['Prix Fenêtre 1v']}€/fenêtre (${g.Segment?.toLowerCase()})`
    ).join('\n');

    return `Super projet ! Pour bien vous orienter, j'aurais quelques questions :\n\n1. **Combien de fenêtres** souhaitez-vous remplacer ?\n2. **Quel type de logement ?** Maison, appartement, ancien, récent ?\n3. **Avez-vous une idée du budget ?**\n\nChez ${nom}, nous proposons ${gammes.length} gammes :\n${gammeList}\n\nTous les prix incluent la pose par nos équipes certifiées RGE. Quel aspect vous intéresse le plus ?`;
  }

  if (msg.includes('pvc') && msg.includes('alu')) {
    const pvc = gammes.find(g => g['Matériau'] === 'PVC' && g.Segment?.includes('Milieu'));
    const alu = gammes.find(g => g['Matériau'] === 'Aluminium');
    return `Très bonne question ! Voici un comparatif honnête :\n\n**🔹 PVC** ${pvc ? `(ex: ${pvc['Nom Gamme']})` : ''}\n- ✅ Meilleur rapport qualité/prix\n- ✅ Zéro entretien\n- ✅ Très bonne isolation (Uw ${pvc?.Uw || '~1.1'})\n- ⚠️ Profilés un peu plus épais\n- 💰 Fenêtre 2v à partir de ${pvc?.['Prix Fenêtre 2v'] || '~700'}€\n\n**🔹 Aluminium** ${alu ? `(ex: ${alu['Nom Gamme']})` : ''}\n- ✅ Design contemporain, profilés fins\n- ✅ Durabilité exceptionnelle (Uw ${alu?.Uw || '~0.9'})\n- ⚠️ 40 à 60% plus cher que le PVC\n- 💰 Fenêtre 2v à partir de ${alu?.['Prix Fenêtre 2v'] || '~1100'}€\n\n**Mon conseil honnête :** pour une rénovation classique → PVC. Pour du neuf contemporain → Alu.\n\nQuel est votre cas ?`;
  }

  if (msg.includes('aide') || msg.includes('financ') || msg.includes('prime') || msg.includes('subvention')) {
    const faqAides = faq.find(f => f['Catégorie'] === 'Aides');
    return faqAides?.['Réponse'] || `En rénovation, vous pouvez cumuler : TVA 5,5%, MaPrimeRénov', CEE, et Éco-PTZ. Nous vous accompagnons dans les démarches. Souhaitez-vous qu'on planifie une visite technique gratuite ? 📞 ${tel}`;
  }

  if (msg.includes('prix') || msg.includes('tarif') || msg.includes('combien') || msg.includes('budget') || msg.includes('coût')) {
    return `Voici nos fourchettes de prix indicatifs **(pose incluse)** :\n\n${buildPriceInfo()}\n\n⚠️ Prix indicatifs — le devis final dépend des dimensions exactes et de l'état des dormants. La visite technique est **gratuite et sans engagement**.\n\nVous voulez qu'on organise ça ? 📞 ${tel}`;
  }

  if (msg.includes('rdv') || msg.includes('rendez-vous') || msg.includes('visite') || msg.includes('devis')) {
    return `Parfait ! 🎉\n\n1. **Visite technique gratuite** — un conseiller vient chez vous sous 48h\n2. **Mesures exactes** + évaluation des dormants\n3. **Devis détaillé sous 48h**\n4. **Aucun engagement**\n\n📞 Appelez-nous au **${tel}** (${entreprise.Horaires || 'lun-ven'})\n📍 Ou passez au showroom : **${entreprise['Adresse Showroom'] || ''}**`;
  }

  if (msg.includes('garantie')) {
    return `Chez ${nom}, nous offrons :\n\n${gammes.map(g => `- 🛡️ **${g['Nom Gamme']}** : garantie châssis ${g['Garantie Châssis (ans)']} ans`).join('\n')}\n- 🛡️ Garantie pose : ${entreprise['Garantie Pose (ans)'] || 10} ans (toutes gammes)\n\nCertifications : ${entreprise.Certifications || 'RGE QualiBAT'}\n\nAvez-vous d'autres questions ?`;
  }

  // Default
  return `Merci pour votre question ! Je peux vous aider sur :\n\n- 🏠 **Votre projet** — rénovation, neuf, nombre de fenêtres\n- 🔍 **Les matériaux** — PVC, alu, bois, mixte\n- 💶 **Les prix** — fourchettes indicatives\n- 💰 **Les aides financières** — MaPrimeRénov', CEE, TVA réduite\n- 📅 **Prendre RDV** — visite technique gratuite\n\nQu'est-ce qui vous intéresse ?`;
}

// =============================================================
//  CONTACT EXTRACTION (from hidden JSON in AI reply)
// =============================================================
function extractContact(reply) {
  const match = reply.match(/<!--CONTACT:(.*?)-->/);
  if (!match) return null;
  try {
    const contact = JSON.parse(match[1]);
    if (contact.prenom || contact.nom) return contact;
    return null;
  } catch (e) {
    return null;
  }
}

function cleanReply(reply) {
  return reply.replace(/\s*<!--CONTACT:.*?-->\s*/g, '').trim();
}

// =============================================================
//  CONTACT EXTRACTION FROM USER MESSAGE (server-side backup)
//  Only extracts phone & email (reliable patterns).
//  Name & ville come from AI extraction only (too error-prone via regex).
// =============================================================
function extractContactFromUserMessage(message) {
  const contact = { prenom: '', nom: '', email: '', telephone: '', ville: '' };
  let found = false;

  // Email
  const emailMatch = message.match(/[\w.-]+@[\w.-]+\.\w{2,}/);
  if (emailMatch) { contact.email = emailMatch[0]; found = true; }

  // Phone (French formats: 06/07, +33, with optional spaces/dots/dashes)
  const phoneMatch = message.match(/(?:(?:\+33|0033)\s*[67]|0[67])(?:[\s.-]*\d{2}){4}/);
  if (phoneMatch) { contact.telephone = phoneMatch[0].replace(/[\s.-]/g, ''); found = true; }

  return found ? contact : null;
}

// =============================================================
//  INTENT DETECTION
// =============================================================
function detectIntent(userMessage) {
  const msg = userMessage.toLowerCase();
  const intents = [];
  if (msg.includes('rendez-vous') || msg.includes('rdv') || msg.includes('visite') || msg.includes('devis'))
    intents.push('rdv_request');
  if (msg.includes('prix') || msg.includes('coût') || msg.includes('combien') || msg.includes('budget') || msg.includes('tarif'))
    intents.push('price_inquiry');
  if (msg.includes('fenêtre') || msg.includes('fenetre') || msg.includes('baie') || msg.includes('rénov') || msg.includes('maison'))
    intents.push('project');
  if (msg.includes('commercial') || msg.includes('appeler') || msg.includes('téléphone') || msg.includes('humain'))
    intents.push('human_request');
  if (msg.includes('aide') || msg.includes('prime') || msg.includes('subvention') || msg.includes('financ'))
    intents.push('aides');
  return intents;
}

// =============================================================
//  LEAD SCORING
// =============================================================
function computeLeadScore(intents, messageCount) {
  let score = 1;
  if (intents.includes('project')) score++;
  if (intents.includes('price_inquiry')) score++;
  if (intents.includes('rdv_request')) score += 2;
  if (intents.includes('human_request')) score++;
  if (messageCount > 5) score++;
  return Math.min(score, 5);
}

// =============================================================
//  WELCOME MESSAGE (must match what's shown in the frontend)
// =============================================================
const WELCOME_MESSAGE = "Bonjour ! 👋 Je suis Léa, l'assistante virtuelle de {{entreprise_nom}}.\n\nJe peux vous aider à choisir vos fenêtres, comparer les matériaux, et obtenir des fourchettes de prix.\n\nPour que vous puissiez retrouver facilement notre échange, je peux vous envoyer un résumé par email ou WhatsApp à la fin de notre conversation. Pour cela, pourriez-vous me communiquer :\n- Votre prénom et nom\n- Votre email ou numéro de portable\n- Votre ville\n\nBien sûr, c'est facultatif — vous pouvez aussi poser vos questions directement ! 😊";

function getWelcomeMessage(data) {
  const nom = data?.entreprise?.Nom || 'notre entreprise';
  return WELCOME_MESSAGE.replace(/\{\{entreprise_nom\}\}/g, nom);
}

// =============================================================
//  CONVERSATIONS (in-memory + Airtable sync)
// =============================================================
const conversations = new Map();

// =============================================================
//  API CHAT
// =============================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message requis' });
    }

    // Load data from Airtable
    const data = await loadDataFromAirtable();

    // Get or create conversation
    const convId = conversationId || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!conversations.has(convId)) {
      // Seed with welcome message so the AI knows it already greeted + asked for contact info
      const welcome = getWelcomeMessage(data);
      conversations.set(convId, {
        messages: [{ role: 'assistant', content: welcome }],
        intents: new Set(),
        leadRecordId: null,
      });
    }
    const conv = conversations.get(convId);
    conv.messages.push({ role: 'user', content: message });

    // Detect intents
    const intents = detectIntent(message);
    intents.forEach(i => conv.intents.add(i));

    // Generate reply
    let reply;
    if (DEMO_MODE) {
      reply = getDemoReply(message, data);
    } else {
      const messages = [
        { role: 'system', content: buildSystemPrompt(data) },
        ...conv.messages.slice(-20),
      ];
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
        max_tokens: 800,
      });
      reply = completion.choices[0].message.content;
    }

    // Extract contact info from AI reply (hidden JSON) or from user message (backup)
    const contactFromAI = extractContact(reply);
    const contactFromMsg = extractContactFromUserMessage(message);
    const contact = contactFromAI || contactFromMsg;
    const visibleReply = cleanReply(reply);

    conv.messages.push({ role: 'assistant', content: visibleReply });

    // Store contact on conversation object
    if (contact) {
      // Merge: keep existing values, add new ones
      const prev = conv.contact || {};
      conv.contact = {
        prenom: contact.prenom || prev.prenom || '',
        nom: contact.nom || prev.nom || '',
        email: contact.email || prev.email || '',
        telephone: contact.telephone || prev.telephone || '',
        ville: contact.ville || prev.ville || '',
      };
      console.log(`📋 Contact collecté (web): ${conv.contact.prenom} ${conv.contact.nom} — ${conv.contact.email || conv.contact.telephone || '?'} — ${conv.contact.ville || '?'}`);
    }

    // --- SYNC TO AIRTABLE (non-blocking) ---
    const userMsgCount = conv.messages.filter(m => m.role === 'user').length;
    const allIntents = Array.from(conv.intents);
    const leadScore = computeLeadScore(allIntents, userMsgCount);

    // Map intent names for Airtable
    const intentMap = {
      'price_inquiry': 'Prix',
      'project': 'Projet concret',
      'rdv_request': 'Demande RDV',
      'human_request': 'Demande humain',
      'aides': 'Aides financières',
    };
    const airtableIntents = allIntents.map(i => intentMap[i]).filter(Boolean);

    // Determine lead status
    let statut = 'En conversation';
    if (userMsgCount === 1) statut = 'Nouveau';
    if (allIntents.includes('rdv_request')) statut = 'Demande RDV';
    if (allIntents.includes('human_request')) statut = 'Demande RDV';

    // Save lead to Airtable
    (async () => {
      try {
        const now = new Date().toISOString();
        const contactFields = {};
        if (conv.contact) {
          if (conv.contact.prenom || conv.contact.nom)
            contactFields['Nom'] = `${conv.contact.prenom || ''} ${conv.contact.nom || ''}`.trim();
          if (conv.contact.email)
            contactFields['Email'] = conv.contact.email;
          if (conv.contact.telephone)
            contactFields['Téléphone'] = conv.contact.telephone;
          if (conv.contact.ville)
            contactFields['Ville'] = conv.contact.ville;
        }

        if (!conv.leadRecordId) {
          // Create lead
          const leadRes = await airtableCreate(AT_TABLES.leads, [{
            fields: {
              'ID Conversation': convId,
              'Date Premier Contact': now,
              'Dernier Message': now,
              'Nb Messages': userMsgCount,
              'Statut': statut,
              'Intentions Détectées': airtableIntents,
              'Score Lead': leadScore,
              'Source': 'Site web',
              ...contactFields,
            }
          }]);
          if (leadRes.records?.[0]?.id) {
            conv.leadRecordId = leadRes.records[0].id;
          }
        } else {
          // Update lead
          await airtableUpdate(AT_TABLES.leads, [{
            id: conv.leadRecordId,
            fields: {
              'Dernier Message': now,
              'Nb Messages': userMsgCount,
              'Statut': statut,
              'Intentions Détectées': airtableIntents,
              'Score Lead': leadScore,
              ...contactFields,
            }
          }]);
        }

        // Save conversation messages
        await airtableCreate(AT_TABLES.conversations, [
          {
            fields: {
              'ID Conversation': convId,
              'Horodatage': now,
              'Rôle': 'Client',
              'Message': message,
              'Intentions': intents.join(', '),
            }
          },
          {
            fields: {
              'ID Conversation': convId,
              'Horodatage': new Date(Date.now() + 1000).toISOString(),
              'Rôle': 'Agent IA',
              'Message': visibleReply.substring(0, 5000),
              'Intentions': '',
            }
          }
        ]);
      } catch (err) {
        console.error('⚠️  Erreur sync Airtable:', err.message);
      }
    })();

    // Track activity for auto-summary
    trackActivity(convId);

    res.json({
      reply: visibleReply,
      conversationId: convId,
      intent: intents,
    });

  } catch (error) {
    console.error('Erreur API:', error);
    res.status(500).json({
      error: 'Désolé, une erreur technique est survenue. Réessayez ou appelez-nous directement.',
    });
  }
});

// =============================================================
//  API INFO
// =============================================================
app.get('/api/info', async (req, res) => {
  const data = await loadDataFromAirtable();
  res.json({
    entreprise: data.entreprise,
    gammes: data.gammes.map(g => ({
      nom: g['Nom Gamme'],
      materiau: g['Matériau'],
      segment: g.Segment,
    })),
  });
});

// =============================================================
//  API SEND SUMMARY (manual or auto trigger)
// =============================================================
app.post('/api/summary/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conv = conversations.get(conversationId);

    if (!conv) return res.status(404).json({ error: 'Conversation non trouvée' });
    if (!conv.contact) return res.status(400).json({ error: 'Pas de coordonnées pour cette conversation' });
    if (summarySent.has(conversationId)) return res.json({ status: 'already_sent' });

    const data = await loadDataFromAirtable();
    const results = { whatsapp: false, email: false };

    if (conv.contact.telephone) {
      const summary = buildConversationSummary(conv, data);
      results.whatsapp = await sendSummaryWhatsApp(conv.contact.telephone, summary);
    }

    if (conv.contact.email) {
      const html = buildEmailHtml(conv, data);
      results.email = await sendSummaryEmail(conv.contact.email, html, data.entreprise?.Nom || 'Notre entreprise');
    }

    if (results.whatsapp || results.email) {
      summarySent.add(conversationId);
    }

    res.json({ status: 'sent', results });
  } catch (err) {
    console.error('❌ Erreur envoi résumé:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
//  AUTO-SEND SUMMARY (after 10 min of inactivity)
// =============================================================
const convLastActivity = new Map();

function trackActivity(convId) {
  convLastActivity.set(convId, Date.now());
}

// Check every 2 minutes for inactive conversations
setInterval(async () => {
  const INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();

  for (const [convId, lastActive] of convLastActivity.entries()) {
    if (now - lastActive < INACTIVITY_MS) continue;
    if (summarySent.has(convId)) continue;

    const conv = conversations.get(convId);
    if (!conv || !conv.contact) continue;

    // Only send if there were at least 3 messages (real conversation, not just a hello)
    const userMsgs = conv.messages.filter(m => m.role === 'user').length;
    if (userMsgs < 2) continue;

    // Must have at least an email or phone
    if (!conv.contact.email && !conv.contact.telephone) continue;

    console.log(`⏰ Auto-envoi résumé pour ${convId} (inactif depuis ${Math.round((now - lastActive) / 60000)} min)`);

    try {
      const data = await loadDataFromAirtable();

      if (conv.contact.telephone) {
        const summary = buildConversationSummary(conv, data);
        await sendSummaryWhatsApp(conv.contact.telephone, summary);
      }

      if (conv.contact.email) {
        const html = buildEmailHtml(conv, data);
        await sendSummaryEmail(conv.contact.email, html, data.entreprise?.Nom || 'Notre entreprise');
      }

      summarySent.add(convId);
    } catch (err) {
      console.error(`❌ Auto-envoi résumé échoué pour ${convId}:`, err.message);
    }
  }
}, 2 * 60 * 1000); // Check toutes les 2 minutes

// =============================================================
//  API STATS
// =============================================================
app.get('/api/stats', async (req, res) => {
  try {
    const leadsRes = await airtableFetch(AT_TABLES.leads, '?fields%5B%5D=Statut&fields%5B%5D=Score+Lead');
    const leads = leadsRes.records || [];
    
    const stats = {
      total_leads: leads.length,
      conversations_actives: conversations.size,
      par_statut: {},
      leads_chauds: leads.filter(l => (l.fields['Score Lead'] || 0) >= 4).length,
    };

    leads.forEach(l => {
      const s = l.fields.Statut || 'Inconnu';
      stats.par_statut[s] = (stats.par_statut[s] || 0) + 1;
    });

    res.json(stats);
  } catch (err) {
    res.json({ conversations_actives: conversations.size, error: err.message });
  }
});

// =============================================================
//  WHATSAPP WEBHOOK (Twilio)
// =============================================================
app.post('/api/whatsapp', async (req, res) => {
  try {
    const incomingMsg = req.body.Body?.trim();
    const from = req.body.From; // "whatsapp:+33612345678"
    const profileName = req.body.ProfileName || '';

    if (!incomingMsg || !from) {
      return res.status(400).send('<Response></Response>');
    }

    console.log(`📱 WhatsApp de ${profileName} (${from}): ${incomingMsg}`);

    // Load data from Airtable
    const data = await loadDataFromAirtable();

    // Use phone number as conversation ID for WhatsApp
    const convId = `wa_${from.replace(/[^0-9]/g, '')}`;
    if (!conversations.has(convId)) {
      const welcome = getWelcomeMessage(data);
      conversations.set(convId, {
        messages: [{ role: 'assistant', content: welcome }],
        intents: new Set(),
        leadRecordId: null,
      });
    }
    const conv = conversations.get(convId);
    conv.messages.push({ role: 'user', content: incomingMsg });

    // Detect intents
    const intents = detectIntent(incomingMsg);
    intents.forEach(i => conv.intents.add(i));

    // Generate reply
    let reply;
    if (DEMO_MODE) {
      reply = getDemoReply(incomingMsg, data);
    } else {
      const messages = [
        { role: 'system', content: buildSystemPrompt(data) + '\n\n## CONTEXTE : Ce client écrit via WhatsApp. Sois concis (max 3 paragraphes). Pas de markdown complexe (pas de tableaux). Utilise des emojis naturellement.' },
        ...conv.messages.slice(-20),
      ];
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
        max_tokens: 500,
      });
      reply = completion.choices[0].message.content;
    }

    conv.messages.push({ role: 'assistant', content: reply });

    // Extract contact info
    const contactFromAI = extractContact(reply);
    const contactFromMsg = extractContactFromUserMessage(incomingMsg);
    const contact = contactFromAI || contactFromMsg;
    const visibleReply = cleanReply(reply);

    // Overwrite last assistant message with cleaned version
    conv.messages[conv.messages.length - 1].content = visibleReply;

    if (contact) {
      const prev = conv.contact || {};
      conv.contact = {
        prenom: contact.prenom || prev.prenom || '',
        nom: contact.nom || prev.nom || '',
        email: contact.email || prev.email || '',
        telephone: contact.telephone || prev.telephone || '',
        ville: contact.ville || prev.ville || '',
      };
      console.log(`📋 Contact collecté (WhatsApp): ${conv.contact.prenom} ${conv.contact.nom}`);
    }

    // Clean markdown for WhatsApp (bold only, no ## headers)
    const waReply = visibleReply
      .replace(/#{1,6}\s/g, '')          // Remove markdown headers
      .replace(/\*\*(.*?)\*\*/g, '*$1*') // **bold** → *bold* (WhatsApp style)
      .substring(0, 1600);               // WhatsApp message limit

    // --- SYNC TO AIRTABLE (non-blocking) ---
    const userMsgCount = conv.messages.filter(m => m.role === 'user').length;
    const allIntents = Array.from(conv.intents);
    const leadScore = computeLeadScore(allIntents, userMsgCount);

    const intentMap = {
      'price_inquiry': 'Prix',
      'project': 'Projet concret',
      'rdv_request': 'Demande RDV',
      'human_request': 'Demande humain',
      'aides': 'Aides financières',
    };
    const airtableIntents = allIntents.map(i => intentMap[i]).filter(Boolean);

    let statut = 'En conversation';
    if (userMsgCount === 1) statut = 'Nouveau';
    if (allIntents.includes('rdv_request')) statut = 'Demande RDV';
    if (allIntents.includes('human_request')) statut = 'Demande RDV';

    (async () => {
      try {
        const now = new Date().toISOString();
        const phoneClean = from.replace('whatsapp:', '');

        const contactFields = { 'Téléphone': phoneClean };
        if (profileName) contactFields['Nom'] = profileName;
        // Merge with AI-extracted contact if available
        if (conv.contact) {
          if (conv.contact.prenom || conv.contact.nom)
            contactFields['Nom'] = `${conv.contact.prenom || ''} ${conv.contact.nom || ''}`.trim();
          if (conv.contact.email)
            contactFields['Email'] = conv.contact.email;
          if (conv.contact.ville)
            contactFields['Ville'] = conv.contact.ville;
        }

        if (!conv.leadRecordId) {
          const leadRes = await airtableCreate(AT_TABLES.leads, [{
            fields: {
              'ID Conversation': convId,
              'Date Premier Contact': now,
              'Dernier Message': now,
              'Nb Messages': userMsgCount,
              'Statut': statut,
              'Intentions Détectées': airtableIntents,
              'Score Lead': leadScore,
              'Source': 'WhatsApp',
              ...contactFields,
            }
          }]);
          if (leadRes.records?.[0]?.id) {
            conv.leadRecordId = leadRes.records[0].id;
          }
        } else {
          await airtableUpdate(AT_TABLES.leads, [{
            id: conv.leadRecordId,
            fields: {
              'Dernier Message': now,
              'Nb Messages': userMsgCount,
              'Statut': statut,
              'Intentions Détectées': airtableIntents,
              'Score Lead': leadScore,
              ...contactFields,
            }
          }]);
        }

        await airtableCreate(AT_TABLES.conversations, [
          {
            fields: {
              'ID Conversation': convId,
              'Horodatage': now,
              'Rôle': 'Client (WhatsApp)',
              'Message': incomingMsg,
              'Intentions': intents.join(', '),
            }
          },
          {
            fields: {
              'ID Conversation': convId,
              'Horodatage': new Date(Date.now() + 1000).toISOString(),
              'Rôle': 'Agent IA',
              'Message': visibleReply.substring(0, 5000),
              'Intentions': '',
            }
          }
        ]);
      } catch (err) {
        console.error('⚠️  Erreur sync Airtable (WhatsApp):', err.message);
      }
    })();

    // Track activity for auto-summary
    trackActivity(convId);

    // Respond via Twilio TwiML
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(waReply);
    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('❌ Erreur WhatsApp:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Désolé, j'ai un petit souci technique. Réessayez dans quelques instants ! 🙏");
    res.type('text/xml').send(twiml.toString());
  }
});

// =============================================================
//  START
// =============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🪟  Agent Fenêtres démarré sur http://localhost:${PORT}`);
  console.log(`📊 Stats: http://localhost:${PORT}/api/stats`);
  console.log(`🗄️  Airtable: base ${AT_BASE}\n`);
  
  // Pre-load data
  try {
    await loadDataFromAirtable();
  } catch (err) {
    console.error('⚠️  Erreur chargement initial Airtable:', err.message);
  }
});
