# ecoledirecte-mcp

Serveur MCP personnel pour École Directe : notes, devoirs, emploi du temps,
vie scolaire, vie de classe, fil d'actualité, téléchargement de documents.

## Installation locale (stdio)

    npm install
    npm run build
    node dist/cli/index.js login

`login` demande l'identifiant et le mot de passe École Directe, puis, à la
première connexion depuis cette machine, une question de sécurité (QCM) —
c'est obligatoire côté École Directe, il n'y a pas de contournement.

La session est enregistrée dans `~/.config/ecoledirecte-mcp/session.json`
(permissions 600) et rafraîchie automatiquement ensuite.

## Utilisation avec Claude Code

    claude mcp add ecoledirecte -- node /chemin/absolu/vers/dist/cli/index.js serve

Le serveur démarre même sans session valide : `get_auth_status` sert
justement à diagnostiquer ce cas, et les autres outils renvoient une erreur
explicite au lieu de faire tomber le serveur.

## Outils exposés

| Outil | Rôle |
| --- | --- |
| `get_auth_status` | État de la session (présence, date du dernier rafraîchissement) |
| `get_grades` | Notes de l'année scolaire |
| `get_homework` | Devoirs entre deux dates |
| `mark_homework_done` | Marquer un devoir fait / non fait (écriture) |
| `get_timetable` | Emploi du temps entre deux dates |
| `get_school_life` | Vie scolaire (absences, retards, sanctions) |
| `get_class_life` | Vie de la classe et commentaires |
| `get_timeline` | Fil d'actualité personnel |
| `get_messages` | Liste les messages d'un dossier (en-têtes seulement) |
| `read_message` | Contenu d'un message, HTML retiré, avec ses pièces jointes |
| `download_document` | Télécharge un document dans `DOWNLOAD_DIR`, sous son vrai nom, et renvoie son chemin |

La messagerie est en deux outils parce que l'API l'impose : la liste
renvoie `content: ""` pour chaque message, les corps n'existent que sur
l'endpoint par message. Les pièces jointes se récupèrent avec
`download_document` en passant `fileType` = `PIECE_JOINTE`.

## Variables d'environnement

- `SESSION_PATH` — chemin du fichier de session (défaut `~/.config/ecoledirecte-mcp/session.json`)
- `DEVICE_ID_PATH` — chemin de l'identifiant d'appareil (défaut `~/.config/ecoledirecte-mcp/device-id`)
- `DOWNLOAD_DIR` — dossier de téléchargement (défaut `~/.local/share/ecoledirecte-mcp/downloads`)
- `READ_ONLY` — `true` pour désactiver `mark_homework_done` (défaut `false` en local)
- `SESSION_MAX_AGE_MS` — âge au-delà duquel la session est rafraîchie préventivement (défaut 15 min)

Transport HTTP uniquement :

- `MCP_AUTH_TOKEN` — **obligatoire**, le serveur refuse de démarrer sans (`openssl rand -hex 32`)
- `MCP_HTTP_HOST` — adresse d'écoute (défaut `127.0.0.1`, jamais `0.0.0.0`)
- `MCP_HTTP_PORT` — port (défaut `8787`)
- `MCP_ALLOWED_HOSTS` — en-têtes `Host` acceptés, séparés par des virgules (défaut : l'adresse d'écoute)

Le `deviceUUID` généré au premier `login` est stocké séparément dans
`~/.config/ecoledirecte-mcp/device-id`. Ne pas le supprimer entre deux
logins, sous peine de redéclencher le QCM à chaque fois.

## Authentification : ce qu'il faut savoir

École Directe délivre **deux** secrets distincts, tous deux dans
`session.json` :

- `token` — jeton de session court, envoyé en header `X-Token` à chaque
  appel de données ; il tourne à chaque login ou re-login ;
- `accessToken` — credential long, lié à l'appareil, seule chose capable de
  régénérer un `token` sans le mot de passe.

Les confondre fait échouer **tous** les appels avec `520 "Token invalide !"`.
C'est pour cette raison que l'authentification (login, QCM, re-login) est
implémentée directement dans `src/client/edAuth.ts` plutôt que déléguée à
`@blockshub/blocksdirecte`, dont le module d'auth :

1. ne lit le jeton que dans le corps de la réponse, alors qu'École Directe
   le renvoie aussi (parfois uniquement) dans le header `X-Token` ;
2. ne reconnaît que les codes 250 et 505 au re-login — le `526`
   « Votre session est invalide ou expirée » tombe dans son chemin de succès
   et produit une session vide qui ressemble à une réussite ;
3. écrit sur **stdout**, ce qui corrompt le flux JSON-RPC du transport stdio.

Les modules de données de la librairie restent utilisés, avec un correctif
pour une récursion infinie dans leur vérification de module disponible
(`patchBrokenModuleAvailabilityCheck`). La messagerie, absente de la
librairie, est en HTTP direct (`src/client/messaging.ts`), ainsi que le
téléchargement (`src/client/download.ts`) : `downloader.getStream()` jette
les en-têtes de réponse, donc le vrai nom de fichier — porté par
`Content-Disposition` — était perdu et chaque document atterrissait sur le
disque nommé d'après son identifiant numérique, sans extension.

