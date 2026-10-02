# OgOwnax Plugin

Script Tampermonkey pour OGame : alertes Discord (attaque / espionnage), lancement automatique des expéditions, bouton Panic et repli automatique par planète/lune.

## Installation (sur chaque navigateur)

1. Installer [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Opera, Safari).
2. Chrome / Edge uniquement : activer le « Mode développeur » dans `chrome://extensions` (ou « Autoriser les scripts utilisateur » dans les détails de Tampermonkey), sinon les userscripts ne s'exécutent pas.
3. Ouvrir ce lien et cliquer **Installer** :

   **https://raw.githubusercontent.com/OWNER/ogownax-plugin/main/ogownax-plugin.user.js**

4. Si une ancienne version (installée par copier-coller) existe, la supprimer dans le tableau de bord Tampermonkey pour éviter un doublon.

## Mises à jour

Le script déclare `@updateURL` / `@downloadURL` : Tampermonkey vérifie automatiquement les mises à jour (par défaut toutes les 24 h).
Pour forcer : tableau de bord Tampermonkey → *Utilitaires* → *Rechercher des mises à jour*, ou réouvrir le lien d'installation.

> Tampermonkey ne met à jour que si `@version` augmente. Penser à l'incrémenter à chaque modification.

## Configuration

Tout se règle via le bouton **⚙️ OgOwnax Plugin** en jeu.

- **Webhook Discord** : à saisir une fois par navigateur. Il est stocké dans Tampermonkey (`GM_setValue`), partagé entre tous les univers, et n'est **jamais** dans le code ni dans le repo. Le bouton ⚙️ a une bordure orange tant qu'il n'est pas renseigné. Le bouton « Tester le webhook » envoie un message de test.
- **Le reste** (expéditions, panic, repli…) est propre à chaque univers (localStorage du domaine), puisque les planètes diffèrent.

## Publier une nouvelle version

1. Modifier `ogownax-plugin.user.js`.
2. Incrémenter `@version` (ex. `1.6.0` → `1.6.1`) et noter le changement dans `CHANGELOG.md`.
3. `git commit` puis `git push` : tous les navigateurs récupèrent la mise à jour au prochain contrôle.

## Ne jamais commiter

Aucune URL de webhook, token ou identifiant dans le code. En cas de fuite d'un webhook : le supprimer dans Discord (*Paramètres du salon → Intégrations → Webhooks*) et en recréer un.
