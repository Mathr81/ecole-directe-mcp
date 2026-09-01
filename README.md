# ecoledirecte-mcp

Serveur MCP personnel pour École Directe : notes, devoirs, emploi du temps,
vie scolaire, vie de classe, fil d'actualité, téléchargement de documents.

## Installation locale (V1 — stdio uniquement)

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
| `download_document` | Télécharge un document dans `DOWNLOAD_DIR` et renvoie son chemin |

La messagerie (`get_messages`) n'est pas incluse : le contrat exact de
l'endpoint reste à vérifier avant d'écrire ce code (voir le plan).

## Variables d'environnement

- `SESSION_PATH` — chemin du fichier de session (défaut `~/.config/ecoledirecte-mcp/session.json`)
- `DOWNLOAD_DIR` — dossier de téléchargement (défaut `~/.local/share/ecoledirecte-mcp/downloads`)
- `READ_ONLY` — `true` pour désactiver `mark_homework_done` (défaut `false` en local)
- `SESSION_MAX_AGE_MS` — âge au-delà duquel la session est rafraîchie préventivement (défaut 15 min)

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
(`patchBrokenModuleAvailabilityCheck`).

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

## Statut

V1 : usage local uniquement, transport stdio. Le transport HTTP
(hébergement Docker sur le VPS, accessible via Tailscale) et un outil de
messagerie sont prévus pour une V2 séparée.

## Développement

    npm test           # tests unitaires — aucun appel réseau réel
    npm run typecheck  # vérifie aussi test/ et scripts/
    npm run build
    npm run smoke-test # vérification manuelle contre le vrai compte

`smoke-test` utilise la session déjà enregistrée par `login`, n'a besoin
d'aucun identifiant, et n'est jamais lancé en CI. Il appelle chaque outil de
lecture à la suite et continue même si l'un échoue, pour montrer d'un coup
l'état réel de tous les endpoints.
