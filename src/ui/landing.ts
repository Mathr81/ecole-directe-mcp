/** The home page: what this is, and a step-by-step for someone who has never added an MCP server. */
import { brand, escapeHtml, icon, page, type IconName } from './html.js';

export interface LandingOptions {
  /** The address to paste in Claude: the MCP endpoint. */
  mcpUrl: string;
  readOnly: boolean;
}

const PROMPTS = [
  "Qu'est-ce que j'ai pour demain ?",
  'Quelles sont mes dernières notes ?',
  'Fais-moi un planning de révisions pour la semaine',
  "J'ai eu des absences ce trimestre ?",
];

function copyButton(text: string, label: string, copied: string, ghost = false): string {
  return `<button type="button" class="btn${ghost ? ' is-ghost' : ''}" data-copy="${escapeHtml(text)}" data-copied="${escapeHtml(copied)}">${icon('copy')}${label}</button>`;
}

function can(glyph: IconName, title: string, text: string): string {
  return `<div class="can-item">${icon(glyph)}<h3>${title}</h3><p>${text}</p></div>`;
}

function faq(question: string, answer: string): string {
  return `<details><summary>${question}</summary><div>${answer}</div></details>`;
}

export function renderLanding({ mcpUrl, readOnly }: LandingOptions): string {
  const url = escapeHtml(mcpUrl);
  const homework = readOnly
    ? 'Ce qui est à faire pour demain, la semaine, et le contenu des séances.'
    : "Ce qui est à faire pour demain, la semaine, et ton IA peut cocher un devoir comme fait.";

  return page({
    title: 'Branche ton IA à École Directe',
    noindex: false,
    description: 'Demande tes notes, tes devoirs ou ton emploi du temps à ton IA, directement dans la conversation.',
    body: `<a class="skip" href="#tuto">Aller au tuto</a>
<header class="top"><div class="wrap">${brand()}<nav aria-label="Sur cette page"><a href="#tuto">Le tuto</a><a href="#questions">Questions</a></nav></div></header>

<main>
<section class="hero"><div class="wrap">
  <div>
    <span class="sticker">gratuit, en 2 minutes</span>
    <h1>Branche ton IA à École Directe</h1>
    <p class="lead">Demande tes notes, tes devoirs de demain ou ton emploi du temps à Claude, directement dans la conversation. Sans ouvrir l'appli.</p>
    <div class="hero-actions">
      <a class="btn" href="#tuto">Commencer le tuto</a>
      ${copyButton(mcpUrl, "Copier l'adresse", 'Adresse copiée, colle-la dans Claude', true)}
    </div>
  </div>
  <figure class="chat" aria-label="Exemple de conversation">
    <span class="sticker is-blue" aria-hidden="true">exemple</span>
    <div class="chat-bar"><span class="dot" aria-hidden="true"></span>Claude<span class="tool">École Directe</span></div>
    <p class="bubble is-me" data-say>Qu'est-ce que j'ai pour demain ?</p>
    <div class="bubble is-ai" data-say>Demain, mardi :
      <ul><li>Maths : exercices 12 à 15 p. 84</li><li>Anglais : vocabulaire de l'unité 4</li><li>Pas de SVT à 15 h, le cours est annulé.</li></ul>
    </div>
    <p class="bubble is-me" data-say>Et ma moyenne en physique ?</p>
    <p class="bubble is-ai" data-say>14,6 sur 20 ce trimestre, 0,8 de plus qu'au dernier contrôle.</p>
  </figure>
</div></section>

<section class="section band" id="tuto" aria-labelledby="tuto-title"><div class="wrap">
  <div class="section-head">
    <h2 id="tuto-title">Le tuto, en 5 étapes</h2>
    <p class="lead">Le plus simple, c'est sur ordinateur. Une fois fait, ça marche aussi dans l'appli Claude sur ton téléphone.</p>
  </div>
  <ol class="tuto">
    <li><span class="num" aria-hidden="true">1</span><div class="body">
      <h3>Ouvre Claude</h3>
      <p>Va sur <a href="https://claude.ai" rel="noopener">claude.ai</a> et connecte-toi, ou crée un compte. Le compte gratuit suffit.</p>
    </div></li>
    <li><span class="num" aria-hidden="true">2</span><div class="body">
      <h3>Ajoute le connecteur</h3>
      <p class="path">Paramètres <span aria-hidden="true">›</span> Connecteurs <span aria-hidden="true">›</span> Ajouter un connecteur personnalisé</p>
      <p>Donne-lui un nom (par exemple <em>École Directe</em>) et colle cette adresse dans le champ de l'URL :</p>
      <div class="copy"><span class="url">${url}</span>${copyButton(mcpUrl, 'Copier', 'Adresse copiée')}</div>
      <p class="muted small">Laisse les paramètres avancés vides, puis clique sur <span class="kbd">Ajouter</span>.</p>
    </div></li>
    <li><span class="num" aria-hidden="true">3</span><div class="body">
      <h3>Connecte ton compte École Directe</h3>
      <p>Clique sur <span class="kbd">Se connecter</span> à côté du connecteur. Une page de ce site s'ouvre : entre tes identifiants École Directe, les mêmes que dans l'appli. Si une question de sécurité apparaît, réponds-y.</p>
    </div></li>
    <li><span class="num" aria-hidden="true">4</span><div class="body">
      <h3>Attends la validation</h3>
      <p>La première fois, la personne qui gère ce serveur valide ta demande à la main. Quand c'est fait, reclique sur <span class="kbd">Se connecter</span> : cette fois, c'est bon.</p>
    </div></li>
    <li><span class="num" aria-hidden="true">5</span><div class="body">
      <h3>Pose ta première question</h3>
      <p>Ouvre une nouvelle conversation et demande, par exemple :</p>
      <ul class="prompts">${PROMPTS.map((prompt) => `<li><button type="button" data-copy="${escapeHtml(prompt)}" data-copied="Copié, colle-le dans Claude">${escapeHtml(prompt)}</button></li>`).join('')}</ul>
      <p class="muted small">Si Claude ne pense pas à regarder École Directe, vérifie que le connecteur est activé dans le menu des outils, sous la zone de saisie.</p>
    </div></li>
  </ol>
</div></section>

<section class="section" aria-labelledby="can-title"><div class="wrap">
  <div class="section-head"><h2 id="can-title">Ce que tu peux lui demander</h2></div>
  <div class="can">
    ${can('grades', 'Notes et moyennes', 'Tes dernières notes, ta moyenne par matière, la comparaison avec la classe.')}
    ${can('homework', 'Devoirs', homework)}
    ${can('calendar', 'Emploi du temps', 'Ta journée, ta semaine, les cours annulés ou déplacés.')}
    ${can('school', 'Vie scolaire', 'Absences, retards, punitions et encouragements.')}
    ${can('message', 'Messagerie', 'Les messages de tes profs et de la vie scolaire, en lecture seule.')}
    ${can('folder', 'Documents', 'Bulletins, documents administratifs et fichiers des espaces de travail.')}
  </div>
</div></section>

<section class="section band" id="questions" aria-labelledby="faq-title"><div class="wrap">
  <div class="section-head"><h2 id="faq-title">Questions</h2></div>
  <div class="faq">
    ${faq("C'est sûr, pour mon mot de passe ?", "<p>Ton mot de passe sert une seule fois, pour ouvrir ta session École Directe, puis il est oublié. Le serveur ne garde que la session, chiffrée, comme le fait l'appli sur ton téléphone.</p>")}
    ${faq('Qui peut voir mes notes ?', "<p>Ton IA, quand tu lui poses une question. Le journal du serveur ne retient que des faits d'usage (quel outil, à quelle heure), jamais tes notes ni tes messages.</p><p>C'est un serveur perso : ne l'utilise que si tu connais la personne qui te l'a partagé.</p>")}
    ${faq('Pourquoi il faut attendre une validation ?', "<p>Le serveur est partagé entre amis. Chaque nouvelle personne est validée à la main, pour que des inconnus ne puissent pas s'en servir.</p>")}
    ${faq('Ça marche avec ChatGPT ou une autre IA ?', "<p>Toute appli qui accepte un serveur MCP distant avec connexion OAuth peut s'y brancher, avec la même adresse. Le tuto est écrit pour Claude, le plus simple à configurer.</p>")}
    ${faq('Et pour les parents ?', '<p>Pas encore : pour l\'instant, seuls les comptes élèves fonctionnent.</p>')}
    ${faq('Ça ne marche plus, je fais quoi ?', "<p>Si École Directe a fermé ta session (après un changement de mot de passe, par exemple), Claude te dira de te reconnecter. Retourne dans Paramètres › Connecteurs et clique sur <strong>Se connecter</strong>.</p>")}
    ${faq("Comment j'arrête ?", "<p>Supprime le connecteur dans les paramètres de Claude, puis demande à la personne qui gère le serveur de retirer ton accès : ta session et ton historique sont alors effacés.</p>")}
  </div>
</div></section>
</main>

<footer class="foot"><div class="wrap"><p>Projet perso, sans lien avec École Directe ni Aplim.</p><p><a href="#tuto">Revoir le tuto</a></p></div></footer>`,
  });
}
