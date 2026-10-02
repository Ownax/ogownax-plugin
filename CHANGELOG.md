# Changelog

## 1.10.2

- File de construction : prise en compte de l'énergie requise (ex. Terraformeur). Si le bilan énergétique est insuffisant, le panneau indique l'énergie manquante et « Énergie insuffisante » au lieu de « Ressources disponibles » (aucune heure estimée : il faut augmenter la production d'énergie).

## 1.10.1

- File de construction multi-planètes : la file d'une planète/lune qui n'existe plus (abandonnée, détruite) est supprimée avec une notification, au lieu de tenter d'y naviguer indéfiniment.

## 1.10.0

- File de construction : affichage des **ressources manquantes** et de l'**heure estimée** pour le prochain bâtiment (« Manque : 708 métal · prêt vers 16h38 (dans 6:34) »), mis à jour chaque seconde.
- Coût exact lu une fois dans le détail OGame (bonus compris), production/s et stockage lus dans les données de la page.
- La vérification est programmée à l'heure estimée au lieu de recharger toutes les X secondes ; l'intervalle de revérification ne sert plus qu'en l'absence d'estimation.
- À chaque chargement d'une page de la planète, l'estimation est recalculée (arrivée de flotte, nouvelle production) et la vérification avancée si les ressources sont prêtes plus tôt.
- Détection d'un hangar trop petit pour le coût demandé.
- Panneau de file : les textes qui défilent sont mis à jour sans reconstruire le panneau (les clics ▲ / ✕ ne sont plus perdus).

## 1.9.3

- Correction file de construction : un cadre « Bâtiment » vide était pris pour une construction en cours (OGame y laisse la classe `construction active`). La construction en cours est désormais détectée uniquement par son compte à rebours.

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
