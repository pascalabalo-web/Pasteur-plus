# Prophetic Step Ministry — version prête à héberger

Cette version transforme le projet en véritable application web :

- 150 thèmes bibliques locaux ;
- thème personnalisé par IA même s'il n'existe pas dans les 150 ;
- génération IA côté serveur ;
- compte pasteur avec inscription / connexion ;
- mot de passe chiffré par `scrypt` ;
- session sécurisée par cookie HTTP-only ;
- thèmes IA enregistrés dans PostgreSQL et liés au compte ;
- accès aux thèmes depuis plusieurs appareils ;
- suppression des thèmes enregistrés ;
- endpoint `/api/health` pour l'hébergement ;
- Dockerfile et Docker Compose inclus.

## 1. Variables d'environnement

Copier `.env.example` en `.env` et renseigner :

- `DATABASE_URL` : URL de la base PostgreSQL ;
- `OPENAI_API_KEY` : clé API OpenAI ;
- `OPENAI_MODEL` : par défaut `gpt-5.6-luna` ;
- `DATABASE_SSL=true` pour une base hébergée avec SSL ; `false` pour le PostgreSQL local Docker.

La clé OpenAI doit rester uniquement côté serveur. Elle ne doit jamais être placée dans `js/` ou dans le navigateur.

## 2. Test local avec Docker

1. Installer Docker Desktop.
2. Créer `.env` avec au minimum :

```env
OPENAI_API_KEY=sk-...
```

3. Lancer :

```bash
docker compose up --build
```

4. Ouvrir :

`http://localhost:3000`

La base PostgreSQL est créée automatiquement et les tables sont initialisées au démarrage.

## 3. Hébergement

Le projet peut être déployé sur un hébergeur capable d'exécuter Node.js/Docker et de fournir PostgreSQL.

Variables à configurer sur l'hébergeur :

```text
NODE_ENV=production
DATABASE_URL=...
DATABASE_SSL=true
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
SESSION_DAYS=30
```

Commande de démarrage :

```bash
npm start
```

Port : utiliser la variable `PORT` fournie par l'hébergeur.

Health check :

```text
GET /api/health
```

## 4. Fonctionnement IA

Le pasteur saisit un thème libre. Le navigateur appelle `/api/theme-ai`. Le serveur authentifie le pasteur, appelle l'API OpenAI, valide la réponse structurée et enregistre immédiatement l'étude dans PostgreSQL.

## 5. Sécurité

- La clé OpenAI n'est jamais envoyée au navigateur.
- Les mots de passe ne sont jamais stockés en clair.
- Les sessions utilisent des tokens HTTP-only.
- Chaque thème IA est lié au compte du pasteur connecté.
- Un pasteur ne peut pas lire ou supprimer les thèmes d'un autre compte.

## 6. Important

Les études générées par IA doivent être relues et vérifiées par le pasteur avant une prédication, notamment les références et formulations bibliques.
