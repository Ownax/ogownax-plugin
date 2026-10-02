# Changelog

## 1.9.2

- Correction du lancement de construction (vérifié en jeu) : le détail du bâtiment s'ouvre en cliquant sur l'icône de la tuile, et seul le bouton « Développer » du bon bâtiment est utilisé.
- Le statut de la file affiche la raison donnée par OGame (lue dans `data-tooltip-title`).

## 1.9.1

- Correction file de construction : à la fin du compte à rebours, la page est rechargée (ou la bonne planète/page ouverte) au lieu de relire une page figée qui affichait encore « Construction en cours » indéfiniment.
- La vérification se déclenche pile à l'échéance (minuteur dédié) au lieu d'attendre le cycle de 60 s.
- Une fin de construction déjà passée est traitée comme « en cours de finalisation » (nouvel essai 5 s plus tard).

## 1.9.0

- Panneau de configuration réorganisé en onglets : 🛡️ Défense (panic + repli), 🚀 Expéditions, 🏗️ Construction, 🔔 Alertes (Discord + délais entre alertes), ⚙️ Général (cycle de vérification, clic aléatoire, reconnexion). Le dernier onglet ouvert est mémorisé ; les boutons Sauvegarder/Reset/Fermer restent visibles en bas.
- File de construction : revérification par défaut à 60 s ; bouton « + » en bas à gauche de la vignette ; panneau de file remonté pour ne plus masquer le bandeau du bas.
- Correction : le panneau ⚙️ s'ouvre dès le premier clic (il fallait cliquer deux fois).

## 1.8.0

- **File de construction par planète/lune** : bouton « + » sur chaque bâtiment (pages Ressources et Installations) pour ajouter le niveau suivant à la file ; badge « → N » sur la tuile.
- Panneau en bas à droite : file de la planète affichée, statut (raison OGame si bloqué), compte à rebours de la prochaine vérification, boutons ▲ (monter) et ✕ (retirer).
- Lancement automatique quand aucun bâtiment n'est en construction et qu'OGame indique le bâtiment disponible ; navigation automatique vers la planète/page concernée lors du cycle de vérification ; notifications Discord (lancement, file terminée).
- Section « 🏗️ File de construction » dans ⚙️ : activation, intervalle de revérification, vue de toutes les files avec bouton pour vider.

## 1.7.1

- Suppression de la popup de confirmation à la désactivation du plugin.
- « Tester le webhook » sans URL : message sur le bouton au lieu d'une popup.

## 1.7.0

- Bouton « ✅ Activé / ⛔ Désactivé » en haut à droite pour couper complètement le plugin (mémorisé dans Tampermonkey, commun à tous les univers du navigateur).
- À la désactivation : confirmation, annulation des actions en cours (lancement, panic, repli programmé), notification Discord, rechargement de la page.
- Désactivé, seul le bouton reste affiché : aucune surveillance, alerte ou action automatique.

## 1.6.0

- Webhook Discord retiré du code : saisi dans le panneau et stocké dans Tampermonkey (`GM_setValue`), commun à tous les univers. Migration automatique depuis l'ancienne config.
- Envoi Discord via `GM_xmlhttpRequest` (centralisé dans `notifyDiscord`), ignoré proprement si aucun webhook n'est configuré.
- Bouton « Tester le webhook » et indicateur quand le webhook est manquant.
- Ajout de `@updateURL` / `@downloadURL` pour les mises à jour automatiques.
- Correction : `unsafeWindow` utilisé sans `@grant` dans la reconnexion.
- Correction : démarrage fiable même si l'événement `load` est déjà passé.
- La version du script est affichée dans le panneau de configuration.

## 1.5.2

- Version initiale importée.
