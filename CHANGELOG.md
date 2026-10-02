# Changelog

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
