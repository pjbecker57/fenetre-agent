# 🪟 Agent IA — Menuiseries Dupont (Prototype)

> Assistant commercial IA pour vendeurs de fenêtres.

## Démarrage rapide

### 1. Installer les dépendances
```bash
cd fenetre-agent
npm install
```

### 2. Configurer la clé API
```bash
cp .env.example .env
# Édite .env et mets ta clé OpenAI
```

### 3. Lancer
```bash
npm run dev
```

→ Ouvre http://localhost:3000

## Structure

```
fenetre-agent/
├── public/
│   └── index.html          # Interface chat (widget)
├── src/
│   ├── server.js           # Serveur Express + API
│   └── data/
│       ├── catalogue.json  # Catalogue produits (configurable par client)
│       └── system-prompt.md # Prompt système (le cerveau de l'agent)
├── package.json
└── .env.example
```

## Comment ça marche

1. L'utilisateur pose une question dans le chat
2. Le serveur envoie la question + le catalogue + l'historique à l'API OpenAI
3. L'IA répond en s'appuyant sur les données réelles du catalogue
4. Le système détecte les intentions (prix, RDV, projet concret)
5. Au bon moment, l'agent propose un RDV / contact commercial

## Pour adapter à un autre menuisier

1. Modifier `src/data/catalogue.json` avec ses produits/prix
2. Le prompt s'adapte automatiquement (variables {{entreprise_nom}}, etc.)
3. C'est tout !

## Prochaines étapes (V2)

- [ ] Dashboard commercial (leads, conversations, intents)
- [ ] Widget embeddable (iframe / web component)
- [ ] Intégration WhatsApp / SMS
- [ ] Upload de devis PDF
- [ ] Multi-tenants (plusieurs clients menuisiers)
