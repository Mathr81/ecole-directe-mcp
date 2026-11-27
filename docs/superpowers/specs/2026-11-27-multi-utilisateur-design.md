# Multi-utilisateur : chacun branche son IA à son propre compte École Directe

Date : 2026-11-27 — statut : en attente de validation

## Intention

Aujourd'hui le serveur sert **un seul** compte École Directe (celui du propriétaire, Mathéo).
On veut que d'autres personnes puissent ajouter l'URL du serveur comme connecteur dans leur IA
(Claude.ai d'abord, tout client MCP avec OAuth ensuite) et accéder à **leurs** données, et à elles seules.

Première phase : des proches et des potes, **élèves**, sur demande validée par le propriétaire.
Plus tard : ouverture plus large et comptes **parents** (plusieurs enfants par compte). Ces deux suites
ne sont pas construites maintenant, mais rien ne doit les rendre difficiles.

## Objectifs

- Un pote se connecte au serveur avec son identifiant et son mot de passe École Directe, plus le QCM si
  demandé, **dans le navigateur**, pendant le parcours OAuth lancé par son IA.
- Sa première connexion réussie crée une **demande en attente**. Le propriétaire est prévenu et valide
  ou refuse depuis une page d'admin. Une fois la demande validée, le pote relance la connexion et accède à ses données.
- Chaque requête MCP n'a accès qu'à la session du compte auquel son jeton OAuth est rattaché.
- Le propriétaire continue de marcher sans rien refaire : connecteur Claude.ai existant, jeton fixe
  sur le tailnet, `/health`, mode stdio.

## Non-objectifs (pour cette version)

- Comptes parents et choix d'un enfant. Les données restent quand même stockées de façon à le permettre (voir « Préparer les parents »).
- Suppression de compte en libre-service par l'utilisateur. Le propriétaire révoque depuis l'admin.
- Écriture (`mark_homework_done`) : la lecture seule reste imposée en HTTP.
- Stockage SQLite, plusieurs conteneurs, plusieurs serveurs.

## Anti-objectifs (échec même si « ça marche »)

- Le mot de passe École Directe est écrit quelque part (disque, logs, erreurs). Il ne sert qu'à la connexion, en mémoire.
- Une requête lit les données d'un autre utilisateur, ou un compte en attente ou refusé lit quoi que ce soit.
- Le serveur rafraîchit en tâche de fond les sessions de tous les utilisateurs. Tout le trafic part d'une
  seule IP et École Directe pourrait la bloquer. Seul l'usage réel déclenche des appels.
- Le formulaire de connexion devient un moyen de tester des mots de passe École Directe en masse.
- Le connecteur du propriétaire casse lors de la mise à jour.

## Contraintes

- Node 22, Express 5, SDK MCP 1.30.0, zod : **aucune nouvelle dépendance**.
- Déploiement actuel : `docker-compose.yml` + `docker-compose.npm-and-tailnet.yml`, volume `/data`,
  derrière Nginx Proxy Manager (`trust proxy` = 1 saut, à garder).
- École Directe lie l'exemption de QCM au `deviceUUID` et le jeton au User-Agent (`edAuth.ts`).

## Approches envisagées

1. **Retenue : faire évoluer le serveur actuel, un fichier chiffré par utilisateur.** On réutilise
   `store/atomicJson.ts`. Un seul conteneur, aucune dépendance, le diff le plus court, et ça tient
   pour des dizaines ou des centaines d'utilisateurs. Passer à SQLite plus tard ne touchera que le magasin d'utilisateurs.
2. Même chose avec `node:sqlite`. Plus solide à grande échelle, mais plus de code tout de suite, et le
   module est encore expérimental selon la version de Node 22. Écartée pour la phase « proches ».
3. Un conteneur par utilisateur derrière une passerelle. Il faudrait le socket Docker (risque majeur),
   c'est lourd et démesuré. Écartée.

Choix fait par Claude, le propriétaire ayant délégué le « comment ».

## Ce qui a été décidé avec le propriétaire

- Accès par **inscription libre puis validation** par le propriétaire (pas de code d'invitation, pas de liste d'identifiants).
- Notification par **webhook facultatif** (`NOTIFY_WEBHOOK_URL`). Il marche avec Discord ou n8n, qui
  peut ensuite relayer par mail, Telegram, etc. Sans webhook, les demandes restent visibles dans l'admin.
- Validation depuis une **page d'admin web**, utilisable sur téléphone.
- Élèves seulement pour l'instant, parents plus tard.

## Conception

### Modes

- **stdio** : inchangé, mono-compte, `session.json`.
- **HTTP sans OAuth** (tailnet seul, jeton fixe) : inchangé, mono-compte.
- **HTTP avec OAuth** (`MCP_PUBLIC_URL` + `MCP_OAUTH_PASSPHRASE`) : devient **multi-utilisateur**.
  Il exige `SESSION_ENCRYPTION_KEY`, sinon le serveur refuse de démarrer. L'ancien écran
  « phrase secrète » disparaît : la phrase secrète sert désormais uniquement à la page d'admin.

### Magasin d'utilisateurs (`src/store/userStore.ts`)

- Un fichier par utilisateur : `/data/users/<userId>.json`, contenu **entièrement chiffré** en
  AES-256-GCM (IV aléatoire par écriture), écrit avec `writeJsonAtomic`, permissions 0600.
- `userId = HMAC-SHA256(clé dérivée, identifiant ED normalisé en minuscules)`, en hexadécimal. Retrouver
  un utilisateur à partir de son identifiant ne demande aucun index, et les noms de fichiers ne révèlent pas les identifiants.
- `SESSION_ENCRYPTION_KEY` : 32 octets en hexadécimal (`openssl rand -hex 32`). On en dérive deux clés
  (HKDF) : une pour chiffrer, une pour les `userId` et le cookie d'admin. Limite assumée : la clé est
  dans `.env` sur le même hôte. Elle protège contre une fuite du volume ou d'une sauvegarde, pas contre une compromission de l'hôte.
- Enregistrement :
  `{ userId, username, displayName, status: 'pending'|'approved', isOwner, createdAt, approvedAt?, deviceUUID, session: Session|null }`.
- La liste des utilisateurs pour l'admin lit le dossier et déchiffre chaque fichier, ce qui suffit à cette échelle.
- Purge : un compte `pending` vieux de plus de 7 jours est supprimé au démarrage et à chaque ouverture de l'admin.
- **Refus** ou **révocation** : on supprime le fichier, les jetons OAuth de l'utilisateur et son dossier de téléchargements.

### Préparer les parents

On garde `Session.accounts` complet, comme aujourd'hui, et un utilisateur est identifié par son
**identifiant ED** (jamais par `accountId`). Plus tard, un compte famille ajoutera un enfant sélectionné
dans la session et un paramètre facultatif aux outils, sans migration du magasin.

### Connexion (remplace `consentPage.ts` et `handleConsent`)

1. `authorize()` enregistre la demande OAuth en attente (comme aujourd'hui) et affiche une page avec
   identifiant + mot de passe ED et une courte notice de confidentialité. La notice dit que la session
   ED est stockée chiffrée, jamais le mot de passe, que les données passent par l'IA choisie par
   l'utilisateur, que le propriétaire du serveur gère les accès et qu'il suffit de lui demander pour être supprimé.
2. POST : `client.login()` avec le `deviceUUID` de l'utilisateur s'il existe, sinon un nouveau.
   Si École Directe demande le QCM, une deuxième page affiche la question et les propositions (boutons radio),
   et le défi reste en mémoire côté serveur, rattaché à la demande en attente. On réutilise la logique de `cli/login.ts`.
3. Si la connexion ED réussit, selon la situation :
   - l'utilisateur est nouveau : on le crée en `pending`, on envoie le webhook et on affiche « Demande envoyée, reviens
     te connecter une fois validée ». **Pas de redirection** vers l'IA.
   - il est déjà `pending` : on met à jour sa session et on affiche « Toujours en attente ».
   - il est `approved` : on met à jour sa session et on émet le code OAuth **rattaché à `userId`**, puis on redirige.
4. Le mot de passe n'est ni écrit sur disque ni journalisé. `completeTwoFactor` en a besoin une seconde
   fois, donc entre la page de connexion et la page QCM il reste **en mémoire seulement**, dans la demande
   en attente (10 min maximum), puis il est effacé dès la fin du QCM. *(Choix de Claude.)*
5. **Élèves seulement, imposé dans le code** : si le compte renvoyé n'est pas de type `E`, on refuse avant
   de créer la demande, sans webhook et sans compter dans le plafond, avec le message « Seuls les comptes
   élèves sont pris en charge pour l'instant ». Ça évite qu'un parent validé reçoive les données d'un seul
   enfant ou des appels cassés. Le type de compte s'affiche aussi dans l'admin. *(Choix de Claude.)*

### Limites anti-abus

- Petit limiteur en mémoire (une `Map`, sans dépendance) sur le POST de connexion et celui de l'admin :
  5 échecs par identifiant et par 15 min, 20 tentatives par IP et par heure. Au-delà, on répond « Trop de tentatives, réessaie plus tard »
  **sans appeler École Directe**, ce qui protège aussi les comptes des potes contre un verrouillage par École Directe.
- Le nombre de tentatives par demande en attente (`MAX_PASSPHRASE_ATTEMPTS`) devient le nombre de tentatives de connexion par demande.
- Clients OAuth (DCR) : on purge ceux de plus de 24 h qui n'ont aucun jeton vivant. Le fichier ne grossit plus sans fin.
- Plafond de comptes `pending` simultanés (20) : au-delà, on refuse les nouvelles demandes. Ça limite le spam d'inscriptions.

### Jetons OAuth (`oauth/store.ts`, `oauth/provider.ts`)

- `StoredCode` et `StoredToken` reçoivent `userId`. `verifyAccessToken` le renvoie dans `AuthInfo.extra.userId`.
- Les jetons existants sans `userId` (émis avant la migration, donc au propriétaire) sont traités comme ceux du propriétaire.
- On ajoute `revokeUser(userId)`, qui supprime tous les jetons d'accès et de rafraîchissement de l'utilisateur.

### Requête MCP (`transport/http.ts`)

- On résout l'utilisateur à partir de `req.auth.extra.userId`. Le jeton fixe `MCP_AUTH_TOKEN` correspond au propriétaire.
- S'il est absent, refusé ou `pending`, on répond 401 : l'IA relance l'autorisation, et la page dira « en attente » si c'est le cas.
- Pour chaque utilisateur, on garde un **environnement d'exécution** en mémoire
  (`Map<userId, { sessionBox, client }>`). `sessionBox` est branché sur le magasin d'utilisateurs, et
  `client = createClient(base, sessionBox)`. Chaque utilisateur a ainsi sa propre file d'attente, son
  cache et son rafraîchissement unique en vol. Le `ToolContext` est construit par requête avec ces deux
  éléments, et **les outils ne changent pas**, puisqu'ils passent déjà par `context.sessionBox` et `context.client`.
- Rafraîchissement : reste paresseux, sur appel seulement (`withAutoRefresh` existant). Si une session ne peut pas
  être récupérée (`AuthenticationRequiredError`), on révoque les jetons OAuth de l'utilisateur et l'outil
  répond « Ta session École Directe a expiré : reconnecte le connecteur dans ton IA ». L'appel suivant prendra un 401 et déclenchera une nouvelle autorisation.
- Les messages de `runTool` et `get_auth_status` qui disent « lance `ecoledirecte-mcp login` » sont adaptés en
  mode multi-utilisateur (« reconnecte le connecteur »).

### Téléchargements

- Un dossier par utilisateur : `downloadDir/<userId>/`.
- À chaque téléchargement, on supprime les fichiers de ce dossier plus vieux que la durée de validité des liens (1 h).

### Admin (`/admin`)

- Connexion par `MCP_OAUTH_PASSPHRASE`, puis cookie signé en HMAC (12 h, `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/admin`). Toutes les actions passent par des POST. `SameSite=Strict` suffit contre le CSRF.
- La page liste les utilisateurs (nom affiché, statut, date de demande, dernier rafraîchissement de session) avec
  les boutons Valider / Refuser / Révoquer. Le propriétaire ne peut pas se révoquer lui-même.
- La page est autonome, sans CDN, dans le même style que l'actuelle `consentPage.ts`, et lisible sur mobile.

### Notification

- Si `NOTIFY_WEBHOOK_URL` est défini, on fait un POST JSON
  `{ "content": "<Nom> demande l'accès à École Directe MCP : <url>/admin" }` (format compris par Discord, et n8n accepte tout).
- Pas d'identifiant ED ni de donnée scolaire dans la notification. Un échec est journalisé sans bloquer la demande.

### Migration du propriétaire

- Au démarrage en mode multi-utilisateur, s'il n'existe aucun utilisateur `isOwner` et que `session.json` est
  présent, on importe cette session et le `device-id` comme propriétaire `approved`.
- **La source de vérité est le fichier utilisateur chiffré.** Pour que le retour en arrière et la commande
  `ecoledirecte-mcp login` restent valables, deux règles s'ajoutent. *(Choix de Claude.)*
  - Le `sessionBox` du propriétaire écrit aussi `session.json` à chaque mise à jour (miroir), pour que le
    fichier ne devienne jamais périmé.
  - Au démarrage, si `session.json` est plus récent (`updatedAt`) que la session du propriétaire, on le
    réimporte. Un `docker compose run … login` suivi d'un redémarrage répare donc le propriétaire, comme
    aujourd'hui.
- Autre moyen de réparer, valable pour **tout** utilisateur validé, propriétaire compris : reconnecter le
  connecteur depuis son IA. La connexion École Directe dans le navigateur renouvelle la session.
- **Nouvelle installation sans `session.json`** : la variable facultative `OWNER_ED_USERNAME` désigne le
  propriétaire. Le premier login web avec cet identifiant crée le propriétaire déjà validé. Sans cette
  variable ni `session.json`, personne n'est validé automatiquement : le serveur démarre, mais l'admin
  affiche « aucun propriétaire » et le jeton fixe est refusé. Il n'y a jamais de règle « le premier inscrit
  devient propriétaire ». *(Choix de Claude.)*
- `/health` vérifie la session du **propriétaire** seulement, comme aujourd'hui (alertes Docker / Uptime Kuma inchangées).

### Configuration

- Nouveau : `SESSION_ENCRYPTION_KEY` (obligatoire avec OAuth), `NOTIFY_WEBHOOK_URL` et `OWNER_ED_USERNAME` (facultatifs).
- Sens changé : `MCP_OAUTH_PASSPHRASE` devient la phrase secrète de l'admin.
- `.env.example`, `docker-compose.yml` et le README sont mis à jour.

### Tests

- Isolation : le jeton de A ne lit jamais les données de B ; un compte `pending` reçoit un 401 ; après une révocation, on reçoit un 401.
- Parcours de connexion : connexion simple, QCM, mauvais mot de passe, limiteur déclenché sans appel à École Directe.
- Magasin : chiffrement et déchiffrement aller-retour, fichier illisible sans la clé, purge des `pending`, `userId` stable.
- Migration du propriétaire, miroir vers `session.json`, réimport d'un `session.json` plus récent, et anciens jetons sans `userId` rattachés au propriétaire.
- Un compte non élève est refusé avant la création de la demande.
- Admin : accès sans cookie refusé, validation, refus, révocation (fichier, jetons et téléchargements supprimés).
- On s'appuie sur `FakeEcoleDirecteClient` et les tests de transport existants (`test/transport/oauth.test.ts`).

## Laissé au builder

- Le découpage exact des fichiers, les noms internes et le gabarit HTML des pages (connexion, QCM, attente, admin).
- Le format exact des clés du limiteur et son nettoyage.
- Comment le défi QCM est rattaché à la demande OAuth en attente.
