// =============================================================
//  PRO HANDLER — Module artisan (vocaux, comptes-rendus, relances)
// =============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');

// =============================================================
//  TRANSCRIPTION (OpenAI Whisper)
// =============================================================
async function transcribeAudio(audioUrl, twilioSid, twilioToken, openai) {
  // 1. Télécharger l'audio depuis Twilio (authentification requise)
  const response = await fetch(audioUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
    },
  });

  if (!response.ok) {
    throw new Error(`Erreur téléchargement audio: ${response.status}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // 2. Sauvegarder temporairement
  const tmpFile = path.join(os.tmpdir(), `vocal_${Date.now()}.ogg`);
  fs.writeFileSync(tmpFile, audioBuffer);

  try {
    // 3. Transcrire avec Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1',
      language: 'fr',
      response_format: 'text',
    });

    return transcription.trim();
  } finally {
    // Nettoyer le fichier temp
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

// =============================================================
//  ANALYSE DU COMPTE-RENDU (GPT-4o-mini)
// =============================================================
const ANALYSIS_PROMPT = `Tu es un assistant pour artisans menuisiers. Tu reçois la transcription d'un message vocal d'un artisan après une visite chez un client.

Analyse la transcription et extrais les informations suivantes au format JSON :

{
  "client": {
    "nom": "Nom du client mentionné (ou vide)",
    "ville": "Ville mentionnée (ou vide)",
    "telephone": "Numéro mentionné (ou vide)",
    "email": "Email mentionné (ou vide)"
  },
  "visite": {
    "type_travaux": "Description courte des travaux",
    "nb_fenetres": 0,
    "pieces": ["liste des pièces mentionnées"],
    "materiau": "PVC/Alu/Bois ou vide",
    "gamme": "Si mentionnée",
    "coloris": "Si mentionné",
    "etat_dormants": "Bon/Mauvais/À vérifier ou vide",
    "mesures": "Mesures mentionnées ou vide",
    "remarques": "Autres constats importants"
  },
  "commercial": {
    "budget_client": "Budget mentionné ou vide",
    "deadline_devis": "Date limite pour le devis (format YYYY-MM-DD si possible, sinon texte)",
    "jours_avant_relance": 7,
    "actions_a_faire": ["liste des actions à faire"],
    "niveau_interet": "Chaud/Tiède/Froid"
  },
  "resume": "Résumé concis en 2-3 phrases pour affichage rapide"
}

Règles :
- Si une info n'est pas mentionnée, laisse le champ vide ""
- Pour la deadline, essaie de convertir les expressions relatives ("vendredi prochain", "avant la fin de la semaine") en dates si possible
- Le résumé doit être court et actionnable
- jours_avant_relance : par défaut 7 jours, sauf si l'artisan mentionne autre chose
- Aujourd'hui nous sommes le {DATE}`;

async function analyzeVisitReport(transcription, openai) {
  const today = new Date().toISOString().split('T')[0];
  const prompt = ANALYSIS_PROMPT.replace('{DATE}', today);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: transcription },
    ],
    temperature: 0.3,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0].message.content;
  return JSON.parse(content);
}

// =============================================================
//  FORMAT RÉPONSE POUR L'ARTISAN
// =============================================================
function formatVisitResponse(analysis) {
  const c = analysis.client;
  const v = analysis.visite;
  const com = analysis.commercial;

  let msg = `✅ *Compte-rendu enregistré !*\n\n`;

  if (c.nom || c.ville) {
    msg += `👤 Client : ${c.nom || '?'}`;
    if (c.ville) msg += ` — ${c.ville}`;
    msg += `\n`;
  }

  if (v.type_travaux) {
    msg += `🪟 ${v.type_travaux}`;
    if (v.nb_fenetres) msg += ` (${v.nb_fenetres} fenêtres)`;
    msg += `\n`;
  }

  if (v.pieces?.length) {
    msg += `🏠 Pièces : ${v.pieces.join(', ')}\n`;
  }

  if (v.materiau || v.gamme) {
    msg += `📦 `;
    if (v.materiau) msg += v.materiau;
    if (v.gamme) msg += ` — ${v.gamme}`;
    if (v.coloris) msg += ` (${v.coloris})`;
    msg += `\n`;
  }

  if (v.etat_dormants) {
    msg += `📐 Dormants : ${v.etat_dormants}\n`;
  }

  if (v.remarques) {
    msg += `📝 ${v.remarques}\n`;
  }

  if (com.budget_client) {
    msg += `💶 Budget : ${com.budget_client}\n`;
  }

  if (com.deadline_devis) {
    msg += `📅 Deadline devis : ${com.deadline_devis}\n`;
  }

  msg += `\n`;

  if (com.actions_a_faire?.length) {
    msg += `*À faire :*\n`;
    com.actions_a_faire.forEach(a => {
      msg += `• ${a}\n`;
    });
    msg += `\n`;
  }

  if (com.deadline_devis) {
    msg += `⏰ Rappel programmé avant la deadline.\n`;
  }

  msg += `📨 Relance auto dans ${com.jours_avant_relance || 7} jours si pas de retour client.`;

  return msg;
}

// =============================================================
//  SAVE TO AIRTABLE (table Leads enrichie)
// =============================================================
async function saveVisitReport(analysis, transcription, artisanPhone, airtableCreate, airtableUpdate, airtableFetch, tables) {
  const c = analysis.client;
  const v = analysis.visite;
  const com = analysis.commercial;
  const now = new Date().toISOString();
  const convId = `pro_${artisanPhone.replace(/[^0-9]/g, '')}_${Date.now()}`;

  // Créer le lead avec les infos de la visite
  const fields = {
    'ID Conversation': convId,
    'Date Premier Contact': now,
    'Dernier Message': now,
    'Nb Messages': 1,
    'Statut': com.deadline_devis ? 'Devis en cours' : 'Visite effectuée',
    'Source': 'Vocal artisan',
    'Score Lead': com.niveau_interet === 'Chaud' ? 5 : com.niveau_interet === 'Tiède' ? 3 : 2,
  };

  if (c.nom) fields['Nom'] = c.nom;
  if (c.ville) fields['Ville'] = c.ville;
  if (c.telephone) fields['Téléphone'] = c.telephone;
  if (c.email) fields['Email'] = c.email;

  try {
    const leadRes = await airtableCreate(tables.leads, [{ fields }]);

    // Sauvegarder la transcription dans les conversations
    await airtableCreate(tables.conversations, [
      {
        fields: {
          'ID Conversation': convId,
          'Horodatage': now,
          'Rôle': 'Artisan (vocal)',
          'Message': transcription,
          'Intentions': `Visite: ${v.type_travaux || ''}`,
        },
      },
      {
        fields: {
          'ID Conversation': convId,
          'Horodatage': new Date(Date.now() + 1000).toISOString(),
          'Rôle': 'Analyse IA',
          'Message': JSON.stringify(analysis, null, 2).substring(0, 5000),
          'Intentions': '',
        },
      },
    ]);

    return { convId, leadId: leadRes.records?.[0]?.id };
  } catch (err) {
    console.error('⚠️ Erreur sauvegarde visite Airtable:', err.message);
    return { convId, error: err.message };
  }
}

module.exports = {
  transcribeAudio,
  analyzeVisitReport,
  formatVisitResponse,
  saveVisitReport,
};
