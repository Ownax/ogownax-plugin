# Changelog

## 1.15.0

- File de construction **sans rechargement** quand on est déjà sur la bonne planète et la bonne page (ajout, retrait, déplacement, heure estimée atteinte, ressources reçues) : le panneau de détail OGame, rechargé à chaque ouverture, sert d'oracle — bouton « Développer » présent = on lance ; absent = coût lu, manque et heure estimée. Le bouton d'achat premium n'est jamais utilisé.
- Le détail n'est ouvert que si c'est utile (l'estimation suffit quand il manque encore des ressources).
- Rechargement conservé uniquement quand il est nécessaire : contrôle juste après un lancement, construction terminée mais encore affichée en cours (page figée), changement de planète/page.

## 1.14.2

- Sauvegarde de la configuration : plus de popup « Configuration sauvegardée ! » ; le bouton ⚙️ affiche « ✅ Sauvegardé » pendant 2 s.

## 1.14.1

- Expéditions : touche de lancement configurable (L ou S) dans ⚙️ → Expéditions. Par défaut L, comme avant.

## 1.14.0

- **File « 🔬 Recherche »** : bouton « + » sur la page Recherche, file par planète (ce sont les ressources de cette planète qui paient), même fonctionnement que les bâtiments (lancement auto, ressources manquantes, heure estimée, notification « Recherche lancée »).
- La recherche en cours est mémorisée **pour tout le compte** (une seule recherche à la fois) : toutes les files de recherche attendent sa fin, sans navigation.
- **Contrainte Laboratoire ↔ Recherche**, dans les deux sens : la recherche attend la fin de l'extension du Laboratoire de sa planète ; un Laboratoire en tête de la file bâtiments attend la fin de la recherche en cours. Si la fin n'est pas connue, le message OGame (« Laboratoire de recherche est en cours d'extension ») est affiché.

## 1.13.1

- Correction : un bâtiment lancé restait dans la file. Le rechargement des ressources qui suit la dépense recalculait l'estimation du bâtiment lancé et repoussait d'une heure le contrôle post-lancement. Le coût mémorisé est désormais effacé au lancement.
- Au chargement d'une page, une construction en cours ignorée de la file (lancement non contrôlé, construction manuelle) déclenche une resynchronisation immédiate.
- Le stock affiché n'est plus utilisé que vers le haut (ressources reçues) : en arrière-plan, Chrome ralentit OGame et le chiffre affiché prend du retard, ce qui repoussait l'estimation chaque minute.
- Correction d'une course de quelques millisecondes qui pouvait repousser de 5 s une file déjà prête.

## 1.13.0

- Interface regroupée dans un bloc unique en bas à droite, de haut en bas : panneau ⚙️ (s'ouvre vers le haut), barre de boutons (🚨 PANIC · ⚙️ OgOwnax · interrupteur Activé avec voyant), files de construction, carte « ⏱️ Prochain clic ».
- Style unifié (cartes aux mêmes couleurs, bordures et ombres ; boutons de même hauteur) ; le bouton ⚙️ reste en surbrillance tant que le panneau est ouvert.

## 1.12.1

- Correction : quand les ressources qui manquaient arrivent d'un coup (récompense, flotte), la vérification est faite **tout de suite** au lieu de rester à l'échéance prévue (le panneau affichait « ⏳ Ressources presque disponibles » sans rien lancer). Une seule fois par vérification, pour ne pas boucler quand OGame bloque pour une autre raison.

## 1.12.0

- File de construction : l'heure estimée et le minuteur se recalculent quand les ressources changent **sans rechargement** :
  - interception de `reloadResources` (OGame recharge stock + production, ex. arrivée de flotte) ;
  - filet de sécurité : si le stock affiché s'écarte de la prévision (> 1 % ou 50), le calcul repart du stock réel.
- Après un F5 / changement de page, l'échéance est recalée **dans les deux sens** (avancée ou repoussée) ; plus de rechargement superflu quand les ressources sont déjà toutes là.
- Désaccord « OGame dit pas assez / le calcul dit prêt » : nouvel essai dans 15 s au lieu de l'intervalle complet ; le panneau affiche « ⏳ Ressources presque disponibles ».
- Filet de sécurité du minuteur : réarmé automatiquement s'il manque (ex. page chargée pendant un lancement d'expéditions).
- **Journal** de la file (80 dernières lignes) dans ⚙️ → Construction, pour comprendre après coup ce qui s'est passé.

## 1.11.1

- File de construction : contrôle après « Lancement… » ramené de 30 s à 10 s.

## 1.11.0

- **File « 🧬 Formes de vie »** par planète/lune, indépendante de la file des bâtiments (OGame a un emplacement de construction séparé) : bouton « + » sur la page Formes de vie, même fonctionnement (lancement auto, ressources manquantes, heure estimée, notifications).
- Panneau de file à deux sections (bâtiments / formes de vie) ; liste ⚙️ → Construction avec les deux types de files.
- **Contrainte Usine de robots / Usine de nanites** : pendant leur extension, la file formes de vie attend la fin de cette construction (heure mémorisée quand elle est vue sur Ressources/Installations/Vue d'ensemble, car la page Formes de vie ne l'affiche pas), sans navigation ni tentative inutile. Sens inverse appliqué aussi : une usine de robots/nanites en tête de file attend la fin d'une construction formes de vie.
- Si la fin n'est pas connue, le message OGame (« Usine de robots est en cours d'extension ») est affiché et la revérification classique s'applique.

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
