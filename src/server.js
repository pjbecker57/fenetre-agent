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

let twilioClient = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = new twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log('📱 Twilio WhatsApp activé');
} else {
  console.log('⚠️  Twilio non configuré — WhatsApp désactivé');
}

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
    .replace(/\{\{entreprise_tel\}\}/g, entreprise['Téléphone'] || '');

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
      conversations.set(convId, { messages: [], intents: new Set(), leadRecordId: null });
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

    conv.messages.push({ role: 'assistant', content: reply });

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
              'Message': reply.substring(0, 5000), // Airtable text limit
              'Intentions': '',
            }
          }
        ]);
      } catch (err) {
        console.error('⚠️  Erreur sync Airtable:', err.message);
      }
    })();

    res.json({
      reply,
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
      conversations.set(convId, { messages: [], intents: new Set(), leadRecordId: null });
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

    // Clean markdown for WhatsApp (bold only, no ## headers)
    const waReply = reply
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
              'Téléphone': phoneClean,
              'Nom': profileName,
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
              'Message': reply.substring(0, 5000),
              'Intentions': '',
            }
          }
        ]);
      } catch (err) {
        console.error('⚠️  Erreur sync Airtable (WhatsApp):', err.message);
      }
    })();

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