À noter : un téléchargement en échec répond quand même **HTTP 200**. École
Directe met son propre code dans l'en-tête `X-Code` (403 pour un
identifiant inconnu, avec une page d'erreur HTML en guise de contenu), ce
que le code vérifie avant d'écrire quoi que ce soit sur le disque.

## Limitations connues (V1)

**Expiration de session en cours d'utilisation.** La session est rafraîchie
préventivement au-delà de `SESSION_MAX_AGE_MS`, et un appel de données qui
échoue de façon récupérable déclenche un rafraîchissement puis une seule
nouvelle tentative — jamais de boucle. Mais `@blockshub/blocksdirecte` ne
remonte pas le code d'erreur d'École Directe sur les appels de données :
seule une réponse vide là où la librairie garantit un objet permet de
déduire l'expiration (`assertPresent`). Pour une écriture comme
`mark_homework_done`, dont la réponse ne contient rien à inspecter, un outil
peut donc renvoyer une erreur d'authentification au lieu de se rattraper
tout seul — relancer `login` dans ce cas.

**Durée de vie réelle du jeton inconnue.** Les 15 minutes par défaut de
`SESSION_MAX_AGE_MS` sont une valeur prudente, pas une valeur observée. À
calibrer à l'usage (voir « Développement » ci-dessous).

**`@blockshub/blocksdirecte` est épinglé** à la version exacte `0.0.9-alpha`
(pas de `^`) : c'est une version alpha dont on corrige des bugs par
monkey-patch, une montée de version silencieuse casserait ces correctifs.

## Hébergement sur le VPS, via Tailscale (V2)

Le transport HTTP est fait pour être joignable **depuis le tailnet et nulle
part ailleurs**. Trois protections se cumulent :

1. Le port n'est publié que sur l'adresse Tailscale du VPS. `docker-compose.yml`
   exige `TAILSCALE_IP` et refuse de démarrer sans — écrire `8787:8787` aurait
   lié `0.0.0.0` sur l'hôte et exposé le serveur à l'internet ouvert.
2. Chaque requête `/mcp` doit porter `Authorization: Bearer $MCP_AUTH_TOKEN`.
   La comparaison passe par `timingSafeEqual` sur des empreintes SHA-256 :
   à temps constant, et sans fuir la longueur du jeton attendu.
3. Protection anti DNS rebinding : le `Host` de la requête doit figurer dans
   `MCP_ALLOWED_HOSTS`, sinon 403. Sans elle, une page ouverte dans ton
   navigateur pourrait faire pointer son propre domaine vers l'adresse tailnet
   et parler au serveur à ta place.

`READ_ONLY` vaut **`true` par défaut** sur ce transport (contre `false` en
stdio) : il est joignable depuis d'autres machines, pas seulement par toi à
ton clavier. `mark_homework_done` disparaît alors de la liste des outils.

### Mise en route

    cp .env.example .env      # renseigner MCP_AUTH_TOKEN et TAILSCALE_IP
    docker compose build      # build natif arm64 sur le VPS Ampere
    docker compose run --rm -it ecoledirecte-mcp login
    docker compose up -d

Le `login` se fait bien **avant** le `up`, et via `run --rm -it` pour avoir un
terminal : il faut répondre au QCM. Session et identifiant d'appareil sont
écrits sur le volume `session`, donc conservés entre deux recréations du
conteneur — c'est pourquoi `DEVICE_ID_PATH` existe : sans lui l'identifiant
serait recréé à chaque fois et École Directe redemanderait le QCM.

Le conteneur écoute sur `0.0.0.0` **à l'intérieur** de son espace réseau, ce
qui est correct : l'isolation vient de la publication du port sur la seule IP
Tailscale.

`/health` répond sans jeton, et volontairement sans rien dire du compte :
`{"status":"ok","sessionExists":true}`. C'est ce que sonde le `HEALTHCHECK`.

### Connecter un client

    claude mcp add --transport http ecoledirecte http://<ip-tailscale>:8787/mcp \
      --header "Authorization: Bearer $MCP_AUTH_TOKEN"

Le transport est **sans état** (pas de `mcp-session-id`) : le serveur est
mono-utilisateur et ne pousse rien vers le client, donc il n'y a aucun cycle
de vie de session à gérer côté serveur.

## Statut

V1 (stdio, local) et V2 (HTTP, Docker, Tailscale) sont faites. Un outil
d'envoi de messages reste volontairement non implémenté.

La messagerie est en **lecture seule** : lister et lire. Envoyer, répondre
et transférer ne sont pas implémentés — ce sont des écritures visibles par
des tiers (professeurs, administration), à n'ajouter que délibérément.

## Développement

    npm test           # tests unitaires — aucun appel réseau réel
    npm run typecheck  # vérifie aussi test/ et scripts/
    npm run build
    npm run smoke-test # vérification manuelle contre le vrai compte

`smoke-test` utilise la session déjà enregistrée par `login`, n'a besoin
d'aucun identifiant, et n'est jamais lancé en CI. Il appelle chaque outil de
lecture à la suite et continue même si l'un échoue, pour montrer d'un coup
l'état réel de tous les endpoints.
