// ==UserScript==
// @name         OgOwnax Plugin
// @namespace    https://github.com/Ownax/ogownax-plugin
// @version      1.25.2
// @description  Alertes Discord, expéditions auto, panic et repli automatique pour OGame
// @author       Ownax
// @match        https://*.ogame.gameforge.com/*
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      discord.com
// @connect      discordapp.com
// @run-at       document-idle
// @homepageURL  https://github.com/Ownax/ogownax-plugin
// @updateURL    https://raw.githubusercontent.com/Ownax/ogownax-plugin/main/ogownax-plugin.user.js
// @downloadURL  https://raw.githubusercontent.com/Ownax/ogownax-plugin/main/ogownax-plugin.user.js
// ==/UserScript==

(function() {
    'use strict';

    // Le webhook Discord n'est jamais stocké dans le code : il est saisi dans le panneau
    // de configuration et conservé dans le stockage Tampermonkey (GM_setValue),
    // partagé entre tous les univers OGame du navigateur.
    const WEBHOOK_STORAGE_KEY = 'discordWebhook';
    const ENABLED_STORAGE_KEY = 'pluginEnabled';

    const DEFAULT_CONFIG = {
        alertAttack: true,
        alertEspionage: true,
        discordWebhook: '',
        expeditionsPerBody: {},
        autoLaunchExpeditions: true,
        expeditionCheckInterval: 60 * 1000,
        // Raccourci OGame appuyé sur la page Flotte pour composer l'expédition
        expeditionKey: 'l',
        // 'key' : touche L/S ; 'template' : flotte d'expédition enregistrée (nom ci-dessous), via la page Flotte ;
        // 'direct' : même flotte, envoyée par requête (bouton « Envoyer » de la case 16 de la Galaxie), sans changer de page
        expeditionMode: 'key',
        expeditionTemplate: '',
        expeditionStartHour: null,
        expeditionEndHour: null,
        randomClickEnabled: true,
        randomClickInterval: 570,
        cooldowns: {
            expedition: 30 * 60 * 1000,
            attack: 60 * 1000,
            espionage: 60 * 1000,
            disconnected: 60 * 1000,
        },
        autoReconnect: true,
        reconnectDelay: 5 * 60 * 1000,
        panic: {
            sourceId: null,
            sourceType: 'planet',
            destinationId: null,
            destinationType: 'planet',
            speed: 10,
            autoPanicOnAttack: false,
            autoPanicDelay: 10,
        },
        fleeConfig: {
            enabled: false,
            speed: 10,
            delayBeforeImpact: 30,
            destinations: {}
        },
        buildQueue: {
            enabled: true,
            recheckInterval: 60,
        },
        // Les actions automatiques (expéditions, files, clic aléatoire) attendent X s sans activité humaine
        idle: {
            enabled: true,
            delay: 60,
        },
        // Défense automatique : { bodies: { [id]: { enabled, threshold: {metal,crystal,deuterium}, keep: {...}, order: [ids] } } }
        autoDefense: {
            enabled: false,
            interval: 30,
            bodies: {},
        },
        // Découverte de formes de vie : plage « galaxie:système », limites cumulables (0 = ignorée)
        discovery: {
            enabled: false,
            // Planète/lune de départ (id) : obligatoire
            originId: '',
            keepFreeSlots: 0,
            maxActive: 0,
            from: '',
            to: '',
            interval: 5,
        },
        // Bilan Discord périodique des expéditions (en cours + résultats de la période) ; interval en secondes
        expeditionReport: {
            enabled: true,
            interval: 3600,
        },
        // Un message Discord à chaque lancement d'expédition (les erreurs sont toujours signalées)
        expeditionLaunchAlerts: false,
    };

    const LAUNCH_STATE_KEY = 'ogame_plugin_launch_state';
    const PANIC_STATE_KEY = 'ogame_plugin_panic_state';
    const FLEE_STATE_KEY = 'ogame_plugin_flee_state';
    const SCHEDULED_FLEE_KEY = 'ogame_plugin_scheduled_flee';
    const PROCESSED_ATTACKS_KEY = 'ogame_plugin_processed_attacks';
    const BUILD_QUEUE_KEY = 'ogame_plugin_build_queue';
    const BUILD_STATE_KEY = 'ogame_plugin_build_state';
    const BUILD_INFO_KEY = 'ogame_plugin_construction_info';
    // Emplacements de construction indépendants par planète/lune (+ la recherche, commune au compte)
    // Formes de vie : bâtiments 1x1xx (ex. 11101), recherches 1x2xx (ex. 11201, 13202)
    const isLifeformKind = (id, kind) => id > 10000 && Math.floor(id / 100) % 10 === kind;
    const BUILD_LANES = {
        building: {
            pages: ['supplies', 'facilities'],
            box: '#productionboxbuildingcomponent',
            title: '🏗️ File de construction',
            // Les satellites solaires (212) et foreuses (217) sont des unités, pas des bâtiments
            isTechnology: id => id < 200,
        },
        lifeform: {
            pages: ['lfbuildings'],
            box: '#productionboxlfbuildingcomponent',
            title: '🧬 File formes de vie',
            isTechnology: id => isLifeformKind(id, 1),
        },
        // Une recherche de forme de vie à la fois par planète, en parallèle des bâtiments de forme de vie
        lfresearch: {
            pages: ['lfresearch'],
            box: '#productionboxlfresearchcomponent',
            title: '🧪 File recherches formes de vie',
            isTechnology: id => isLifeformKind(id, 2),
        },
        // Une seule recherche à la fois pour tout le compte ; elle est payée par la planète qui la lance
        research: {
            pages: ['research'],
            box: '#productionboxresearchcomponent',
            title: '🔬 File de recherche',
            isTechnology: id => id >= 100 && id < 200,
            accountWide: true,
        },
    };
    const RESEARCH_LAB_ID = 31;
    const ACCOUNT_INFO_KEY = '__account';
    const BUILDING_PAGES = Object.values(BUILD_LANES).flatMap(lane => lane.pages);
    // Pendant l'amélioration de ces usines, OGame bloque les bâtiments de formes de vie (et inversement)
    const LIFEFORM_BLOCKING_BUILDINGS = { 14: 'Usine de robots', 15: 'Usine de nanites' };

    let scheduledPanicTimeout = null;
    let scheduledPanicTargetTime = null;
    let scheduledFleeTimeouts = {};
    let nextClickTime = null;
    let timerInterval = null;

    function loadWebhook(fallback) {
        const stored = GM_getValue(WEBHOOK_STORAGE_KEY, '');
        if (stored) return stored;
        // Migration : ancien webhook sauvegardé dans le localStorage de l'univers
        if (fallback) {
            GM_setValue(WEBHOOK_STORAGE_KEY, fallback);
            return fallback;
        }
        return '';
    }

    function loadConfig() {
        const saved = localStorage.getItem('ogame_plugin_config');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                const config = {
                    ...DEFAULT_CONFIG,
                    ...parsed,
                    cooldowns: { ...DEFAULT_CONFIG.cooldowns, ...parsed.cooldowns },
                    panic: { ...DEFAULT_CONFIG.panic, ...parsed.panic },
                    fleeConfig: { ...DEFAULT_CONFIG.fleeConfig, ...parsed.fleeConfig },
                    buildQueue: { ...DEFAULT_CONFIG.buildQueue, ...parsed.buildQueue },
                    idle: { ...DEFAULT_CONFIG.idle, ...parsed.idle },
                    autoDefense: { ...DEFAULT_CONFIG.autoDefense, ...parsed.autoDefense },
                    discovery: { ...DEFAULT_CONFIG.discovery, ...parsed.discovery },
                    expeditionReport: { ...DEFAULT_CONFIG.expeditionReport, ...parsed.expeditionReport },
                };
                if (parsed.expeditionsPerPlanet && !parsed.expeditionsPerBody) {
                    config.expeditionsPerBody = {};
                    Object.keys(parsed.expeditionsPerPlanet).forEach(coords => {
                        config.expeditionsPerBody[`planet_${coords}`] = parsed.expeditionsPerPlanet[coords];
                    });
                }
                config.discordWebhook = loadWebhook(parsed.discordWebhook);
                return config;
            } catch (e) {
                return { ...DEFAULT_CONFIG, discordWebhook: loadWebhook() };
            }
        }
        return { ...DEFAULT_CONFIG, discordWebhook: loadWebhook() };
    }

    function saveConfig(config) {
        GM_setValue(WEBHOOK_STORAGE_KEY, config.discordWebhook || '');
        // Le webhook n'est pas dupliqué dans le localStorage de la page
        const { discordWebhook, ...rest } = config;
        localStorage.setItem('ogame_plugin_config', JSON.stringify(rest));
    }

    function notifyDiscord(content) {
        if (!CONFIG.discordWebhook) {
            console.log('[Discord] Webhook non configuré, notification ignorée');
            return Promise.resolve(false);
        }

        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.discordWebhook,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ content }),
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        resolve(true);
                    } else {
                        console.log('[Discord] Erreur HTTP:', res.status, res.responseText);
                        resolve(false);
                    }
                },
                onerror: (err) => {
                    console.log('[Discord] Erreur réseau:', err);
                    resolve(false);
                },
            });
        });
    }

    function isPluginEnabled() {
        return GM_getValue(ENABLED_STORAGE_KEY, true);
    }

    async function setPluginEnabled(enabled) {
        if (!enabled) {
            cancelScheduledPanic();
            Object.keys(scheduledFleeTimeouts).forEach(key => clearTimeout(scheduledFleeTimeouts[key]));
            scheduledFleeTimeouts = {};
            clearLaunchState();
            clearPanicState();
            saveFleeState({});
            saveScheduledFlee({});
            saveProcessedAttacks({});
            clearBuildState();
        }

        GM_setValue(ENABLED_STORAGE_KEY, enabled);
        console.log(`[Monitor] Plugin ${enabled ? 'activé' : 'désactivé'}`);
        await notifyDiscord(enabled
            ? `▶️ **OgOwnax Plugin activé** sur ${window.location.hostname}`
            : `⏸️ **OgOwnax Plugin désactivé** sur ${window.location.hostname} - plus aucune alerte ne sera envoyée`);
        window.location.reload();
    }

    // Bloc unique en bas à droite : [panneau ⚙️ (s'ouvre vers le haut)] / [barre de boutons] / [files de construction]
    function getDock() {
        let dock = document.getElementById('ogame-plugin-dock');
        if (dock) return dock;

        const style = document.createElement('style');
        style.textContent = `
            #ogame-plugin-dock {
                position: fixed;
                right: 10px;
                bottom: 45px;
                z-index: 10000;
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 6px;
                max-height: calc(100vh - 60px);
                font-family: Verdana, Arial, sans-serif;
            }
            #ogame-plugin-dock .ogp-card {
                box-sizing: border-box;
                width: 300px;
                background: linear-gradient(180deg, rgba(16, 36, 48, 0.97) 0%, rgba(6, 16, 21, 0.97) 100%);
                border: 1px solid #3c5a6a;
                border-radius: 8px;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
                color: #9fc3d6;
                font-size: 11px;
            }
            #ogame-plugin-toolbar {
                flex-shrink: 0;
                padding: 6px;
            }
            #ogame-plugin-toolbar .ogp-buttons {
                display: flex;
                gap: 5px;
            }
            #ogame-plugin-toolbar button {
                height: 28px;
                padding: 0 9px;
                border: 1px solid;
                border-radius: 5px;
                cursor: pointer;
                font-family: inherit;
                font-size: 11px;
                font-weight: bold;
                white-space: nowrap;
                transition: filter 0.15s, box-shadow 0.15s;
            }
            #ogame-plugin-toolbar button:hover {
                filter: brightness(1.3);
            }
            #ogame-plugin-panic-btn {
                background: linear-gradient(180deg, #5a1d1d 0%, #2e0d0d 100%);
                border-color: #8a3c3c !important;
                color: #ffb0b0;
            }
            #ogame-plugin-btn {
                flex: 1;
                background: linear-gradient(180deg, #1f4253 0%, #0d2230 100%);
                border-color: #3c6a7f !important;
                color: #bfe3f5;
            }
            #ogame-plugin-btn.open {
                box-shadow: inset 0 0 0 1px #6fcfff;
            }
            #ogame-plugin-btn.no-webhook {
                border-color: #cfaf6f !important;
            }
            #ogame-plugin-btn.launching {
                background: linear-gradient(180deg, #3a4a1a 0%, #1f290d 100%);
                border-color: #5a6a3c !important;
            }
            #ogame-plugin-toggle {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            #ogame-plugin-toggle .ogp-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: currentColor;
                box-shadow: 0 0 6px currentColor;
            }
            #ogame-plugin-toggle.enabled {
                background: linear-gradient(180deg, #1d4a2a 0%, #0d2915 100%);
                border-color: #3c7a4a;
                color: #8fff9f;
            }
            #ogame-plugin-toggle.disabled {
                background: linear-gradient(180deg, #3a3a3a 0%, #1a1a1a 100%);
                border-color: #7a3c3c;
                color: #ff9f9f;
            }
            #ogame-plugin-idle {
                flex-shrink: 0;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 7px 10px;
                border-color: #6a5a3c;
            }
            #ogame-plugin-idle .idle-label {
                color: #e6c98f;
                font-weight: bold;
            }
            #ogame-plugin-idle .idle-value {
                color: #cfaf6f;
            }
            #ogame-plugin-timer {
                flex-shrink: 0;
                display: none;
                justify-content: space-between;
                align-items: center;
                padding: 7px 10px;
            }
            #ogame-plugin-timer.active {
                display: flex;
            }
            #ogame-plugin-timer .timer-label {
                color: #9fc3d6;
                font-weight: bold;
            }
            #ogame-plugin-timer .timer-value {
                color: #6fcfff;
                font-weight: bold;
            }
            #ogame-plugin-timer.warning .timer-value {
                color: #cfaf6f;
            }
            #ogame-plugin-timer.imminent .timer-value {
                color: #cf6f6f;
            }
        `;
        document.head.appendChild(style);

        dock = document.createElement('div');
        dock.id = 'ogame-plugin-dock';
        document.body.appendChild(dock);
        return dock;
    }

    function closeConfigPanel() {
        const panel = document.getElementById('ogame-plugin-panel');
        if (panel) panel.style.display = 'none';
        document.getElementById('ogame-plugin-btn')?.classList.remove('open');
        document.getElementById('ogame-plugin-dock')?.classList.remove('cfg-open');
    }

    function createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.id = 'ogame-plugin-toolbar';
        toolbar.className = 'ogp-card';
        toolbar.innerHTML = '<div class="ogp-buttons"></div>';
        getDock().appendChild(toolbar);
        return toolbar;
    }

    function createToggleButton() {
        const enabled = isPluginEnabled();
        const btn = document.createElement('button');
        btn.id = 'ogame-plugin-toggle';
        btn.className = enabled ? 'enabled' : 'disabled';
        btn.innerHTML = `<span class="ogp-dot"></span>${enabled ? 'Activé' : 'Désactivé'}`;
        btn.title = enabled ? 'Cliquer pour désactiver complètement le plugin' : 'Cliquer pour réactiver le plugin';
        btn.addEventListener('click', () => setPluginEnabled(!enabled));
        return btn;
    }

    function loadLaunchState() {
        const saved = localStorage.getItem(LAUNCH_STATE_KEY);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    function saveLaunchState(state) {
        localStorage.setItem(LAUNCH_STATE_KEY, JSON.stringify(state));
    }

    function clearLaunchState() {
        localStorage.removeItem(LAUNCH_STATE_KEY);
    }

    function loadPanicState() {
        const saved = localStorage.getItem(PANIC_STATE_KEY);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    function savePanicState(state) {
        localStorage.setItem(PANIC_STATE_KEY, JSON.stringify(state));
    }

    function clearPanicState() {
        localStorage.removeItem(PANIC_STATE_KEY);
    }

    function loadFleeState() {
        const saved = localStorage.getItem(FLEE_STATE_KEY);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return {};
            }
        }
        return {};
    }

    function saveFleeState(state) {
        localStorage.setItem(FLEE_STATE_KEY, JSON.stringify(state));
    }

    function loadScheduledFlee() {
        const saved = localStorage.getItem(SCHEDULED_FLEE_KEY);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return {};
            }
        }
        return {};
    }

    function saveScheduledFlee(scheduled) {
        localStorage.setItem(SCHEDULED_FLEE_KEY, JSON.stringify(scheduled));
    }

    function loadProcessedAttacks() {
        const saved = localStorage.getItem(PROCESSED_ATTACKS_KEY);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return {};
            }
        }
        return {};
    }

    function saveProcessedAttacks(attacks) {
        localStorage.setItem(PROCESSED_ATTACKS_KEY, JSON.stringify(attacks));
    }

    function parseCountdown(countdownStr) {
        if (!countdownStr) return null;

        let totalSeconds = 0;

        const hourMatch = countdownStr.match(/(\d+)\s*h/i);
        if (hourMatch) {
            totalSeconds += parseInt(hourMatch[1]) * 3600;
        }

        const minMatch = countdownStr.match(/(\d+)\s*m/i);
        if (minMatch) {
            totalSeconds += parseInt(minMatch[1]) * 60;
        }

        const secMatch = countdownStr.match(/(\d+)\s*s/i);
        if (secMatch) {
            totalSeconds += parseInt(secMatch[1]);
        }

        if (totalSeconds > 0) {
            return totalSeconds;
        }

        const colonParts = countdownStr.split(':').map(p => parseInt(p.trim()) || 0);

        if (colonParts.length === 3) {
            return colonParts[0] * 3600 + colonParts[1] * 60 + colonParts[2];
        } else if (colonParts.length === 2) {
            return colonParts[0] * 60 + colonParts[1];
        } else if (colonParts.length === 1 && colonParts[0] > 0) {
            return colonParts[0];
        }

        return null;
    }

    function scheduleAutoPanic(secondsUntilImpact, attackInfo) {
        if (!CONFIG.panic.autoPanicOnAttack) return;
        if (!CONFIG.panic.sourceId || !CONFIG.panic.destinationId) {
            console.log('[Panic] Auto-panic activé mais non configuré');
            return;
        }

        const panicState = loadPanicState();
        if (panicState && panicState.active) {
            console.log('[Panic] Panic déjà en cours');
            return;
        }

        const delayBeforeImpact = CONFIG.panic.autoPanicDelay || 10;
        const secondsUntilPanic = secondsUntilImpact - delayBeforeImpact;

        if (secondsUntilPanic <= 0) {
            console.log('[Panic] Pas assez de temps, déclenchement immédiat !');
            executePanic();
            return;
        }

        const targetTime = Date.now() + (secondsUntilPanic * 1000);

        if (scheduledPanicTimeout && scheduledPanicTargetTime) {
            if (targetTime >= scheduledPanicTargetTime) {
                console.log('[Panic] Panic déjà programmé pour plus tôt');
                return;
            }
            clearTimeout(scheduledPanicTimeout);
        }

        scheduledPanicTargetTime = targetTime;

        console.log(`[Panic] AUTO-PANIC programmé dans ${secondsUntilPanic}s (${delayBeforeImpact}s avant impact)`);

        notifyDiscord(`⚠️ **AUTO-PANIC PROGRAMMÉ** dans ${Math.floor(secondsUntilPanic / 60)}m ${secondsUntilPanic % 60}s\n📍 Attaque de ${attackInfo.playerName || 'inconnu'} sur ${attackInfo.destCoords}`);

        scheduledPanicTimeout = setTimeout(() => {
            console.log('[Panic] AUTO-PANIC DÉCLENCHÉ !');
            scheduledPanicTimeout = null;
            scheduledPanicTargetTime = null;
            executePanic();
        }, secondsUntilPanic * 1000);

        showAutoPanicScheduled(secondsUntilPanic);
    }

    function cancelScheduledPanic() {
        if (scheduledPanicTimeout) {
            clearTimeout(scheduledPanicTimeout);
            scheduledPanicTimeout = null;
            scheduledPanicTargetTime = null;
            console.log('[Panic] Auto-panic annulé');
        }
    }

    function showAutoPanicScheduled(seconds) {
        const existingStatus = document.getElementById('ogame-plugin-autopanic-scheduled');
        if (existingStatus) {
            existingStatus.remove();
        }

        const status = document.createElement('div');
        status.id = 'ogame-plugin-autopanic-scheduled';
        status.style.cssText = `
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10003;
        background: linear-gradient(180deg, #4a1a1a 0%, #290d0d 100%);
        border: 2px solid #6a3c3c;
        border-radius: 8px;
        padding: 10px 20px;
        color: #ff9f9f;
        font-family: Verdana, Arial, sans-serif;
        font-size: 12px;
        font-weight: bold;
        text-align: center;
    `;

        function updateDisplay() {
            if (!scheduledPanicTargetTime) {
                status.remove();
                return;
            }
            const remaining = Math.max(0, Math.floor((scheduledPanicTargetTime - Date.now()) / 1000));
            const min = Math.floor(remaining / 60);
            const sec = remaining % 60;
            status.innerHTML = `🚨 AUTO-PANIC dans <span style="color: #ff6f6f;">${min}:${sec.toString().padStart(2, '0')}</span> <button id="cancel-autopanic" style="margin-left: 10px; padding: 2px 8px; cursor: pointer;">❌</button>`;

            const cancelBtn = document.getElementById('cancel-autopanic');
            if (cancelBtn) {
                cancelBtn.onclick = () => {
                    cancelScheduledPanic();
                    status.remove();
                    notifyDiscord(`❌ **AUTO-PANIC ANNULÉ** manuellement`);
                };
            }

            if (remaining > 0) {
                setTimeout(updateDisplay, 1000);
            }
        }

        document.body.appendChild(status);
        updateDisplay();
    }

    function scheduleAutoFlee(targetKey, eventId, secondsUntilImpact, attackInfo) {
        if (!CONFIG.fleeConfig.enabled) return;

        const destination = CONFIG.fleeConfig.destinations[targetKey];
        if (!destination) {
            console.log(`[Flee] Pas de destination de repli configurée pour ${targetKey}`);
            return;
        }

        const processedAttacks = loadProcessedAttacks();
        if (processedAttacks[eventId]) {
            console.log(`[Flee] Attaque ${eventId} déjà traitée/programmée`);
            return;
        }

        const fleeState = loadFleeState();
        if (fleeState[targetKey] && fleeState[targetKey].active) {
            console.log(`[Flee] Repli déjà en cours pour ${targetKey}`);
            return;
        }

        const scheduledFlee = loadScheduledFlee();
        if (scheduledFlee[targetKey] && scheduledFlee[targetKey].triggerTime > Date.now()) {
            console.log(`[Flee] Repli déjà programmé pour ${targetKey}, déclenchement prévu à ${new Date(scheduledFlee[targetKey].triggerTime).toLocaleTimeString()}`);
            restoreFleeTimeout(targetKey, scheduledFlee[targetKey]);
            return;
        }

        const delayBeforeImpact = CONFIG.fleeConfig.delayBeforeImpact || 30;
        const secondsUntilFlee = secondsUntilImpact - delayBeforeImpact;

        console.log(`[Flee] === PROGRAMMATION REPLI ===`);
        console.log(`[Flee] Cible: ${targetKey}`);
        console.log(`[Flee] Impact dans: ${secondsUntilImpact}s (${Math.floor(secondsUntilImpact/60)}m ${secondsUntilImpact%60}s)`);
        console.log(`[Flee] Délai config: ${delayBeforeImpact}s avant impact`);
        console.log(`[Flee] Déclenchement dans: ${secondsUntilFlee}s (${Math.floor(secondsUntilFlee/60)}m ${secondsUntilFlee%60}s)`);

        if (secondsUntilFlee <= 0) {
            console.log(`[Flee] Pas assez de temps pour ${targetKey}, déclenchement immédiat !`);
            processedAttacks[eventId] = { targetKey, timestamp: Date.now() };
            saveProcessedAttacks(processedAttacks);
            executeFlee(targetKey, eventId, attackInfo);
            return;
        }

        const triggerTime = Date.now() + (secondsUntilFlee * 1000);

        scheduledFlee[targetKey] = {
            eventId,
            triggerTime,
            attackInfo,
            destination
        };
        saveScheduledFlee(scheduledFlee);

        processedAttacks[eventId] = { targetKey, timestamp: Date.now(), scheduled: true };
        saveProcessedAttacks(processedAttacks);

        console.log(`[Flee] ✓ Programmé ! Déclenchement à ${new Date(triggerTime).toLocaleTimeString()}`);

        notifyDiscord(`🏃 **REPLI PROGRAMMÉ** pour ${targetKey}\n⏱️ Impact dans ${Math.floor(secondsUntilImpact / 60)}m ${secondsUntilImpact % 60}s\n🎯 Déclenchement dans ${Math.floor(secondsUntilFlee / 60)}m ${secondsUntilFlee % 60}s (à ${new Date(triggerTime).toLocaleTimeString()})\n📍 Attaque de ${attackInfo.playerName || 'inconnu'}`);

        if (scheduledFleeTimeouts[targetKey]) {
            clearTimeout(scheduledFleeTimeouts[targetKey]);
        }

        scheduledFleeTimeouts[targetKey] = setTimeout(() => {
            console.log(`[Flee] ⚡ AUTO-FLEE DÉCLENCHÉ pour ${targetKey} !`);
            delete scheduledFleeTimeouts[targetKey];

            const currentScheduled = loadScheduledFlee();
            delete currentScheduled[targetKey];
            saveScheduledFlee(currentScheduled);

            executeFlee(targetKey, eventId, attackInfo);
        }, secondsUntilFlee * 1000);

        showFleeScheduled(targetKey, triggerTime, attackInfo);
    }

    function restoreFleeTimeout(targetKey, scheduledData) {
        if (scheduledFleeTimeouts[targetKey]) {
            return;
        }

        const remaining = scheduledData.triggerTime - Date.now();
        if (remaining <= 0) {
            console.log(`[Flee] Timeout expiré pour ${targetKey}, déclenchement immédiat`);
            const scheduledFlee = loadScheduledFlee();
            delete scheduledFlee[targetKey];
            saveScheduledFlee(scheduledFlee);
            executeFlee(targetKey, scheduledData.eventId, scheduledData.attackInfo);
            return;
        }

        console.log(`[Flee] Restauration du timeout pour ${targetKey}, ${Math.round(remaining/1000)}s restantes`);

        scheduledFleeTimeouts[targetKey] = setTimeout(() => {
            console.log(`[Flee] AUTO-FLEE DÉCLENCHÉ pour ${targetKey} (restauré) !`);
            delete scheduledFleeTimeouts[targetKey];

            const currentScheduled = loadScheduledFlee();
            delete currentScheduled[targetKey];
            saveScheduledFlee(currentScheduled);

            executeFlee(targetKey, scheduledData.eventId, scheduledData.attackInfo);
        }, remaining);

        showFleeScheduled(targetKey, scheduledData.triggerTime, scheduledData.attackInfo);
    }

    function restoreAllScheduledFlee() {
        const scheduledFlee = loadScheduledFlee();
        Object.keys(scheduledFlee).forEach(targetKey => {
            const data = scheduledFlee[targetKey];
            if (data && data.triggerTime) {
                restoreFleeTimeout(targetKey, data);
            }
        });
    }

    function cancelScheduledFlee(targetKey) {
        if (scheduledFleeTimeouts[targetKey]) {
            clearTimeout(scheduledFleeTimeouts[targetKey]);
            delete scheduledFleeTimeouts[targetKey];
        }

        const scheduledFlee = loadScheduledFlee();
        const eventId = scheduledFlee[targetKey]?.eventId;
        delete scheduledFlee[targetKey];
        saveScheduledFlee(scheduledFlee);

        if (eventId) {
            const processedAttacks = loadProcessedAttacks();
            delete processedAttacks[eventId];
            saveProcessedAttacks(processedAttacks);
        }

        console.log(`[Flee] Repli annulé pour ${targetKey}`);
    }

    function showFleeScheduled(targetKey, triggerTime, attackInfo) {
        let container = document.getElementById('ogame-plugin-flee-scheduled-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'ogame-plugin-flee-scheduled-container';
            container.style.cssText = `
                position: fixed;
                top: 50px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 10003;
                display: flex;
                flex-direction: column;
                gap: 5px;
            `;
            document.body.appendChild(container);
        }

        const statusId = `ogame-plugin-flee-scheduled-${targetKey.replace(/[:.]/g, '-')}`;
        let status = document.getElementById(statusId);

        if (!status) {
            status = document.createElement('div');
            status.id = statusId;
            status.dataset.targetKey = targetKey;
            status.style.cssText = `
                background: linear-gradient(180deg, #1a4a3a 0%, #0d291f 100%);
                border: 2px solid #3c6a5a;
                border-radius: 8px;
                padding: 8px 15px;
                color: #9fd6c3;
                font-family: Verdana, Arial, sans-serif;
                font-size: 11px;
                font-weight: bold;
                text-align: center;
            `;
            container.appendChild(status);
        }

        status.dataset.triggerTime = triggerTime.toString();

        function updateDisplay() {
            const currentTriggerTime = parseInt(status.dataset.triggerTime);
            const scheduledFlee = loadScheduledFlee();

            if (!currentTriggerTime || !scheduledFlee[targetKey]) {
                status.remove();
                if (container.children.length === 0) {
                    container.remove();
                }
                return;
            }

            const remaining = Math.max(0, Math.floor((currentTriggerTime - Date.now()) / 1000));
            const min = Math.floor(remaining / 60);
            const sec = remaining % 60;
            const keyParts = parseBodyKey(targetKey);
            const icon = keyParts?.type === 'moon' ? '🌙' : '🌍';

            status.innerHTML = `🏃 ${icon} [${keyParts?.coords}] Repli dans <span style="color: #6fcfaf;">${min}:${sec.toString().padStart(2, '0')}</span> <button class="cancel-flee-btn" data-key="${targetKey}" style="margin-left: 8px; padding: 2px 6px; cursor: pointer; font-size: 10px;">❌</button>`;

            const cancelBtn = status.querySelector('.cancel-flee-btn');
            if (cancelBtn) {
                cancelBtn.onclick = (e) => {
                    e.stopPropagation();
                    cancelScheduledFlee(targetKey);
                    status.remove();
                    if (container.children.length === 0) {
                        container.remove();
                    }
                    notifyDiscord(`❌ **REPLI ANNULÉ** manuellement pour ${targetKey}`);
                };
            }

            if (remaining > 0) {
                setTimeout(updateDisplay, 1000);
            }
        }

        updateDisplay();
    }

    function executeFlee(targetKey, eventId, attackInfo) {
        const destination = CONFIG.fleeConfig.destinations[targetKey];
        if (!destination) {
            console.log(`[Flee] Pas de destination configurée pour ${targetKey}`);
            return;
        }

        const keyParts = parseBodyKey(targetKey);
        if (!keyParts) {
            console.log(`[Flee] Clé invalide: ${targetKey}`);
            return;
        }

        const bodies = getAllCelestialBodies();
        const sourceBody = bodies.find(b => b.type === keyParts.type && b.coords === keyParts.coords);
        if (!sourceBody) {
            console.log(`[Flee] Corps source non trouvé: ${targetKey}`);
            return;
        }

        console.log(`[Flee] === EXÉCUTION REPLI ===`);
        console.log(`[Flee] Source: ${targetKey} (id: ${sourceBody.id})`);
        console.log(`[Flee] Destination: ${destination.type} [${destination.coords}]`);

        notifyDiscord(`🏃 **REPLI DÉCLENCHÉ** pour ${targetKey}\n➡️ Destination: ${destination.type === 'moon' ? '🌙 Lune' : '🌍 Planète'} [${destination.coords}]`);

        const state = {
            active: true,
            step: 'go_to_source',
            sourceId: sourceBody.id,
            sourceType: sourceBody.type,
            sourceCoords: sourceBody.coords,
            destinationType: destination.type,
            destinationCoords: destination.coords,
            speed: CONFIG.fleeConfig.speed || 10,
            eventId,
            targetKey
        };

        const fleeState = loadFleeState();
        fleeState[targetKey] = state;
        saveFleeState(fleeState);

        goToCelestialBody(sourceBody.id, sourceBody.type);
    }

    async function processFleeState() {
        const fleeState = loadFleeState();
        const activeFleeKeys = Object.keys(fleeState).filter(k => fleeState[k] && fleeState[k].active);

        if (activeFleeKeys.length === 0) return false;

        const currentKey = activeFleeKeys[0];
        const state = fleeState[currentKey];

        console.log('[Flee] Étape:', state.step);

        const currentId = getCurrentPlanetId();
        const currentType = getCurrentPlanetType();
        const currentPage = getCurrentPage();

        switch (state.step) {
            case 'go_to_source':
                const isOnCorrectSource = currentId === state.sourceId && currentType === state.sourceType;
                const isOnFleetPage = currentPage === 'fleetdispatch';

                if (isOnCorrectSource && isOnFleetPage) {
                    console.log('[Flee] Déjà sur la bonne source et page flotte');
                    state.step = 'select_all_ships';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    await wait(300);
                    processFleeState();
                } else if (isOnCorrectSource && !isOnFleetPage) {
                    console.log('[Flee] Sur la bonne source, passage à flotte');
                    state.step = 'go_to_fleet';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    goToFleetPage();
                } else {
                    console.log('[Flee] Navigation vers la source');
                    goToCelestialBody(state.sourceId, state.sourceType);
                }
                break;

            case 'go_to_fleet':
                if (currentPage === 'fleetdispatch') {
                    state.step = 'select_all_ships';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    await wait(300);
                    processFleeState();
                } else {
                    goToFleetPage();
                }
                break;

            case 'select_all_ships':
                try {
                    await wait(500);
                    const sendAllBtn = await waitForElement('#sendall', 5000);
                    sendAllBtn.click();
                    console.log('[Flee] Tous les vaisseaux sélectionnés');
                    state.step = 'press_continue';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    await wait(300);
                    processFleeState();
                } catch (e) {
                    console.log('[Flee] Bouton sendall non trouvé');
                    showFleeStatus(`Erreur: aucun vaisseau sur ${currentKey}`, true);
                    delete fleeState[currentKey];
                    saveFleeState(fleeState);
                }
                break;

            case 'press_continue':
                try {
                    await wait(300);
                    const continueBtn = await waitForElement('#continueToFleet2.on', 5000);
                    continueBtn.click();
                    console.log('[Flee] Continuer cliqué');
                    state.step = 'select_destination';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    await wait(800);
                    processFleeState();
                } catch (e) {
                    console.log('[Flee] Bouton Continuer non disponible');
                    showFleeStatus(`Erreur: aucun vaisseau disponible sur ${currentKey}`, true);
                    delete fleeState[currentKey];
                    saveFleeState(fleeState);
                }
                break;

            case 'select_destination':
                try {
                    await wait(500);

                    const coords = state.destinationCoords;
                    const isMoon = state.destinationType === 'moon';
                    const targetType = isMoon ? '3' : '1';

                    console.log(`[Flee] Recherche destination: ${coords} (type: ${targetType}, ${state.destinationType})`);

                    const slbox = document.getElementById('slbox');
                    if (slbox) {
                        const coordsFormatted = coords.replace(/:/g, '#');
                        const searchPattern = `${coordsFormatted}#${targetType}`;

                        console.log(`[Flee] Pattern recherché: ${searchPattern}`);

                        let found = false;
                        for (const option of slbox.options) {
                            console.log(`[Flee] Option: ${option.value}`);
                            if (option.value.includes(searchPattern)) {
                                console.log(`[Flee] ✓ Trouvé ! Sélection de: ${option.value}`);
                                slbox.value = option.value;
                                slbox.dispatchEvent(new Event('change', { bubbles: true }));
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            console.log('[Flee] Destination non trouvée dans le select, saisie manuelle...');
                            await selectDestinationManual(state);
                        }
                    } else {
                        console.log('[Flee] Select #slbox non trouvé, saisie manuelle...');
                        await selectDestinationManual(state);
                    }

                    state.step = 'set_speed';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    await wait(500);
                    processFleeState();
                } catch (e) {
                    console.log('[Flee] Erreur sélection destination:', e);
                    showFleeStatus('Erreur: destination invalide', true);
                    delete fleeState[currentKey];
                    saveFleeState(fleeState);
                }
                break;

            case 'load_all_resources':
                try {
                    await wait(300);
                    const loadAllBtn = document.getElementById('allresources');
                    if (loadAllBtn) {
                        loadAllBtn.click();
                        console.log('[Flee] Ressources chargées');
                    }
                    state.step = 'select_mission';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    await wait(300);
                    processFleeState();
                } catch (e) {
                    state.step = 'select_mission';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    processFleeState();
                }
                break;

            case 'set_speed':
                try {
                    await wait(200);
                    const speedStep = Math.ceil(state.speed / 10);
                    const speedBtn = document.querySelector(`#speedPercentage .step[data-step="${speedStep}"]`);
                    if (speedBtn) {
                        speedBtn.click();
                        console.log('[Flee] Vitesse:', speedStep * 10, '%');
                    }
                    state.step = 'load_all_resources';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    await wait(300);
                    processFleeState();
                } catch (e) {
                    state.step = 'load_all_resources';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    processFleeState();
                }
                break;

            case 'select_mission':
                try {
                    await wait(300);

                    const button4Li = document.querySelector('#button4.on');
                    if (button4Li) {
                        const missionBtn = button4Li.querySelector('a#missionButton4');
                        if (missionBtn) {
                            missionBtn.click();
                            console.log('[Flee] Mission Stationner sélectionnée');
                        }
                    } else {
                        console.log('[Flee] Mission Stationner non disponible');
                    }

                    state.step = 'send_fleet';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    await wait(500);
                    processFleeState();
                } catch (e) {
                    console.log('[Flee] Erreur sélection mission:', e);
                    state.step = 'send_fleet';
                    fleeState[currentKey] = state;
                    saveFleeState(fleeState);
                    processFleeState();
                }
                break;

            case 'send_fleet':
                try {
                    await wait(500);
                    const sendBtn = await waitForElement('#sendFleet.on', 5000);
                    sendBtn.click();
                    console.log('[Flee] Flotte envoyée !');

                    const destIcon = state.destinationType === 'moon' ? '🌙' : '🌍';
                    notifyDiscord(`✅ **REPLI RÉUSSI** pour ${currentKey}\n➡️ Flotte + ressources envoyées vers ${destIcon} [${state.destinationCoords}]`);

                    showFleeStatus(`✅ Repli réussi pour ${currentKey} !`);
                    delete fleeState[currentKey];
                    saveFleeState(fleeState);
                } catch (e) {
                    console.log('[Flee] Erreur envoi:', e);
                    showFleeStatus(`Erreur: impossible d'envoyer depuis ${currentKey}`, true);
                    delete fleeState[currentKey];
                    saveFleeState(fleeState);
                }
                break;
        }

        return true;
    }

    async function selectDestinationManual(state) {
        const coordsParts = state.destinationCoords.split(':');
        const galaxy = coordsParts[0];
        const system = coordsParts[1];
        const position = coordsParts[2];

        console.log(`[Flee] Saisie manuelle: ${galaxy}:${system}:${position} (${state.destinationType})`);

        const galaxyInput = document.getElementById('galaxy');
        const systemInput = document.getElementById('system');
        const positionInput = document.getElementById('position');

        if (galaxyInput) {
            galaxyInput.value = galaxy;
            galaxyInput.dispatchEvent(new Event('change', { bubbles: true }));
            galaxyInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await wait(100);

        if (systemInput) {
            systemInput.value = system;
            systemInput.dispatchEvent(new Event('change', { bubbles: true }));
            systemInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await wait(100);

        if (positionInput) {
            positionInput.value = position;
            positionInput.dispatchEvent(new Event('change', { bubbles: true }));
            positionInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await wait(200);

        const isMoon = state.destinationType === 'moon';
        if (isMoon) {
            const moonBtn = document.getElementById('mbutton');
            if (moonBtn) {
                moonBtn.click();
                console.log('[Flee] Bouton Lune cliqué');
            }
        } else {
            const planetBtn = document.getElementById('pbutton');
            if (planetBtn) {
                planetBtn.click();
                console.log('[Flee] Bouton Planète cliqué');
            }
        }
        await wait(200);
    }

    function showFleeStatus(message, isError = false) {
        const existingStatus = document.getElementById('ogame-plugin-flee-status');
        if (existingStatus) {
            existingStatus.remove();
        }

        const status = document.createElement('div');
        status.id = 'ogame-plugin-flee-status';
        status.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10002;
            background: ${isError ? '#3a1a1a' : '#1a3a2a'};
            border: 2px solid ${isError ? '#6a3a3a' : '#3a6a4a'};
            border-radius: 8px;
            padding: 20px 30px;
            color: ${isError ? '#ff9f9f' : '#9fffaf'};
            font-family: Verdana, Arial, sans-serif;
            font-size: 14px;
            font-weight: bold;
            text-align: center;
        `;
        status.textContent = message;
        document.body.appendChild(status);

        setTimeout(() => {
            status.remove();
        }, 5000);
    }

    function cleanupOldAttacks() {
        const processedAttacks = loadProcessedAttacks();
        const currentEventIds = new Set();

        const eventRows = document.querySelectorAll('#eventContent tr.eventFleet');
        eventRows.forEach(row => {
            currentEventIds.add(row.id);
        });

        let changed = false;
        Object.keys(processedAttacks).forEach(eventId => {
            if (!currentEventIds.has(eventId)) {
                console.log(`[Flee] Attaque ${eventId} terminée, nettoyage`);
                delete processedAttacks[eventId];
                changed = true;
            }
        });

        if (changed) {
            saveProcessedAttacks(processedAttacks);
        }

        const scheduledFlee = loadScheduledFlee();
        Object.keys(scheduledFlee).forEach(targetKey => {
            const data = scheduledFlee[targetKey];
            if (data && data.eventId && !currentEventIds.has(data.eventId)) {
                console.log(`[Flee] Repli programmé obsolète pour ${targetKey}, nettoyage`);
                cancelScheduledFlee(targetKey);
            }
        });
    }

    let CONFIG = loadConfig();

    function waitForEventContent(timeout = 10000) {
        return new Promise((resolve) => {
            const startTime = Date.now();

            const check = () => {
                const eventList = document.querySelector('#eventlistcomponent');
                const eventContent = document.querySelector('#eventContent');

                if (eventList && eventContent && eventContent.children.length > 0) {
                    resolve(eventContent);
                    return;
                }

                if (eventList && eventContent && eventContent.textContent.includes('Pas de mouvement')) {
                    resolve(eventContent);
                    return;
                }

                if (Date.now() - startTime > timeout) {
                    console.log('[Monitor] Timeout: eventContent non chargé, on continue quand même');
                    resolve(null);
                    return;
                }

                setTimeout(check, 200);
            };

            check();
        });
    }

    function hasVisibleEnemyFleet() {
        const eventRows = document.querySelectorAll('#eventContent tr.eventFleet');

        for (const row of eventRows) {
            const missionImg = row.querySelector('.missionFleet img[data-tooltip-title]');
            if (!missionImg) continue;

            const tooltipTitle = missionImg.getAttribute('data-tooltip-title');
            if (!tooltipTitle) continue;

            if (tooltipTitle.includes('Propre flotte')) continue;

            if (tooltipTitle.includes('Attaquer') || tooltipTitle.includes('Espionner')) {
                return true;
            }
        }

        return false;
    }

    function checkEnemyNotification() {
        const notificationBar = document.getElementById('notificationbarcomponent');
        if (!notificationBar) return;

        const notificationText = notificationBar.textContent || '';
        const enemyMatch = notificationText.match(/(\d+)\s*ennemi/i);

        if (enemyMatch) {
            const enemyCount = parseInt(enemyMatch[1]);
            console.log(`[Monitor] ${enemyCount} ennemi(s) détecté(s) dans la barre de notification`);

            if (!hasVisibleEnemyFleet()) {
                console.log('[Monitor] Aucune flotte ennemie visible, rafraîchissement de la page...');

                notifyDiscord(`⚠️ **${enemyCount} ennemi(s) détecté(s)** - Rafraîchissement en cours pour obtenir les détails...`);

                setTimeout(() => {
                    window.location.reload();
                }, 500);
            }
        }
    }

    function getPlanets() {
        const planets = [];
        const planetElements = document.querySelectorAll('.smallplanet[id^="planet-"]');

        planetElements.forEach(el => {
            const planetLink = el.querySelector('a.planetlink');
            if (!planetLink) return;

            const nameEl = planetLink.querySelector('.planet-name');
            const coordsEl = planetLink.querySelector('.planet-koords');

            if (nameEl && coordsEl) {
                const name = nameEl.textContent.trim();
                const coords = coordsEl.textContent.trim().replace(/[\[\]]/g, '');
                const id = el.id.replace('planet-', '');
                const href = planetLink.getAttribute('href');

                planets.push({ id, name, coords, href, type: 'planet' });
            }
        });

        return planets;
    }

    function getMoons() {
        const moons = [];
        const planetElements = document.querySelectorAll('.smallplanet[id^="planet-"]');

        planetElements.forEach(el => {
            const moonLink = el.querySelector('a.moonlink');
            if (!moonLink) return;

            const href = moonLink.getAttribute('href');
            const match = href.match(/cp=(\d+)/);
            if (!match) return;

            const moonId = match[1];
            const planetLink = el.querySelector('a.planetlink');
            const coordsEl = planetLink?.querySelector('.planet-koords');

            if (coordsEl) {
                const coords = coordsEl.textContent.trim().replace(/[\[\]]/g, '');
                moons.push({ id: moonId, name: 'Lune', coords, href, type: 'moon' });
            }
        });

        return moons;
    }

    function getAllCelestialBodies() {
        const planets = getPlanets();
        const moons = getMoons();
        return [...planets, ...moons];
    }

    function isInExpeditionTimeSlot() {
        const startHour = CONFIG.expeditionStartHour;
        const endHour = CONFIG.expeditionEndHour;

        if (startHour === null && endHour === null) {
            return true;
        }

        const now = new Date();
        const currentHour = now.getHours();
        const currentMinutes = now.getMinutes();
        const currentTime = currentHour + (currentMinutes / 60);

        const start = startHour !== null ? startHour : 0;
        const end = endHour !== null ? endHour : 24;

        if (start <= end) {
            return currentTime >= start && currentTime < end;
        }

        return currentTime >= start || currentTime < end;
    }

    function getBodyKey(type, coords) {
        return `${type}_${coords}`;
    }

    function parseBodyKey(key) {
        const match = key.match(/^(planet|moon)_(.+)$/);
        if (match) {
            return { type: match[1], coords: match[2] };
        }
        return null;
    }

    function getActiveExpeditions() {
        const expeditions = {};
        const eventRows = document.querySelectorAll('#eventContent tr.eventFleet[data-mission-type="15"]');

        eventRows.forEach(row => {
            const missionImg = row.querySelector('.missionFleet img[data-tooltip-title]');
            if (!missionImg) return;

            const tooltipTitle = missionImg.getAttribute('data-tooltip-title');
            if (!tooltipTitle || !tooltipTitle.includes('Expédition (R)')) return;

            const countdownEl = row.querySelector('.countDown span');
            if (countdownEl && countdownEl.textContent.trim().toLowerCase() === 'terminé') {
                return;
            }

            const coordsOriginEl = row.querySelector('.coordsOrigin a');
            if (!coordsOriginEl) return;

            const coordsText = coordsOriginEl.textContent.trim().replace(/[\[\]]/g, '');

            const originFleetEl = row.querySelector('.originFleet');
            let isMoon = false;
            if (originFleetEl) {
                const figureEl = originFleetEl.querySelector('figure');
                if (figureEl && figureEl.classList.contains('moon')) {
                    isMoon = true;
                }
                if (!isMoon && originFleetEl.innerHTML.toLowerCase().includes('lune')) {
                    isMoon = true;
                }
            }

            const key = getBodyKey(isMoon ? 'moon' : 'planet', coordsText);

            if (!expeditions[key]) {
                expeditions[key] = 0;
            }
            expeditions[key]++;
        });

        return expeditions;
    }

    function getFinishedExpeditions() {
        const finished = {};
        const eventRows = document.querySelectorAll('#eventContent tr.eventFleet[data-mission-type="15"]');

        eventRows.forEach(row => {
            const missionImg = row.querySelector('.missionFleet img[data-tooltip-title]');
            if (!missionImg) return;

            const tooltipTitle = missionImg.getAttribute('data-tooltip-title');
            if (!tooltipTitle || !tooltipTitle.includes('Expédition (R)')) return;

            const countdownEl = row.querySelector('.countDown span');
            if (countdownEl && countdownEl.textContent.trim().toLowerCase() === 'terminé') {
                const coordsOriginEl = row.querySelector('.coordsOrigin a');
                if (!coordsOriginEl) return;

                const coordsText = coordsOriginEl.textContent.trim().replace(/[\[\]]/g, '');

                const originFleetEl = row.querySelector('.originFleet');
                let isMoon = false;
                if (originFleetEl) {
                    const figureEl = originFleetEl.querySelector('figure');
                    if (figureEl && figureEl.classList.contains('moon')) {
                        isMoon = true;
                    }
                    if (!isMoon && originFleetEl.innerHTML.toLowerCase().includes('lune')) {
                        isMoon = true;
                    }
                }

                const key = getBodyKey(isMoon ? 'moon' : 'planet', coordsText);

                if (!finished[key]) {
                    finished[key] = 0;
                }
                finished[key]++;
            }
        });

        return finished;
    }

    function getTotalFinishedExpeditions() {
        const finished = getFinishedExpeditions();
        let total = 0;
        Object.values(finished).forEach(count => {
            total += count;
        });
        return total;
    }

    function getExpeditionsSummary() {
        const bodies = getAllCelestialBodies();
        const activeExpeditions = getActiveExpeditions();
        const summary = [];

        bodies.forEach(body => {
            const key = getBodyKey(body.type, body.coords);
            const expected = CONFIG.expeditionsPerBody[key] || 0;
            const active = activeExpeditions[key] || 0;
            const missing = Math.max(0, expected - active);

            summary.push({
                ...body,
                key,
                expected,
                active,
                missing
            });
        });

        return summary;
    }

    function getTotalExpectedExpeditions() {
        let total = 0;
        const bodies = getAllCelestialBodies();

        bodies.forEach(body => {
            const key = getBodyKey(body.type, body.coords);
            const count = CONFIG.expeditionsPerBody[key] || 0;
            total += count;
        });

        return total;
    }

    function getTotalActiveExpeditions() {
        const activeExpeditions = getActiveExpeditions();
        let total = 0;
        Object.values(activeExpeditions).forEach(count => {
            total += count;
        });
        return total;
    }

    function getTotalMissingExpeditions() {
        const summary = getExpeditionsSummary();
        let total = 0;
        summary.forEach(body => {
            total += body.missing;
        });
        return total;
    }

    function getCurrentPlanetId() {
        const meta = document.querySelector('meta[name="ogame-planet-id"]');
        if (meta) {
            return meta.getAttribute('content');
        }
        return null;
    }

    function getCurrentPlanetCoords() {
        const coordsEl = document.querySelector('meta[name="ogame-planet-coordinates"]');
        if (coordsEl) {
            return coordsEl.getAttribute('content');
        }
        return null;
    }

    function getCurrentPlanetType() {
        const meta = document.querySelector('meta[name="ogame-planet-type"]');
        if (meta) {
            return meta.getAttribute('content') === 'moon' ? 'moon' : 'planet';
        }
        return 'planet';
    }

    function getCurrentPage() {
        const url = new URL(window.location.href);
        return url.searchParams.get('component') || url.searchParams.get('page');
    }

    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();

            const check = () => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                    return;
                }

                if (Date.now() - startTime > timeout) {
                    reject(new Error(`Element ${selector} not found after ${timeout}ms`));
                    return;
                }

                setTimeout(check, 200);
            };

            check();
        });
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    const FLEET_TEMPLATES_KEY = 'ogame_plugin_fleet_templates';

    // Mémorise les noms des flottes d'expédition enregistrées (liste du panneau ⚙️ → Expéditions)
    function rememberFleetTemplates() {
        const select = document.getElementById('expeditionFleetTemplateSelect');
        if (!select) return;
        const names = [...select.options]
            .filter(o => o.value && o.value !== '0')
            .map(o => o.textContent.trim())
            .filter(Boolean);
        localStorage.setItem(FLEET_TEMPLATES_KEY, JSON.stringify(names));
    }

    function loadFleetTemplates() {
        try {
            return JSON.parse(localStorage.getItem(FLEET_TEMPLATES_KEY)) || [];
        } catch (e) {
            return [];
        }
    }

    // Page Flotte, étape 1 : sélectionne la flotte d'expédition enregistrée `name` (liste « Flotte d'expédition »)
    async function selectExpeditionFleetTemplate(name) {
        if (!name) throw new Error('aucune flotte enregistrée choisie (⚙️ → Expéditions)');
        const select = await waitForElement('#expeditionFleetTemplateSelect', 5000);
        const wanted = name.trim().toLowerCase();
        const option = [...select.options].find(o => o.value !== '0' && o.textContent.trim().toLowerCase() === wanted);
        if (!option) throw new Error(`flotte enregistrée « ${name} » introuvable`);

        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(800);

        // Repli : fonction OGame appelée par le lien de la liste des flottes d'expédition
        if (!document.querySelector('#continueToFleet2.on')) {
            const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            if (typeof page.selectShipsPerFleet === 'function') {
                page.selectShipsPerFleet(String(option.value));
                await wait(800);
            }
        }
        if (!document.querySelector('#continueToFleet2.on')) {
            throw new Error(`« ${name} » : aucun vaisseau sélectionné (vaisseaux absents sur cette planète ?)`);
        }
        return option.textContent.trim();
    }

    // Page Flotte, étape 2 : destination position 16 du système courant, puis mission Expédition
    async function setExpeditionTarget() {
        const position = await waitForElement('#position', 5000);
        if (position.value !== '16') {
            position.value = '16';
            ['input', 'change', 'keyup'].forEach(type => {
                const event = type === 'keyup' ? new KeyboardEvent('keyup', { bubbles: true }) : new Event(type, { bubbles: true });
                position.dispatchEvent(event);
            });
        }
        const missionLi = await waitForElement('#button15.on', 5000)
            .catch(() => { throw new Error('mission Expédition indisponible (position 16)'); });
        await wait(300);
        (missionLi.querySelector('#missionButton15') || missionLi).click();
        await wait(500);
    }

    function pressKey(key) {
        const event = new KeyboardEvent('keydown', {
            key: key,
            code: `Key${key.toUpperCase()}`,
            keyCode: key.toUpperCase().charCodeAt(0),
            which: key.toUpperCase().charCodeAt(0),
            bubbles: true
        });
        document.dispatchEvent(event);
    }

    function goToPlanet(planetId) {
        const planetLink = document.querySelector(`#planet-${planetId} a.planetlink`);
        if (planetLink) {
            planetLink.click();
            return true;
        }
        return false;
    }

    function goToMoon(moonId) {
        const moonLink = document.querySelector(`a.moonlink[href*="cp=${moonId}"]`);
        if (moonLink) {
            moonLink.click();
            return true;
        }
        return false;
    }

    function goToCelestialBody(id, type) {
        if (type === 'moon') {
            return goToMoon(id);
        }
        return goToPlanet(id);
    }

    function goToFleetPage() {
        const fleetLink = document.querySelector('a.menubutton[href*="component=fleetdispatch"]');
        if (fleetLink) {
            fleetLink.click();
            return true;
        }
        return false;
    }

    async function processPanicState() {
        const state = loadPanicState();
        if (!state || !state.active) return;

        console.log('[Panic] État:', state);

        const currentId = getCurrentPlanetId();
        const currentType = getCurrentPlanetType();
        const currentPage = getCurrentPage();

        switch (state.step) {
            case 'go_to_source':
                const isOnCorrectSource = currentId === state.sourceId && currentType === state.sourceType;
                const isOnFleetPage = currentPage === 'fleetdispatch';

                if (isOnCorrectSource && isOnFleetPage) {
                    console.log('[Panic] Déjà sur la bonne source et page flotte');
                    savePanicState({ ...state, step: 'select_all_ships' });
                    processPanicState();
                } else if (isOnCorrectSource && !isOnFleetPage) {
                    console.log('[Panic] Sur la bonne source, passage à flotte');
                    savePanicState({ ...state, step: 'go_to_fleet' });
                    goToFleetPage();
                } else {
                    console.log('[Panic] Navigation vers la source');
                    goToCelestialBody(state.sourceId, state.sourceType);
                }
                break;

            case 'go_to_fleet':
                if (currentPage === 'fleetdispatch') {
                    savePanicState({ ...state, step: 'select_all_ships' });
                    processPanicState();
                } else {
                    goToFleetPage();
                }
                break;

            case 'select_all_ships':
                try {
                    const sendAllBtn = await waitForElement('#sendall', 3000);
                    sendAllBtn.click();
                    console.log('[Panic] Tous les vaisseaux sélectionnés');
                    savePanicState({ ...state, step: 'press_continue' });
                    await wait(150);
                    processPanicState();
                } catch (e) {
                    console.log('[Panic] Bouton sendall non trouvé');
                    showPanicStatus('Erreur: bouton sendall non disponible', true);
                    clearPanicState();
                }
                break;

            case 'press_continue':
                try {
                    const continueBtn = await waitForElement('#continueToFleet2.on', 3000);
                    continueBtn.click();
                    console.log('[Panic] Continuer cliqué');
                    savePanicState({ ...state, step: 'select_destination' });
                    await wait(300);
                    processPanicState();
                } catch (e) {
                    console.log('[Panic] Bouton Continuer non disponible');
                    showPanicStatus('Erreur: aucun vaisseau disponible', true);
                    clearPanicState();
                }
                break;

            case 'select_destination':
                try {
                    const destBody = getAllCelestialBodies().find(b => b.id === state.destinationId && b.type === state.destinationType);
                    if (!destBody) {
                        throw new Error('Destination non trouvée');
                    }

                    const coordsParts = destBody.coords.split(':');
                    const galaxy = coordsParts[0];
                    const system = coordsParts[1];
                    const position = coordsParts[2];

                    console.log('[Panic] Destination:', destBody.coords, state.destinationType);

                    const galaxyInput = document.getElementById('galaxy');
                    const systemInput = document.getElementById('system');
                    const positionInput = document.getElementById('position');

                    function setInputValue(input, value) {
                        if (!input) return;
                        input.value = value;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                    }

                    setInputValue(galaxyInput, galaxy);
                    setInputValue(systemInput, system);
                    setInputValue(positionInput, position);

                    await wait(100);

                    const targetValue = state.destinationType === 'moon' ? '3' : '1';
                    const allTargetBtns = document.querySelectorAll('a[data-value]');
                    allTargetBtns.forEach(btn => {
                        if (btn.getAttribute('data-value') === targetValue) {
                            btn.click();
                        }
                    });

                    savePanicState({ ...state, step: 'load_all_resources' });
                    await wait(100);
                    processPanicState();
                } catch (e) {
                    console.log('[Panic] Erreur sélection destination:', e);
                    showPanicStatus('Erreur: destination invalide', true);
                    clearPanicState();
                }
                break;

            case 'load_all_resources':
                try {
                    const loadAllBtn = document.querySelector('#allresources') ||
                          document.querySelector('#loadAllResources a');
                    if (loadAllBtn) {
                        loadAllBtn.click();
                        console.log('[Panic] Ressources chargées');
                    }
                    savePanicState({ ...state, step: 'set_speed' });
                    await wait(100);
                    processPanicState();
                } catch (e) {
                    savePanicState({ ...state, step: 'set_speed' });
                    processPanicState();
                }
                break;

            case 'set_speed':
                try {
                    const speedStep = Math.ceil(state.speed / 10);
                    const speedBtn = document.querySelector(`#speedPercentage .step[data-step="${speedStep}"]`) ||
                          document.querySelector(`.step[data-step="${speedStep}"]`);
                    if (speedBtn) {
                        speedBtn.click();
                        console.log('[Panic] Vitesse:', speedStep * 10, '%');
                    }
                    savePanicState({ ...state, step: 'select_mission' });
                    await wait(100);
                    processPanicState();
                } catch (e) {
                    savePanicState({ ...state, step: 'select_mission' });
                    processPanicState();
                }
                break;

            case 'select_mission':
                try {
                    const stationnerBtn = document.querySelector('#button4') ||
                          document.querySelector('a[data-mission="4"]');
                    if (stationnerBtn) {
                        stationnerBtn.click();
                        console.log('[Panic] Mission Stationner');
                    }
                    savePanicState({ ...state, step: 'send_fleet' });
                    await wait(100);
                    processPanicState();
                } catch (e) {
                    savePanicState({ ...state, step: 'send_fleet' });
                    processPanicState();
                }
                break;

            case 'send_fleet':
                try {
                    const sendBtn = await waitForElement('#sendFleet.on', 3000);
                    sendBtn.click();
                    console.log('[Panic] Flotte envoyée !');

                    notifyDiscord(`🚨 **PANIC EXÉCUTÉ** - Flotte + ressources envoyées !`);

                    showPanicStatus('✅ Flotte envoyée avec succès !');
                    clearPanicState();
                } catch (e) {
                    console.log('[Panic] Erreur envoi:', e);
                    showPanicStatus('Erreur: impossible d\'envoyer', true);
                    clearPanicState();
                }
                break;
        }
    }
    function showPanicStatus(message, isError = false) {
        const existingStatus = document.getElementById('ogame-plugin-panic-status');
        if (existingStatus) {
            existingStatus.remove();
        }

        const status = document.createElement('div');
        status.id = 'ogame-plugin-panic-status';
        status.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10002;
            background: ${isError ? '#3a1a1a' : '#1a2a3a'};
            border: 2px solid ${isError ? '#6a3a3a' : '#3a5a6a'};
            border-radius: 8px;
            padding: 20px 30px;
            color: ${isError ? '#ff9f9f' : '#9fd6ff'};
            font-family: Verdana, Arial, sans-serif;
            font-size: 14px;
            font-weight: bold;
            text-align: center;
        `;
        status.textContent = message;
        document.body.appendChild(status);

        setTimeout(() => {
            status.remove();
        }, 5000);
    }

    function executePanic() {
        const panicConfig = CONFIG.panic;

        if (!panicConfig.sourceId || !panicConfig.destinationId) {
            alert('Configuration Panic incomplète ! Veuillez configurer la source et la destination.');
            return;
        }

        console.log('[Panic] DÉCLENCHEMENT IMMÉDIAT');

        notifyDiscord(`🚨 **PANIC DÉCLENCHÉ** - Envoi de la flotte en cours...`);

        const state = {
            active: true,
            step: 'go_to_source',
            sourceId: panicConfig.sourceId,
            sourceType: panicConfig.sourceType,
            destinationId: panicConfig.destinationId,
            destinationType: panicConfig.destinationType,
            speed: panicConfig.speed,
        };

        savePanicState(state);
        goToCelestialBody(panicConfig.sourceId, panicConfig.sourceType);
    }

    async function processLaunchState() {
        const state = loadLaunchState();
        if (!state || !state.active) return;

        console.log('[Monitor] État de lancement:', state);

        const currentCoords = getCurrentPlanetCoords();
        const currentType = getCurrentPlanetType();
        const currentPage = getCurrentPage();

        await wait(1500);

        switch (state.step) {
            case 'go_to_body':
                const isOnCorrectBody = currentCoords === state.currentBody.coords && currentType === state.currentBody.type;
                if (isOnCorrectBody) {
                    console.log('[Monitor] Sur le bon corps céleste, passage à l\'étape flotte');
                    saveLaunchState({ ...state, step: 'go_to_fleet' });
                    goToFleetPage();
                } else {
                    console.log('[Monitor] Navigation vers', state.currentBody.type, state.currentBody.coords);
                    goToCelestialBody(state.currentBody.id, state.currentBody.type);
                }
                break;

            case 'go_to_fleet':
                if (currentPage === 'fleetdispatch') {
                    await wait(1000);
                    if (CONFIG.expeditionMode === 'template') {
                        try {
                            const template = await selectExpeditionFleetTemplate(CONFIG.expeditionTemplate);
                            console.log(`[Monitor] Flotte enregistrée « ${template} » sélectionnée`);
                        } catch (e) {
                            console.log('[Monitor] Flotte enregistrée non sélectionnée:', e.message);
                            showLaunchStatus(`Erreur: ${e.message}`, true);
                            notifyDiscord(`⚠️ **Expédition annulée** : ${e.message}`);
                            clearLaunchState();
                            break;
                        }
                    } else {
                        const expeditionKey = CONFIG.expeditionKey === 's' ? 's' : 'l';
                        console.log(`[Monitor] Sur la page flotte, appui sur ${expeditionKey.toUpperCase()}`);
                        pressKey(expeditionKey);
                    }
                    saveLaunchState({ ...state, step: 'press_continue' });
                    await wait(500);
                    processLaunchState();
                } else {
                    goToFleetPage();
                }
                break;

            case 'press_continue':
                try {
                    const continueBtn = await waitForElement('#continueToFleet2.on', 5000);
                    console.log('[Monitor] Clic sur Continuer');
                    await wait(500);
                    continueBtn.click();
                    // Une flotte enregistrée ne contient que les vaisseaux : destination (position 16) et mission à régler
                    saveLaunchState({ ...state, step: CONFIG.expeditionMode === 'template' ? 'set_expedition_target' : 'send_fleet' });
                    await wait(1000);
                    processLaunchState();
                } catch (e) {
                    console.log('[Monitor] Bouton Continuer non disponible, annulation');
                    showLaunchStatus('Erreur: bouton Continuer non disponible', true);
                    clearLaunchState();
                }
                break;

            case 'set_expedition_target':
                try {
                    await setExpeditionTarget();
                    console.log('[Monitor] Destination position 16 et mission Expédition réglées');
                    saveLaunchState({ ...state, step: 'send_fleet' });
                    await wait(800);
                    processLaunchState();
                } catch (e) {
                    console.log('[Monitor] Mission Expédition non disponible:', e.message);
                    showLaunchStatus(`Erreur: ${e.message}`, true);
                    clearLaunchState();
                }
                break;

            case 'send_fleet':
                try {
                    const sendBtn = await waitForElement('#sendFleet.on', 5000);
                    console.log('[Monitor] Clic sur Envoyer la flotte');
                    await wait(500);
                    sendBtn.click();

                    state.currentBody.launched = (state.currentBody.launched || 0) + 1;
                    state.totalLaunched = (state.totalLaunched || 0) + 1;

                    const bodyLabel = state.currentBody.type === 'moon' ? '🌙' : '🌍';
                    console.log(`[Monitor] Expédition ${state.currentBody.launched}/${state.currentBody.missing} lancée pour ${state.currentBody.coords} (${state.currentBody.type})`);

                    if (CONFIG.expeditionLaunchAlerts) notifyDiscord(`🚀 **Expédition lancée** depuis ${bodyLabel} [${state.currentBody.coords}] (${state.currentBody.launched}/${state.currentBody.missing})`);

                    if (state.currentBody.launched < state.currentBody.missing) {
                        saveLaunchState({ ...state, step: 'go_to_fleet' });
                        await wait(2000);
                        goToFleetPage();
                    } else {
                        const nextBodyIndex = state.bodies.findIndex(b => b.key === state.currentBody.key) + 1;
                        const nextBody = state.bodies.slice(nextBodyIndex).find(b => b.missing > 0);

                        if (nextBody) {
                            console.log('[Monitor] Passage au corps céleste suivant:', nextBody.type, nextBody.coords);
                            saveLaunchState({
                                ...state,
                                currentBody: { ...nextBody, launched: 0 },
                                step: 'go_to_body'
                            });
                            await wait(1500);
                            goToCelestialBody(nextBody.id, nextBody.type);
                        } else {
                            console.log('[Monitor] Toutes les expéditions ont été lancées !');
                            showLaunchStatus(`✅ ${state.totalLaunched} expédition(s) lancée(s) avec succès !`);
                            clearLaunchState();
                        }
                    }
                } catch (e) {
                    console.log('[Monitor] Bouton Envoyer non disponible, annulation');
                    showLaunchStatus('Erreur: bouton Envoyer non disponible', true);
                    clearLaunchState();
                }
                break;

            case 'go_to_planet':
                const isOnCorrectPlanet = currentCoords === state.currentBody.coords && currentType === state.currentBody.type;
                if (isOnCorrectPlanet) {
                    console.log('[Monitor] Sur le bon corps céleste, passage à l\'étape flotte');
                    saveLaunchState({ ...state, step: 'go_to_fleet' });
                    goToFleetPage();
                } else {
                    console.log('[Monitor] Navigation vers', state.currentBody.type, state.currentBody.coords);
                    goToCelestialBody(state.currentBody.id, state.currentBody.type);
                }
                break;
        }
    }

    function showLaunchStatus(message, isError = false) {
        const existingStatus = document.getElementById('ogame-plugin-status');
        if (existingStatus) {
            existingStatus.remove();
        }

        const status = document.createElement('div');
        status.id = 'ogame-plugin-status';
        status.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10002;
            background: ${isError ? '#3a1a1a' : '#1a3a2a'};
            border: 2px solid ${isError ? '#6a3a3a' : '#3a6a4a'};
            border-radius: 8px;
            padding: 20px 30px;
            color: ${isError ? '#ff9f9f' : '#9fffaf'};
            font-family: Verdana, Arial, sans-serif;
            font-size: 14px;
            font-weight: bold;
            text-align: center;
        `;
        status.textContent = message;
        document.body.appendChild(status);

        setTimeout(() => {
            status.remove();
        }, 5000);
    }

    function showLaunchProgress() {
        const state = loadLaunchState();
        if (!state || !state.active) return;

        let existingProgress = document.getElementById('ogame-plugin-progress');
        if (!existingProgress) {
            existingProgress = document.createElement('div');
            existingProgress.id = 'ogame-plugin-progress';
            existingProgress.style.cssText = `
                position: fixed;
                bottom: 50px;
                left: 10px;
                z-index: 10002;
                background: linear-gradient(180deg, #1a2a3a 0%, #0d1520 100%);
                border: 2px solid #3c5a6a;
                border-radius: 8px;
                padding: 10px 15px;
                color: #9fc3d6;
                font-family: Verdana, Arial, sans-serif;
                font-size: 11px;
            `;
            document.body.appendChild(existingProgress);
        }

        const launched = state.totalLaunched || 0;
        const total = state.bodies.reduce((sum, b) => sum + b.missing, 0);
        const bodyLabel = state.currentBody.type === 'moon' ? '🌙 Lune' : '🌍 ' + state.currentBody.name;

        existingProgress.innerHTML = `
            <div style="color: #6fcfff; font-weight: bold; margin-bottom: 5px;">🚀 Lancement en cours...</div>
            <div>${bodyLabel} [${state.currentBody.coords}]</div>
            <div>Progression: ${launched} / ${total}</div>
            <button id="cancel-launch" style="margin-top: 8px; padding: 4px 8px; cursor: pointer;">❌ Annuler</button>
        `;

        document.getElementById('cancel-launch')?.addEventListener('click', () => {
            clearLaunchState();
            existingProgress.remove();
            showLaunchStatus('Lancement annulé');
        });
    }

    function autoLaunchExpeditions() {
        const state = loadLaunchState();
        if (state && state.active) {
            console.log('[Monitor] Lancement déjà en cours, ignoré');
            return;
        }

        if (!CONFIG.autoLaunchExpeditions) {
            console.log('[Monitor] Lancement auto désactivé');
            return;
        }

        if (!isUserIdle()) {
            console.log(`[Monitor] Activité en cours, lancement auto des expéditions reporté (${Math.round(getIdleRemaining() / 1000)}s)`);
            runWhenIdle('expeditions', () => {
                if (!isActionInProgress()) checkExpeditions();
            });
            return;
        }

        if (!isInExpeditionTimeSlot()) {
            const start = CONFIG.expeditionStartHour !== null ? `${CONFIG.expeditionStartHour}h` : '0h';
            const end = CONFIG.expeditionEndHour !== null ? `${CONFIG.expeditionEndHour}h` : '24h';
            console.log(`[Monitor] Hors créneau horaire (${start} - ${end}), lancement auto ignoré`);
            return;
        }

        const summary = getExpeditionsSummary();
        const bodiesWithMissing = summary.filter(b => b.missing > 0);

        if (bodiesWithMissing.length === 0) {
            return;
        }

        // Envoi direct : par requêtes, sans navigation (planètes en échec récent écartées un moment)
        if (CONFIG.expeditionMode === 'direct') {
            if (isActionInProgress()) return;
            const eligible = getDirectEligibleBodies(bodiesWithMissing);
            if (eligible.length === 0) return;
            const count = eligible.reduce((sum, b) => sum + b.missing, 0);
            console.log(`[Monitor] Envoi direct de ${count} expédition(s)...`);
            launchExpeditionsDirect(eligible);
            return;
        }

        const totalMissing = bodiesWithMissing.reduce((sum, b) => sum + b.missing, 0);
        const planetCount = bodiesWithMissing.filter(b => b.type === 'planet').length;
        const moonCount = bodiesWithMissing.filter(b => b.type === 'moon').length;

        let bodyDesc = '';
        if (planetCount > 0 && moonCount > 0) {
            bodyDesc = `${planetCount} planète(s) et ${moonCount} lune(s)`;
        } else if (planetCount > 0) {
            bodyDesc = `${planetCount} planète(s)`;
        } else {
            bodyDesc = `${moonCount} lune(s)`;
        }

        console.log(`[Monitor] Lancement automatique de ${totalMissing} expédition(s) sur ${bodyDesc}...`);

        if (CONFIG.expeditionLaunchAlerts) notifyDiscord(`🤖 **Lancement automatique** de ${totalMissing} expédition(s) sur ${bodyDesc}`);

        const firstBody = bodiesWithMissing[0];

        const launchState = {
            active: true,
            step: 'go_to_body',
            bodies: bodiesWithMissing,
            currentBody: { ...firstBody, launched: 0 },
            totalLaunched: 0
        };

        saveLaunchState(launchState);
        console.log('[Monitor] Démarrage du lancement auto:', launchState);

        goToCelestialBody(firstBody.id, firstBody.type);
    }

    async function launchMissingExpeditions() {
        const summary = getExpeditionsSummary();
        const bodiesWithMissing = summary.filter(b => b.missing > 0);

        if (bodiesWithMissing.length === 0) {
            alert('Aucune expédition manquante !');
            return;
        }

        const totalMissing = bodiesWithMissing.reduce((sum, b) => sum + b.missing, 0);
        const confirmMsg = `Lancer ${totalMissing} expédition(s) manquante(s) ?\n\n${bodiesWithMissing.map(b => {
            const icon = b.type === 'moon' ? '🌙' : '🌍';
            return `${icon} ${b.name} [${b.coords}]: ${b.missing} expé(s)`;
        }).join('\n')}`;

        if (!window.confirm(confirmMsg)) return;

        if (CONFIG.expeditionMode === 'direct') {
            closeConfigPanel();
            await launchExpeditionsDirect(bodiesWithMissing);
            return;
        }

        const firstBody = bodiesWithMissing[0];

        const state = {
            active: true,
            step: 'go_to_body',
            bodies: bodiesWithMissing,
            currentBody: { ...firstBody, launched: 0 },
            totalLaunched: 0
        };

        saveLaunchState(state);
        console.log('[Monitor] Démarrage du lancement:', state);

        closeConfigPanel();

        goToCelestialBody(firstBody.id, firstBody.type);
    }

    // ===== Expéditions en envoi direct (bouton « Envoyer » de la case 16 de la Galaxie) =====

    let expeditionDirectRunning = false;
    // Après un échec, pas de nouvel essai à chaque vérification (une par minute) : par planète/lune, et global
    const DIRECT_RETRY_DELAY = 15 * 60 * 1000;
    const directSkipUntil = {};
    let directRetryAt = 0;

    function getDirectEligibleBodies(bodies) {
        if (Date.now() < directRetryAt) return [];
        return bodies.filter(b => !(directSkipUntil[b.key] > Date.now()));
    }

    // Variable JS d'une page OGame, écrite sur une ligne : « var name = [...]; »
    function readPageJsonVar(html, name) {
        const match = html.match(new RegExp(`var ${name}\\s*=\\s*(.+?);?\\s*$`, 'm'));
        if (!match) return null;
        try {
            return JSON.parse(match[1]);
        } catch (e) {
            return null;
        }
    }

    // Vaisseaux présents et flottes d'expédition enregistrées d'une planète/lune (elle devient la planète courante du serveur)
    async function fetchFleetPage(bodyId) {
        const response = await fetch(`${window.location.origin}/game/index.php?page=ingame&component=fleetdispatch&cp=${bodyId}`, { credentials: 'include' });
        const html = await response.text();
        const list = readPageJsonVar(html, 'shipsOnPlanet');
        const ships = {};
        (list || []).forEach(s => { ships[s.id] = Number(s.number) || 0; });
        const templates = (readPageJsonVar(html, 'expeditionFleetTemplates') || []).filter(t => t && t.id && t.ships);
        const number = (name) => {
            const m = html.match(new RegExp(`var ${name}\\s*=\\s*(\\d+)`));
            return m ? parseInt(m[1]) : null;
        };
        return {
            ok: Array.isArray(list), ships, templates,
            expeditionCount: number('expeditionCount'),
            maxExpeditionCount: number('maxExpeditionCount'),
        };
    }

    // Slots d'expédition pleins : état normal (toutes les expéditions sont parties), on réessaie un peu plus tard sans alerter
    const DIRECT_FULL_RETRY_DELAY = 5 * 60 * 1000;
    // Même problème déjà signalé sur Discord : pas de nouveau message avant ce délai
    const DIRECT_PROBLEM_REPEAT_DELAY = 3 * 3600 * 1000;
    const directProblemNotifiedAt = {};

    function isTooManyExpeditionsMessage(message) {
        return /trop d.exp[ée]ditions/i.test(String(message || ''));
    }

    // La liste des événements est écrite dans la page à son chargement : on la recharge pour voir les nouvelles flottes
    // (sinon l'expédition paraîtrait toujours manquante et serait relancée)
    async function refreshEventList() {
        const response = await fetch(`${window.location.origin}/game/index.php?page=ingame&component=overview`, { credentials: 'include' });
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const fresh = doc.querySelector('#eventContent');
        const current = document.querySelector('#eventContent');
        if (!fresh || !current) throw new Error('liste des événements introuvable');
        current.innerHTML = fresh.innerHTML;
        try {
            const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            if (typeof page.getAjaxEventbox === 'function') page.getAjaxEventbox();
        } catch (e) {}
    }

    // Envoie les expéditions manquantes par requête, sans navigation. Retourne le nombre envoyé.
    async function launchExpeditionsDirect(bodies) {
        if (expeditionDirectRunning) return 0;
        expeditionDirectRunning = true;
        const currentId = getCurrentPlanetId();
        const [currentGalaxy, currentSystem] = (getCurrentPlanetCoords() || '').split(':');
        const wanted = (CONFIG.expeditionTemplate || '').trim().toLowerCase();
        let switched = false;
        let sent = 0;
        const problems = [];
        // Slots d'expédition libres (lus sur la page Flotte, décomptés à chaque envoi) ; null = inconnu
        let freeExpeditionSlots = null;
        let slotsFull = null;
        try {
            if (!wanted) throw new Error('aucune flotte enregistrée choisie (⚙️ → Expéditions)');
            bodiesLoop:
            for (const body of bodies) {
                const label = `${body.type === 'moon' ? '🌙' : '🌍'} [${body.coords}]`;
                const fleet = await fetchFleetPage(body.id);
                switched = switched || body.id !== currentId;
                const skipBody = (reason) => {
                    problems.push(`${label} : ${reason}`);
                    directSkipUntil[body.key] = Date.now() + DIRECT_RETRY_DELAY;
                };
                if (!fleet.ok) {
                    skipBody('page Flotte illisible');
                    continue;
                }
                if (fleet.templates.length > 0) {
                    localStorage.setItem(FLEET_TEMPLATES_KEY, JSON.stringify(fleet.templates.map(t => t.name)));
                }
                if (Number.isInteger(fleet.expeditionCount) && Number.isInteger(fleet.maxExpeditionCount)) {
                    freeExpeditionSlots = fleet.maxExpeditionCount - fleet.expeditionCount;
                    slotsFull = `${fleet.expeditionCount}/${fleet.maxExpeditionCount}`;
                    const expectedTotal = getTotalExpectedExpeditions();
                    if (expectedTotal > fleet.maxExpeditionCount) {
                        problems.push(`configuration : ${expectedTotal} expéditions demandées pour ${fleet.maxExpeditionCount} slots (⚙️ → Expéditions)`);
                    }
                }
                const template = fleet.templates.find(t => String(t.name).trim().toLowerCase() === wanted);
                if (!template) throw new Error(`flotte enregistrée « ${CONFIG.expeditionTemplate} » introuvable`);
                const [galaxy, system] = body.coords.split(':');

                for (let i = 0; i < body.missing; i++) {
                    // Vous reprenez la main : la planète courante du serveur doit redevenir celle affichée
                    if (!isUserIdle()) {
                        problems.push('interrompu (activité détectée)');
                        break bodiesLoop;
                    }
                    // Tous les slots d'expédition sont pris : rien à envoyer, on repasse plus tard
                    if (freeExpeditionSlots !== null && freeExpeditionSlots <= 0) {
                        directRetryAt = Date.now() + DIRECT_FULL_RETRY_DELAY;
                        break bodiesLoop;
                    }
                    // OGame envoie ce qu'il y a quand la flotte est incomplète : on vérifie avant
                    const lacking = Object.entries(template.ships)
                        .filter(([id, n]) => (fleet.ships[id] || 0) < n)
                        .map(([id, n]) => `${(n - (fleet.ships[id] || 0)).toLocaleString('fr-FR')} ${SHIP_NAMES[id] || id}`);
                    if (lacking.length > 0) {
                        skipBody(`manque ${lacking.join(', ')}`);
                        break;
                    }
                    const data = await fetchSolarSystem(galaxy, system, body.id);
                    const sys = data.system || {};
                    if (Number.isInteger(sys.usedFleetSlots) && Number.isInteger(sys.maximumFleetSlots)
                        && sys.usedFleetSlots >= sys.maximumFleetSlots) {
                        problems.push(`plus de slot de flotte libre (${sys.usedFleetSlots}/${sys.maximumFleetSlots})`);
                        directRetryAt = Date.now() + DIRECT_RETRY_DELAY;
                        break bodiesLoop;
                    }
                    if (sys.canExpedition === false) {
                        skipBody('expédition impossible pour le moment');
                        break;
                    }
                    await wait(500 + Math.random() * 700);
                    const params = {
                        mission: 15, galaxy, system, position: 16, type: 1, shipCount: 0,
                        token: data.newAjaxToken || data.token,
                        speed: Math.round((template.fleetSpeed || 100) / 10),
                        holdingtime: template.expeditionTime || 1,
                        expeditionFleetTemplateId: template.id,
                    };
                    Object.entries(template.ships).forEach(([id, n]) => { params[`am${id}`] = n; });
                    const res = await ogamePost(`${window.location.origin}/game/index.php?page=ingame&component=fleetdispatch&action=miniFleet&asJson=1&cp=${body.id}`, params);
                    setPageAjaxToken(res.newAjaxToken);
                    if (res.success && res.response && res.response.success) {
                        sent++;
                        if (freeExpeditionSlots !== null) freeExpeditionSlots--;
                        Object.entries(template.ships).forEach(([id, n]) => { fleet.ships[id] = (fleet.ships[id] || 0) - n; });
                        console.log(`[Monitor] Expédition envoyée (direct) depuis ${body.coords} : ${res.response.shipsSent} vaisseau(x)`);
                        if (CONFIG.expeditionLaunchAlerts) notifyDiscord(`🚀 **Expédition lancée** (envoi direct) depuis ${label} (${i + 1}/${body.missing}) · « ${template.name} »`);
                    } else {
                        const message = getOgameErrorMessage(res);
                        // Slots pleins malgré le décompte (expédition partie d'ailleurs) : même cas que ci-dessus
                        if (isTooManyExpeditionsMessage(message)) {
                            freeExpeditionSlots = 0;
                            directRetryAt = Date.now() + DIRECT_FULL_RETRY_DELAY;
                            break bodiesLoop;
                        }
                        skipBody(message);
                        break;
                    }
                }
            }
        } catch (e) {
            problems.push(e.message);
            directRetryAt = Date.now() + DIRECT_RETRY_DELAY;
        } finally {
            // Retour sur la planète affichée (sinon la prochaine page ouverte serait la dernière planète de départ)
            if (switched && currentId && currentGalaxy) {
                try {
                    const back = await fetchSolarSystem(currentGalaxy, currentSystem, currentId);
                    setPageAjaxToken(back.newAjaxToken || back.token);
                } catch (e) {
                    console.log('[Monitor] Retour sur la planète affichée impossible:', e);
                }
            }
            if (sent > 0) {
                try {
                    await refreshEventList();
                } catch (e) {
                    // Liste non rafraîchie : on recharge la page plutôt que de risquer un double envoi
                    console.log('[Monitor] Liste des événements non rafraîchie, rechargement:', e);
                    window.location.reload();
                }
            }
            expeditionDirectRunning = false;
        }
        if (problems.length > 0) {
            console.log('[Monitor] Envoi direct :', problems);
            // Un problème persistant (flotte incomplète, configuration…) n'est signalé qu'une fois toutes les 3 h
            const now = Date.now();
            const fresh = problems.filter(p => !(now - (directProblemNotifiedAt[p] || 0) < DIRECT_PROBLEM_REPEAT_DELAY));
            fresh.forEach(p => { directProblemNotifiedAt[p] = now; });
            if (fresh.length > 0) notifyDiscord(`⚠️ **Expéditions (envoi direct)** : ${fresh.join(' · ')}`);
        }
        const full = freeExpeditionSlots !== null && freeExpeditionSlots <= 0;
        if (sent > 0) {
            showLaunchStatus(`✅ ${sent} expédition(s) lancée(s)${problems.length ? ` · ${problems[0]}` : ''}`, false);
        } else if (full && problems.length === 0) {
            showLaunchStatus(`Slots d'expédition pleins${slotsFull ? ` (${slotsFull})` : ''}, nouvel essai dans 5 min`, false);
        } else {
            showLaunchStatus(`Erreur: ${problems[0] || 'rien envoyé'}`, true);
        }
        return sent;
    }

    function parseFleetDetails(tooltipHtml) {
        const details = {
            ships: [],
            cargo: []
        };

        if (!tooltipHtml) return details;

        const shipMatches = tooltipHtml.matchAll(/<td colspan="2">([^<]+):<\/td>\s*<td class="value">([^<]+)<\/td>/g);
        for (const match of shipMatches) {
            const name = match[1].trim();
            const value = match[2].trim();

            if (['Métal', 'Cristal', 'Deutérium', 'Nourriture'].includes(name)) {
                details.cargo.push(`${name}: ${value}`);
            } else if (name && value) {
                details.ships.push(`${name}: ${value}`);
            }
        }

        return details;
    }

    function extractEventInfo(row) {
        const info = {
            arrivalTime: '',
            countdown: '',
            missionType: '',
            originName: '',
            originCoords: '',
            destName: '',
            destCoords: '',
            destType: 'planet',
            playerName: '',
            fleetCount: '',
            ships: [],
            cargo: []
        };

        const countdownEl = row.querySelector('.countDown span');
        if (countdownEl) {
            info.countdown = countdownEl.textContent.trim();
        }

        const arrivalEl = row.querySelector('.arrivalTime');
        if (arrivalEl) {
            info.arrivalTime = arrivalEl.getAttribute('data-output-time') || arrivalEl.textContent.trim();
        }

        const missionImg = row.querySelector('.missionFleet img[data-tooltip-title]');
        if (missionImg) {
            info.missionType = missionImg.getAttribute('data-tooltip-title');
        }

        const originFleetEl = row.querySelector('.originFleet');
        if (originFleetEl) {
            info.originName = originFleetEl.textContent.trim().replace(/\s+/g, ' ');
        }

        const originCoordsEl = row.querySelector('.coordsOrigin a');
        if (originCoordsEl) {
            info.originCoords = originCoordsEl.textContent.trim();
        }

        const destFleetEl = row.querySelector('.destFleet');
        if (destFleetEl) {
            info.destName = destFleetEl.textContent.trim().replace(/\s+/g, ' ');
            const figureEl = destFleetEl.querySelector('figure');
            if (figureEl && figureEl.classList.contains('moon')) {
                info.destType = 'moon';
            }
            if (destFleetEl.innerHTML.toLowerCase().includes('lune')) {
                info.destType = 'moon';
            }
        }

        const destCoordsEl = row.querySelector('.destCoords a');
        if (destCoordsEl) {
            info.destCoords = destCoordsEl.textContent.trim().replace(/[\[\]]/g, '');
        }

        const fleetCountEl = row.querySelector('.detailsFleet span');
        if (fleetCountEl) {
            info.fleetCount = fleetCountEl.textContent.trim();
        }

        const playerEl = row.querySelector('.sendMail a.sendMail[data-tooltip-title]');
        if (playerEl) {
            info.playerName = playerEl.getAttribute('data-tooltip-title');
        }

        const tooltipEl = row.querySelector('.icon_movement span[data-tooltip-title], .icon_movement_reserve span[data-tooltip-title]');
        if (tooltipEl) {
            const tooltipHtml = tooltipEl.getAttribute('data-tooltip-title');
            const fleetDetails = parseFleetDetails(tooltipHtml);
            info.ships = fleetDetails.ships;
            info.cargo = fleetDetails.cargo;
        }

        return info;
    }

    function formatAlertMessage(type, info) {
        const emoji = type === 'attack' ? '⚔️' : '🔍';
        const title = type === 'attack' ? 'ATTAQUE DÉTECTÉE' : 'ESPIONNAGE DÉTECTÉ';

        let message = `${emoji} **${title}** ${emoji}\n\n`;
        message += `⏰ **Arrivée:** ${info.arrivalTime} (${info.countdown})\n`;
        message += `📍 **Origine:** ${info.originName} ${info.originCoords}\n`;
        message += `🎯 **Destination:** ${info.destName} ${info.destCoords}\n`;

        if (info.playerName) {
            message += `👤 **Joueur:** ${info.playerName}\n`;
        }

        message += `🚀 **Vaisseaux:** ${info.fleetCount}\n`;

        if (info.ships.length > 0) {
            message += `\n**Composition:**\n`;
            info.ships.forEach(ship => {
                message += `• ${ship}\n`;
            });
        }

        return message;
    }

    function checkAlerts() {
        checkEnemyNotification();
        cleanupOldAttacks();

        const eventRows = document.querySelectorAll('#eventContent tr.eventFleet');

        eventRows.forEach(row => {
            const missionImg = row.querySelector('.missionFleet img[data-tooltip-title]');
            if (!missionImg) return;

            const tooltipTitle = missionImg.getAttribute('data-tooltip-title');
            if (!tooltipTitle) return;

            if (tooltipTitle.includes('Propre flotte')) return;

            const eventId = row.id;

            if (CONFIG.alertAttack && tooltipTitle.includes('Attaquer')) {
                const info = extractEventInfo(row);
                const message = formatAlertMessage('attack', info);
                sendDiscord(message, `attack_${eventId}`, 'attack');
                console.log(`[Monitor] Attaque détectée: ${info.countdown} (raw)`);

                const secondsUntilImpact = parseCountdown(info.countdown);
                console.log(`[Monitor] Countdown parsé: ${secondsUntilImpact}s (${Math.floor(secondsUntilImpact/60)}m ${secondsUntilImpact%60}s)`);

                if (CONFIG.panic.autoPanicOnAttack) {
                    if (secondsUntilImpact !== null) {
                        console.log(`[Panic] Impact dans ${secondsUntilImpact}s`);
                        scheduleAutoPanic(secondsUntilImpact, info);
                    }
                }

                if (CONFIG.fleeConfig.enabled && info.destCoords) {
                    const targetKey = getBodyKey(info.destType, info.destCoords);
                    if (secondsUntilImpact !== null) {
                        console.log(`[Flee] Vérification repli pour ${targetKey}, impact dans ${secondsUntilImpact}s`);
                        scheduleAutoFlee(targetKey, eventId, secondsUntilImpact, info);
                    }
                }
            }

            if (CONFIG.alertEspionage && tooltipTitle.includes('Espionner')) {
                const info = extractEventInfo(row);
                const message = formatAlertMessage('espionage', info);
                sendDiscord(message, `espionage_${eventId}`, 'espionage');
                console.log(`[Monitor] Espionnage détecté:`, info);
            }
        });
    }

    function updateTimerDisplay() {
        const timerEl = document.getElementById('ogame-plugin-timer');
        const countdownEl = document.getElementById('timer-countdown');

        if (!timerEl || !countdownEl) return;

        if (!CONFIG.randomClickEnabled || !nextClickTime) {
            timerEl.classList.remove('active');
            return;
        }

        timerEl.classList.add('active');

        const now = Date.now();
        const remaining = Math.max(0, nextClickTime - now);
        const seconds = Math.floor(remaining / 1000);
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;

        countdownEl.textContent = `${minutes}:${secs.toString().padStart(2, '0')}`;

        timerEl.classList.remove('warning', 'imminent');
        if (seconds <= 10) {
            timerEl.classList.add('imminent');
        } else if (seconds <= 30) {
            timerEl.classList.add('warning');
        }
    }

    function startTimerDisplay() {
        if (timerInterval) {
            clearInterval(timerInterval);
        }
        timerInterval = setInterval(updateTimerDisplay, 1000);
        updateTimerDisplay();
    }

    function stopTimerDisplay() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        const timerEl = document.getElementById('ogame-plugin-timer');
        if (timerEl) {
            timerEl.classList.remove('active');
        }
        nextClickTime = null;
    }

    function createConfigPanel() {
        const style = document.createElement('style');
        style.textContent = `
            /* Dans le bloc du bas : s'ouvre au-dessus de la barre de boutons */
            #ogame-plugin-panel {
                display: none;
                flex: 0 1 auto;
                min-height: 150px;
                box-sizing: border-box;
                background: linear-gradient(180deg, rgba(16, 36, 48, 0.98) 0%, rgba(6, 16, 21, 0.98) 100%);
                border: 1px solid #3c5a6a;
                border-radius: 8px;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
                padding: 15px;
                width: 680px;
                max-width: calc(100vw - 20px);
                overflow-y: auto;
                overflow-x: hidden;
                color: #9fc3d6;
                font-family: Verdana, Arial, sans-serif;
                font-size: 11px;
            }
            #ogame-plugin-panel h3 {
                margin: 0 0 15px 0;
                color: #6fcfff;
                border-bottom: 1px solid #3c5a6a;
                padding-bottom: 10px;
                font-size: 14px;
            }
            #ogame-plugin-panel h3 .plugin-version {
                color: #6a8a9a;
                font-size: 10px;
                font-weight: normal;
            }
            #ogame-plugin-panel .config-group {
                margin-bottom: 12px;
            }
            #ogame-plugin-panel label {
                display: block;
                margin-bottom: 4px;
                color: #b0d0e0;
                font-weight: bold;
            }
            #ogame-plugin-panel input[type="text"],
            #ogame-plugin-panel input[type="number"],
            #ogame-plugin-panel textarea,
            #ogame-plugin-panel select {
                width: 100%;
                padding: 6px;
                background: #0a1520;
                border: 1px solid #3c5a6a;
                color: #9fc3d6;
                border-radius: 4px;
                box-sizing: border-box;
            }
            #ogame-plugin-panel input[type="checkbox"] {
                margin-right: 8px;
            }
            #ogame-plugin-panel .checkbox-label {
                display: flex;
                align-items: center;
                cursor: pointer;
            }
            #ogame-plugin-panel .btn-group {
                display: flex;
                gap: 10px;
                margin-top: 15px;
            }
            #ogame-plugin-panel button {
                flex: 1;
                padding: 8px;
                border: 1px solid #3c5a6a;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
            }
            #ogame-plugin-panel .btn-save {
                background: linear-gradient(180deg, #1a5a3a 0%, #0d2f1f 100%);
                color: #9fd6c3;
            }
            #ogame-plugin-panel .btn-cancel {
                background: linear-gradient(180deg, #5a1a1a 0%, #2f0d0d 100%);
                color: #d69f9f;
            }
            #ogame-plugin-panel .btn-reset {
                background: linear-gradient(180deg, #4a3a1a 0%, #291f0d 100%);
                color: #d6c39f;
            }
            #ogame-plugin-panel .btn-launch {
                background: linear-gradient(180deg, #1a4a5a 0%, #0d2f3f 100%);
                color: #9fd6ff;
                margin-top: 10px;
                padding: 10px;
                font-weight: bold;
            }
            #ogame-plugin-panel .btn-launch:hover {
                background: linear-gradient(180deg, #2a5a6a 0%, #1d3f4f 100%);
            }
            #ogame-plugin-panel .btn-launch:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #ogame-plugin-panel .btn-test {
                margin-top: 5px;
                background: linear-gradient(180deg, #1a3a4a 0%, #0d1f29 100%);
                color: #9fc3d6;
            }
            #ogame-plugin-panel .autodef-body {
                border: 1px solid #2c4a5a;
                border-radius: 4px;
                padding: 6px 8px;
                margin-bottom: 6px;
                background: rgba(20, 40, 55, 0.4);
            }
            #ogame-plugin-panel .autodef-head .body-coords {
                color: #7a9aaa;
                font-size: 10px;
            }
            #ogame-plugin-panel .autodef-table {
                width: 100%;
                border-collapse: collapse;
                margin: 6px 0;
            }
            #ogame-plugin-panel .autodef-table th {
                font-size: 10px;
                color: #8ab;
                font-weight: normal;
            }
            #ogame-plugin-panel .autodef-table td:first-child {
                font-size: 10px;
                color: #8ab;
                padding-right: 4px;
            }
            #ogame-plugin-panel .autodef-table input {
                width: 100%;
                box-sizing: border-box;
                text-align: right;
            }
            #ogame-plugin-panel .autodef-item {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 2px 0;
                font-size: 11px;
            }
            #ogame-plugin-panel .autodef-rank {
                color: #6cf;
                width: 16px;
            }
            #ogame-plugin-panel .autodef-name {
                flex: 1;
            }
            #ogame-plugin-panel .autodef-item button {
                width: auto;
                padding: 1px 5px;
                margin: 0;
                font-size: 10px;
            }
            #ogame-plugin-panel .autodef-item button:disabled {
                opacity: 0.3;
            }
            #ogame-plugin-panel .autodef-add {
                width: 100%;
                margin-top: 4px;
            }
            #ogame-plugin-panel .cfg-body {
                display: flex;
                gap: 12px;
                align-items: flex-start;
            }
            /* Onglets en colonne : autant d'onglets que nécessaire sans défilement horizontal */
            #ogame-plugin-panel .cfg-tabs {
                display: flex;
                flex-direction: column;
                gap: 3px;
                flex: 0 0 128px;
                position: sticky;
                top: 0;
            }
            #ogame-plugin-panel .cfg-tabs button {
                flex: none;
                width: 100%;
                padding: 7px 8px;
                background: #0a1520;
                color: #6a9aaa;
                border: 1px solid #2c4a5a;
                border-radius: 4px;
                font-size: 11px;
                text-align: left;
                white-space: nowrap;
            }
            #ogame-plugin-panel .cfg-content {
                flex: 1;
                min-width: 0;
            }
            #ogame-plugin-panel .cfg-content input[type="text"],
            #ogame-plugin-panel .cfg-content input[type="number"],
            #ogame-plugin-panel .cfg-content select,
            #ogame-plugin-panel .cfg-content textarea {
                max-width: 100%;
                box-sizing: border-box;
            }
            /* Panneau ouvert : il prend toute la hauteur de la colonne (file et cartes masquées) */
            #ogame-plugin-dock.cfg-open #ogame-plugin-buildqueue,
            #ogame-plugin-dock.cfg-open #ogame-plugin-idle,
            #ogame-plugin-dock.cfg-open #ogame-plugin-timer {
                display: none !important;
            }
            #ogame-plugin-panel .cfg-tabs button:hover {
                color: #9fc3d6;
            }
            #ogame-plugin-panel .cfg-tabs button.active {
                background: #1a3a4a;
                color: #6fcfff;
                border-color: #3c5a6a;
                font-weight: bold;
            }
            #ogame-plugin-panel .cfg-tab {
                display: none;
            }
            #ogame-plugin-panel .cfg-tab.active {
                display: block;
            }
            #ogame-plugin-panel .cfg-tab > .section-title:first-child {
                margin-top: 0;
            }
            #ogame-plugin-panel .stats-body {
                color: #6fcfff;
                font-weight: bold;
                font-size: 12px;
                margin-bottom: 2px;
            }
            #ogame-plugin-panel .stats-table {
                width: 100%;
                margin: 8px 0 4px;
                border-collapse: collapse;
            }
            #ogame-plugin-panel .stats-table th {
                color: #6a9aaa;
                font-weight: normal;
                text-align: right;
                padding: 3px 6px;
                border-bottom: 1px solid #2c4a5a;
            }
            #ogame-plugin-panel .stats-table th:first-child,
            #ogame-plugin-panel .stats-table td:first-child {
                text-align: left;
            }
            #ogame-plugin-panel .stats-table td {
                text-align: right;
                padding: 3px 6px;
                border-bottom: 1px solid #13283a;
            }
            #ogame-plugin-panel .stats-table td b {
                color: #9fffaf;
            }
            #ogame-plugin-panel .stats-over {
                color: #ff8f8f;
                font-weight: bold;
            }
            #ogame-plugin-panel .stats-ok {
                color: #9fffaf;
            }
            #ogame-plugin-panel .stats-slots {
                margin-bottom: 8px;
            }
            #ogame-plugin-panel .stats-template {
                padding: 6px 8px;
                margin-bottom: 4px;
                background: #0a1520;
                border: 1px solid #2c4a5a;
                border-radius: 4px;
            }
            #ogame-plugin-panel .stats-template b {
                color: #9fffaf;
            }
            #ogame-plugin-panel .bq-log {
                max-height: 200px;
                overflow-y: auto;
                margin: 0;
                padding: 6px;
                background: #0a1520;
                border: 1px solid #2c4a5a;
                border-radius: 4px;
                color: #9fc3d6;
                font-family: Consolas, monospace;
                font-size: 10px;
                white-space: pre-wrap;
                word-break: break-word;
            }
            #ogame-plugin-panel .cfg-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 0 10px;
            }
            #ogame-plugin-panel .btn-group {
                position: sticky;
                bottom: -15px;
                margin: 15px -15px -15px;
                padding: 10px 15px 15px;
                background: #061015;
                border-top: 1px solid #2c4a5a;
            }
            #ogame-plugin-panel .section-title {
                color: #6fcfff;
                margin: 15px 0 10px 0;
                font-size: 12px;
                border-bottom: 1px solid #2c4a5a;
                padding-bottom: 5px;
            }
            #ogame-plugin-panel .section-title.panic {
                color: #ff6f6f;
                border-bottom-color: #5a2c2c;
            }
            #ogame-plugin-panel .section-title.flee {
                color: #6fcfaf;
                border-bottom-color: #2c5a4a;
            }
            #ogame-plugin-panel .hint {
                color: #6a8a9a;
                font-size: 10px;
                margin-top: 2px;
            }
            #ogame-plugin-panel .body-expedition-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 10px;
                margin-bottom: 4px;
                background: #0a1520;
                border: 1px solid #2c4a5a;
                border-radius: 4px;
            }
            #ogame-plugin-panel .body-expedition-row.moon-row {
                background: #0f1520;
                border-color: #3c4a5a;
                margin-left: 15px;
            }
            #ogame-plugin-panel .body-expedition-row .body-info {
                display: flex;
                flex-direction: column;
                flex: 1;
            }
            #ogame-plugin-panel .body-expedition-row .body-name {
                color: #9fc3d6;
                font-weight: bold;
            }
            #ogame-plugin-panel .body-expedition-row .body-name .body-icon {
                margin-right: 5px;
            }
            #ogame-plugin-panel .body-expedition-row .body-coords {
                color: #6a9aaa;
                font-size: 10px;
            }
            #ogame-plugin-panel .body-expedition-row .expedition-status {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #ogame-plugin-panel .body-expedition-row .expedition-counter {
                font-weight: bold;
                padding: 4px 8px;
                border-radius: 4px;
                min-width: 50px;
                text-align: center;
            }
            #ogame-plugin-panel .body-expedition-row .expedition-counter.ok {
                background: #1a3a2a;
                color: #6fcf6f;
            }
            #ogame-plugin-panel .body-expedition-row .expedition-counter.missing {
                background: #3a2a1a;
                color: #cfaf6f;
            }
            #ogame-plugin-panel .body-expedition-row .expedition-counter.none {
                background: #2a2a2a;
                color: #8a8a8a;
            }
            #ogame-plugin-panel .body-expedition-row input[type="number"] {
                width: 50px;
                text-align: center;
            }
            #ogame-plugin-panel .expeditions-total {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px;
                margin-top: 10px;
                background: #1a2a3a;
                border: 1px solid #3c5a6a;
                border-radius: 4px;
                font-weight: bold;
            }
            #ogame-plugin-panel .expeditions-total .total-label {
                color: #b0d0e0;
            }
            #ogame-plugin-panel .expeditions-total .total-value {
                color: #6fcfff;
                font-size: 14px;
            }
            #ogame-plugin-panel .expeditions-total .total-value.has-missing {
                color: #cfaf6f;
            }
            #ogame-plugin-panel .no-bodies {
                color: #d69f9f;
                font-style: italic;
                padding: 10px;
                text-align: center;
            }
            #ogame-plugin-panel .refresh-btn {
                background: none;
                border: none;
                color: #6fcfff;
                cursor: pointer;
                padding: 2px 6px;
                font-size: 14px;
            }
            #ogame-plugin-panel .refresh-btn:hover {
                color: #9fdfff;
            }
            #ogame-plugin-panel .panic-box {
                background: #1a1520;
                border: 1px solid #5a3c4a;
                border-radius: 4px;
                padding: 10px;
                margin-top: 5px;
            }
            #ogame-plugin-panel .flee-box {
                background: #152a20;
                border: 1px solid #3c5a4a;
                border-radius: 4px;
                padding: 10px;
                margin-top: 5px;
            }
            #ogame-plugin-panel .flee-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 8px;
                margin-bottom: 4px;
                background: #0a1a15;
                border: 1px solid #2c4a3a;
                border-radius: 4px;
            }
            #ogame-plugin-panel .flee-row.moon-row {
                margin-left: 15px;
                background: #0f1a18;
            }
            #ogame-plugin-panel .flee-row .flee-source {
                flex: 1;
                font-size: 11px;
            }
            #ogame-plugin-panel .flee-row .flee-dest {
                flex: 1;
            }
            #ogame-plugin-panel .flee-row select {
                width: 100%;
                font-size: 10px;
                padding: 4px;
            }
        `;
        document.head.appendChild(style);

        const dock = getDock();
        const toolbar = createToolbar();
        toolbar.querySelector('.ogp-buttons').innerHTML = `
            <button id="ogame-plugin-panic-btn" title="Envoyer immédiatement la flotte (configuration dans ⚙️ → Défense)">🚨 PANIC</button>
            <button id="ogame-plugin-btn" title="OgOwnax Plugin v${GM_info.script.version}">⚙️ OgOwnax</button>
        `;
        toolbar.querySelector('.ogp-buttons').appendChild(createToggleButton());

        // Carte « Prochain clic », toujours en bas du bloc (les files de construction s'insèrent au-dessus)
        const timer = document.createElement('div');
        timer.id = 'ogame-plugin-timer';
        timer.className = 'ogp-card';
        timer.innerHTML = `
            <span class="timer-label">⏱️ Prochain clic</span>
            <span class="timer-value" id="timer-countdown">--:--</span>
        `;
        dock.appendChild(timer);

        const panel = document.createElement('div');
        panel.id = 'ogame-plugin-panel';
        const speedOptions = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
            .map(v => `<option value="${v}">${v}%</option>`).join('');

        panel.innerHTML = `
            <h3>⚙️ OgOwnax Plugin <span class="plugin-version">v${GM_info.script.version}</span></h3>

            <div class="cfg-body">
            <div class="cfg-tabs">
                <button data-tab="defense">🛡️ Panic / repli</button>
                <button data-tab="autodef">🏰 Auto-défense</button>
                <button data-tab="expeditions">🚀 Expéditions</button>
                <button data-tab="discovery">🔭 Découverte</button>
                <button data-tab="build">🏗️ Construction</button>
                <button data-tab="stats">📊 Stats</button>
                <button data-tab="alerts">🔔 Alertes</button>
                <button data-tab="general">⚙️ Général</button>
            </div>
            <div class="cfg-content">

            <div class="cfg-tab" data-tab="defense">
                <div class="section-title panic">🚨 Panic (bouton global)</div>

                <div class="panic-box">
                    <div class="config-group">
                        <label>Source (où se trouve la flotte)</label>
                        <select id="cfg-panic-source">
                            <option value="">-- Sélectionner --</option>
                        </select>
                    </div>

                    <div class="config-group">
                        <label>Destination (où envoyer la flotte)</label>
                        <select id="cfg-panic-destination">
                            <option value="">-- Sélectionner --</option>
                        </select>
                    </div>

                    <div class="cfg-grid">
                        <div class="config-group">
                            <label>Vitesse</label>
                            <select id="cfg-panic-speed">${speedOptions}</select>
                        </div>
                        <div class="config-group">
                            <label>Délai avant impact (s)</label>
                            <input type="number" id="cfg-panic-delay" min="5" max="60">
                        </div>
                    </div>
                    <div class="hint">Vitesse recommandée : 10 % pour maximiser le temps de vol</div>

                    <div class="config-group" style="margin-top: 10px;">
                        <label class="checkbox-label">
                            <input type="checkbox" id="cfg-panic-auto">
                            🔥 Auto-Panic en cas d'attaque
                        </label>
                        <div class="hint">Déclenche automatiquement le panic X secondes avant l'impact</div>
                    </div>
                </div>

                <div class="section-title flee">🏃 Repli automatique (par planète/lune)</div>

                <div class="flee-box">
                    <div class="config-group">
                        <label class="checkbox-label">
                            <input type="checkbox" id="cfg-flee-enabled">
                            Activer le repli automatique
                        </label>
                        <div class="hint">Envoie flotte + ressources de la planète attaquée vers sa destination de repli</div>
                    </div>

                    <div class="cfg-grid">
                        <div class="config-group">
                            <label>Vitesse</label>
                            <select id="cfg-flee-speed">${speedOptions}</select>
                        </div>
                        <div class="config-group">
                            <label>Délai avant impact (s)</label>
                            <input type="number" id="cfg-flee-delay" min="5" max="600">
                        </div>
                    </div>
                    <div class="hint">Ex. : 240 = repli 4 minutes avant l'impact</div>

                    <div class="section-title" style="margin-top: 10px; font-size: 11px;">Destinations de repli</div>
                    <div id="cfg-flee-destinations-container"></div>
                </div>
            </div>

            <div class="cfg-tab" data-tab="expeditions">
                <div class="section-title">
                    🚀 Expéditions par planète/lune
                    <button class="refresh-btn" id="cfg-refresh-expeditions" title="Rafraîchir">🔄</button>
                </div>

                <div id="cfg-expeditions-container"></div>

                <button class="btn-launch" id="cfg-launch-expeditions">
                    🚀 Lancer les expéditions manquantes
                </button>

                <div class="section-title">Automatisation</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-auto-launch">
                        Lancement automatique des expéditions manquantes
                    </label>
                </div>

                <div class="config-group">
                    <label>Composition de la flotte</label>
                    <select id="cfg-expedition-mode">
                        <option value="key">Touche L / S (raccourci OGame)</option>
                        <option value="template">Flotte d'expédition enregistrée</option>
                        <option value="direct">Flotte enregistrée — envoi direct (sans changer de page)</option>
                    </select>
                    <div class="hint" id="cfg-expedition-direct-hint">Comme le bouton « Envoyer » de la case 16 dans la Galaxie : une requête par expédition, depuis chaque planète/lune, sans navigation. Une planète dont la flotte enregistrée n'est pas complète est sautée.</div>
                </div>

                <div class="config-group" id="cfg-expedition-key-group">
                    <label>Touche de lancement</label>
                    <select id="cfg-expedition-key" style="width: 80px;">
                        <option value="l">L</option>
                        <option value="s">S</option>
                    </select>
                    <div class="hint">Raccourci OGame appuyé sur la page Flotte pour composer l'expédition</div>
                </div>

                <div class="config-group" id="cfg-expedition-template-group">
                    <label>Flotte enregistrée</label>
                    <select id="cfg-expedition-template"></select>
                    <div class="hint">Liste « Flotte d'expédition » de la page Flotte, mise à jour à chaque passage sur cette page. Le script la sélectionne, clique sur Continuer, règle la position 16 et la mission Expédition, puis envoie.</div>
                </div>

                <div class="config-group">
                    <label>Créneau horaire</label>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <input type="number" id="cfg-expedition-start-hour" min="0" max="23" style="width: 60px;" placeholder="--">
                        <span>h à</span>
                        <input type="number" id="cfg-expedition-end-hour" min="0" max="23" style="width: 60px;" placeholder="--">
                        <span>h</span>
                    </div>
                    <div class="hint">Laisser vide pour aucune limite (ex. : 8 à 22 pour 8h-22h)</div>
                </div>
            </div>

            <div class="cfg-tab" data-tab="discovery">
                <div class="section-title">🔭 Découverte de formes de vie</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-discovery-enabled">
                        Lancer les découvertes automatiquement
                    </label>
                    <div class="hint">Envoie un vaisseau d'exploration sur chaque position découvrable de la plage, sans changer de page. Attend votre inactivité.</div>
                </div>

                <div class="config-group">
                    <label>Planète/lune de départ</label>
                    <select id="cfg-discovery-origin"></select>
                    <div class="hint">Les vaisseaux d'exploration partent d'ici et elle paie le coût. Le plugin y bascule le temps de l'envoi, puis revient sur la planète affichée.</div>
                </div>

                <div class="cfg-grid">
                    <div class="config-group">
                        <label>Du système</label>
                        <input type="text" id="cfg-discovery-from" placeholder="4:100">
                    </div>
                    <div class="config-group">
                        <label>Au système</label>
                        <input type="text" id="cfg-discovery-to" placeholder="4:300">
                    </div>
                    <div class="config-group">
                        <label>Slots de flotte à garder libres</label>
                        <input type="number" id="cfg-discovery-keep-free" min="0" max="99">
                    </div>
                    <div class="config-group">
                        <label>Découvertes en vol max</label>
                        <input type="number" id="cfg-discovery-max-active" min="0" max="99">
                    </div>
                </div>
                <div class="hint">0 = pas de limite. Les deux limites s'appliquent ensemble : la plus stricte l'emporte (ex. garder 3 slots libres pour les expéditions ET 5 découvertes max).</div>

                <div class="config-group">
                    <label>Passage toutes les (min)</label>
                    <input type="number" id="cfg-discovery-interval" min="1" max="1440" style="width: 80px;">
                </div>

                <div class="hint" id="cfg-discovery-status"></div>
                <button class="btn-test" id="cfg-discovery-run">🔭 Lancer maintenant</button>
            </div>

            <div class="cfg-tab" data-tab="build">
                <div class="section-title">🏗️ File de construction</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-buildqueue-enabled">
                        Lancement automatique des constructions
                    </label>
                    <div class="hint">Lance le prochain bâtiment de la file dès que la planète est libre et que les ressources sont disponibles</div>
                </div>

                <div class="config-group">
                    <label>Revérification si ressources insuffisantes (s)</label>
                    <input type="number" id="cfg-buildqueue-recheck" min="60" max="3600" style="width: 80px;">
                </div>

                <div class="section-title">Files en cours</div>
                <div id="cfg-buildqueue-container"></div>

                <div class="section-title">
                    📜 Journal
                    <button class="refresh-btn" id="cfg-buildqueue-log-refresh" title="Rafraîchir">🔄</button>
                </div>
                <pre id="cfg-buildqueue-log" class="bq-log"></pre>
            </div>

            <div class="cfg-tab" data-tab="autodef">
                <div class="section-title">🏰 Défense automatique</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-autodef-enabled">
                        Construire des défenses automatiquement
                    </label>
                    <div class="hint">Dès qu'une ressource atteint son seuil sur une planète, commande le maximum de chaque défense dans l'ordre choisi, en gardant toujours le stock minimum. Montants acceptés : 100M, 1,5G, 500k, 100.000.000 (vide ou 0 = ignoré).</div>
                </div>

                <div class="config-group">
                    <label>Tournée des planètes toutes les (min)</label>
                    <input type="number" id="cfg-autodef-interval" min="5" max="1440" style="width: 80px;">
                    <div class="hint">Une planète est revue au plus une fois par intervalle, plus tôt si sa production lui fait atteindre le seuil. Attend votre inactivité.</div>
                </div>

                <div class="hint" id="cfg-autodef-status"></div>

                <div class="section-title">Par planète/lune</div>
                <div id="cfg-autodef-container"></div>
            </div>

            <div class="cfg-tab" data-tab="alerts">
                <div class="section-title">💬 Discord</div>

                <div class="config-group">
                    <label>Webhook Discord</label>
                    <textarea id="cfg-webhook" rows="2" placeholder="https://discord.com/api/webhooks/..."></textarea>
                    <div class="hint">Stocké dans Tampermonkey (commun à tous les univers de ce navigateur), jamais dans le script</div>
                    <button class="btn-test" id="cfg-test-webhook">📨 Tester le webhook</button>
                </div>

                <div class="section-title">🔔 Alertes</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-alert-attack">
                        ⚔️ Alerte attaque
                    </label>
                </div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-alert-espionage">
                        🔍 Alerte espionnage
                    </label>
                </div>

                <div class="section-title">📊 Bilan des expéditions</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-report-enabled">
                        Envoyer un bilan périodique sur Discord
                    </label>
                    <div class="hint">Expéditions en cours, puis résultats de la période : ressources, antimatière, vaisseaux trouvés, avance/retard, combats et pertes, découvertes</div>
                </div>

                <div class="config-group">
                    <label>Intervalle (s)</label>
                    <input type="number" id="cfg-report-interval" min="60" style="width: 100px;">
                    <div class="hint">3600 = un bilan par heure</div>
                    <button class="btn-test" id="cfg-report-send">📨 Envoyer le bilan maintenant</button>
                    <div class="hint" id="cfg-report-status"></div>
                </div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-expedition-launch-alerts">
                        🚀 Message à chaque lancement d'expédition
                    </label>
                    <div class="hint">Désactivé : seules les erreurs de lancement sont signalées</div>
                </div>

                <div class="section-title">⏱️ Délai minimum entre deux alertes (s)</div>

                <div class="cfg-grid">
                    <div class="config-group">
                        <label>Attaque</label>
                        <input type="number" id="cfg-cd-attack" min="1">
                    </div>
                    <div class="config-group">
                        <label>Espionnage</label>
                        <input type="number" id="cfg-cd-espionage" min="1">
                    </div>
                    <div class="config-group" id="cfg-cd-expedition-group">
                        <label>Expédition</label>
                        <input type="number" id="cfg-cd-expedition" min="1">
                    </div>
                    <div class="config-group">
                        <label>Déconnexion</label>
                        <input type="number" id="cfg-cd-disconnected" min="1">
                    </div>
                </div>
            </div>

            <div class="cfg-tab" data-tab="stats">
                <div class="section-title">
                    📊 Flotte disponible
                    <button class="refresh-btn" id="cfg-stats-refresh" title="Actualiser">🔄</button>
                </div>
                <div id="cfg-stats-container"></div>
            </div>

            <div class="cfg-tab" data-tab="general">
                <div class="section-title">🔁 Cycle de vérification</div>

                <div class="config-group">
                    <label>Intervalle (s)</label>
                    <input type="number" id="cfg-expedition-check-interval" min="10" max="600" style="width: 80px;">
                    <div class="hint">Fréquence de vérification des alertes, expéditions et files de construction</div>
                </div>

                <div class="section-title">🖐️ Pause pendant que vous jouez</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-idle-enabled">
                        Attendre mon inactivité avant les actions automatiques
                    </label>
                    <div class="hint">Expéditions auto, files de construction et clic aléatoire attendent que vous n'ayez plus touché la souris ni le clavier. Le panic, le repli et les alertes ne sont jamais retardés.</div>
                </div>

                <div class="config-group">
                    <label>Délai d'inactivité (s)</label>
                    <input type="number" id="cfg-idle-delay" min="5" max="3600" style="width: 80px;">
                </div>

                <div class="section-title">🖱️ Clic aléatoire</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-random-click-enabled">
                        Activer le clic aléatoire
                    </label>
                    <div class="hint">Clique sur une planète aléatoire pour maintenir la session active</div>
                </div>

                <div class="config-group">
                    <label>Intervalle (s)</label>
                    <input type="number" id="cfg-random-click-interval" min="60" max="3600" style="width: 80px;">
                    <div class="hint">Clic aléatoire entre -30 s et +30 s de cette valeur (min : 60 s)</div>
                </div>

                <div class="section-title">🔄 Reconnexion</div>

                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-auto-reconnect">
                        Reconnexion automatique
                    </label>
                </div>

                <div class="config-group">
                    <label>Délai avant reconnexion (s)</label>
                    <input type="number" id="cfg-reconnect-delay" min="1" style="width: 80px;">
                </div>
            </div>

            </div>
            </div>

            <div class="btn-group">
                <button class="btn-save" id="cfg-save">💾 Sauvegarder</button>
                <button class="btn-reset" id="cfg-reset">🔄 Reset</button>
                <button class="btn-cancel" id="cfg-cancel">❌ Fermer</button>
            </div>
        `;
        dock.insertBefore(panel, toolbar);

        const showConfigTab = (name) => {
            panel.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
            try { localStorage.setItem('ogame_plugin_config_tab', name); } catch (e) {}
            if (name === 'stats' && panel.style.display === 'block') refreshFleetStats();
        };
        panel.querySelectorAll('.cfg-tabs button').forEach(btn => {
            btn.addEventListener('click', () => showConfigTab(btn.dataset.tab));
        });
        let initialTab = 'defense';
        try { initialTab = localStorage.getItem('ogame_plugin_config_tab') || initialTab; } catch (e) {}
        showConfigTab(panel.querySelector(`.cfg-tab[data-tab="${initialTab}"]`) ? initialTab : 'defense');

        updateWebhookIndicator();

        document.getElementById('ogame-plugin-btn').addEventListener('click', () => {
            panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
            document.getElementById('ogame-plugin-btn').classList.toggle('open', panel.style.display === 'block');
            dock.classList.toggle('cfg-open', panel.style.display === 'block');
            if (panel.style.display === 'block') {
                loadFormValues();
            }
        });

        document.getElementById('ogame-plugin-panic-btn').addEventListener('click', executePanic);

        document.getElementById('cfg-save').addEventListener('click', saveFormValues);
        document.getElementById('cfg-cancel').addEventListener('click', () => {
            closeConfigPanel();
        });
        document.getElementById('cfg-reset').addEventListener('click', () => {
            if (confirm('Réinitialiser la configuration par défaut ? (le webhook Discord est conservé)')) {
                CONFIG = { ...DEFAULT_CONFIG, discordWebhook: CONFIG.discordWebhook };
                saveConfig(CONFIG);
                loadFormValues();
            }
        });
        document.getElementById('cfg-test-webhook').addEventListener('click', async () => {
            const btn = document.getElementById('cfg-test-webhook');
            const url = document.getElementById('cfg-webhook').value.trim();
            if (!url) {
                btn.textContent = '⚠️ Saisissez d\'abord une URL';
                setTimeout(() => { btn.textContent = '📨 Tester le webhook'; }, 3000);
                return;
            }
            const previous = CONFIG.discordWebhook;
            CONFIG.discordWebhook = url;
            btn.textContent = '⏳ Envoi...';
            const ok = await notifyDiscord(`✅ Test OgOwnax Plugin v${GM_info.script.version} depuis ${window.location.hostname}`);
            CONFIG.discordWebhook = previous;
            btn.textContent = ok ? '✅ Webhook OK' : '❌ Échec (voir console)';
            setTimeout(() => { btn.textContent = '📨 Tester le webhook'; }, 3000);
        });
        document.getElementById('cfg-expedition-launch-alerts').addEventListener('change', updateExpeditionCooldownVisibility);
        document.getElementById('cfg-report-send').addEventListener('click', async () => {
            const btn = document.getElementById('cfg-report-send');
            if (!CONFIG.discordWebhook) {
                btn.textContent = '⚠️ Webhook non configuré';
                setTimeout(() => { btn.textContent = '📨 Envoyer le bilan maintenant'; }, 3000);
                return;
            }
            btn.disabled = true;
            btn.textContent = '⏳ Lecture des messages...';
            let text;
            try {
                const { ok } = await sendExpeditionReport(true);
                text = ok ? '✅ Bilan envoyé' : '❌ Échec de l\'envoi Discord';
            } catch (e) {
                text = `❌ Erreur : ${e.message}`;
            }
            btn.disabled = false;
            btn.textContent = text;
            setTimeout(() => { btn.textContent = '📨 Envoyer le bilan maintenant'; }, 4000);
        });
        document.getElementById('cfg-refresh-expeditions').addEventListener('click', () => {
            renderExpeditionsConfig();
            renderFleeDestinations();
        });
        document.getElementById('cfg-launch-expeditions').addEventListener('click', launchMissingExpeditions);
        document.getElementById('cfg-buildqueue-log-refresh').addEventListener('click', renderBuildLog);
        document.getElementById('cfg-expedition-mode').addEventListener('change', updateExpeditionModeVisibility);
        document.getElementById('cfg-stats-refresh').addEventListener('click', refreshFleetStats);
        document.getElementById('cfg-discovery-run').addEventListener('click', async () => {
            const btn = document.getElementById('cfg-discovery-run');
            if (!CONFIG.discovery.enabled) {
                btn.textContent = '⚠️ Cochez « Lancer les découvertes » puis sauvegardez';
                setTimeout(() => { btn.textContent = '🔭 Lancer maintenant'; }, 3000);
                return;
            }
            btn.disabled = true;
            btn.textContent = '⏳ Découvertes…';
            // Clic de votre part : pas d'attente d'inactivité
            const previousIdle = CONFIG.idle.enabled;
            CONFIG.idle.enabled = false;
            let result = null;
            try {
                result = await runDiscovery(true);
            } catch (e) {
                result = `Erreur : ${e.message}`;
            } finally {
                CONFIG.idle.enabled = previousIdle;
                btn.disabled = false;
                btn.textContent = `🔭 ${result || 'Terminé'}`;
                renderDiscoveryStatus();
                setTimeout(() => { btn.textContent = '🔭 Lancer maintenant'; }, 6000);
            }
        });
    }

    function updateWebhookIndicator() {
        const btn = document.getElementById('ogame-plugin-btn');
        if (!btn) return;
        if (CONFIG.discordWebhook) {
            btn.classList.remove('no-webhook');
            btn.title = '';
        } else {
            btn.classList.add('no-webhook');
            btn.title = 'Webhook Discord non configuré : aucune notification ne sera envoyée';
        }
    }

    function renderPanicSelects() {
        const sourceSelect = document.getElementById('cfg-panic-source');
        const destSelect = document.getElementById('cfg-panic-destination');

        if (!sourceSelect || !destSelect) return;

        const planets = getPlanets();
        const moons = getMoons();

        let sourceHtml = '<option value="">-- Sélectionner --</option>';
        let destHtml = '<option value="">-- Sélectionner --</option>';

        sourceHtml += '<optgroup label="🌍 Planètes">';
        destHtml += '<optgroup label="🌍 Planètes">';
        planets.forEach(p => {
            sourceHtml += `<option value="planet_${p.id}">${p.name} [${p.coords}]</option>`;
            destHtml += `<option value="planet_${p.id}">${p.name} [${p.coords}]</option>`;
        });
        sourceHtml += '</optgroup>';
        destHtml += '</optgroup>';

        if (moons.length > 0) {
            sourceHtml += '<optgroup label="🌙 Lunes">';
            destHtml += '<optgroup label="🌙 Lunes">';
            moons.forEach(m => {
                sourceHtml += `<option value="moon_${m.id}">Lune [${m.coords}]</option>`;
                destHtml += `<option value="moon_${m.id}">Lune [${m.coords}]</option>`;
            });
            sourceHtml += '</optgroup>';
            destHtml += '</optgroup>';
        }

        sourceSelect.innerHTML = sourceHtml;
        destSelect.innerHTML = destHtml;

        if (CONFIG.panic.sourceId && CONFIG.panic.sourceType) {
            sourceSelect.value = `${CONFIG.panic.sourceType}_${CONFIG.panic.sourceId}`;
        }
        if (CONFIG.panic.destinationId && CONFIG.panic.destinationType) {
            destSelect.value = `${CONFIG.panic.destinationType}_${CONFIG.panic.destinationId}`;
        }
    }

    function renderFleeDestinations() {
        const container = document.getElementById('cfg-flee-destinations-container');
        if (!container) return;

        const planets = getPlanets();
        const moons = getMoons();
        const bodies = getAllCelestialBodies();

        if (bodies.length === 0) {
            container.innerHTML = '<div class="no-bodies">Aucune planète ou lune détectée</div>';
            return;
        }

        let optionsHtml = '<option value="">-- Aucun --</option>';
        optionsHtml += '<optgroup label="🌍 Planètes">';
        planets.forEach(p => {
            optionsHtml += `<option value="planet|${p.coords}">${p.name} [${p.coords}]</option>`;
        });
        optionsHtml += '</optgroup>';

        if (moons.length > 0) {
            optionsHtml += '<optgroup label="🌙 Lunes">';
            moons.forEach(m => {
                optionsHtml += `<option value="moon|${m.coords}">Lune [${m.coords}]</option>`;
            });
            optionsHtml += '</optgroup>';
        }

        let html = '';

        planets.forEach(planet => {
            const planetKey = getBodyKey('planet', planet.coords);
            const currentDest = CONFIG.fleeConfig.destinations[planetKey];
            let selectedValue = '';
            if (currentDest) {
                selectedValue = `${currentDest.type}|${currentDest.coords}`;
            }

            html += `
                <div class="flee-row">
                    <div class="flee-source">🌍 ${planet.name} [${planet.coords}]</div>
                    <div class="flee-dest">
                        <select class="cfg-flee-dest" data-source-key="${planetKey}">
                            ${optionsHtml.replace(`value="${selectedValue}"`, `value="${selectedValue}" selected`)}
                        </select>
                    </div>
                </div>
            `;

            const moon = moons.find(m => m.coords === planet.coords);
            if (moon) {
                const moonKey = getBodyKey('moon', moon.coords);
                const moonDest = CONFIG.fleeConfig.destinations[moonKey];
                let moonSelectedValue = '';
                if (moonDest) {
                    moonSelectedValue = `${moonDest.type}|${moonDest.coords}`;
                }

                html += `
                    <div class="flee-row moon-row">
                        <div class="flee-source">🌙 Lune [${moon.coords}]</div>
                        <div class="flee-dest">
                            <select class="cfg-flee-dest" data-source-key="${moonKey}">
                                ${optionsHtml.replace(`value="${moonSelectedValue}"`, `value="${moonSelectedValue}" selected`)}
                            </select>
                        </div>
                    </div>
                `;
            }
        });

        container.innerHTML = html;
    }

    function renderExpeditionsConfig() {
        const container = document.getElementById('cfg-expeditions-container');
        const summary = getExpeditionsSummary();

        if (summary.length === 0) {
            container.innerHTML = '<div class="no-bodies">Aucune planète ou lune détectée</div>';
            updateLaunchButton();
            return;
        }

        let html = '';

        const planets = getPlanets();

        planets.forEach(planet => {
            const planetSummary = summary.find(s => s.type === 'planet' && s.coords === planet.coords);
            if (!planetSummary) return;

            const expectedCount = CONFIG.expeditionsPerBody[planetSummary.key] || 0;

            let counterClass = 'none';
            if (expectedCount > 0) {
                counterClass = planetSummary.active >= expectedCount ? 'ok' : 'missing';
            }

            html += `
                <div class="body-expedition-row">
                    <div class="body-info">
                        <span class="body-name"><span class="body-icon">🌍</span>${planet.name}</span>
                        <span class="body-coords">[${planet.coords}]</span>
                    </div>
                    <div class="expedition-status">
                        <span class="expedition-counter ${counterClass}">${planetSummary.active} / <span class="expected-value" data-key="${planetSummary.key}">${expectedCount}</span></span>
                        <input type="number"
                               class="cfg-body-expedition"
                               data-key="${planetSummary.key}"
                               value="${expectedCount}"
                               min="0"
                               max="20"
                               title="Nombre d'expéditions à lancer">
                    </div>
                </div>
            `;

            const moonSummary = summary.find(s => s.type === 'moon' && s.coords === planet.coords);
            if (moonSummary) {
                const moonExpectedCount = CONFIG.expeditionsPerBody[moonSummary.key] || 0;

                let moonCounterClass = 'none';
                if (moonExpectedCount > 0) {
                    moonCounterClass = moonSummary.active >= moonExpectedCount ? 'ok' : 'missing';
                }

                html += `
                    <div class="body-expedition-row moon-row">
                        <div class="body-info">
                            <span class="body-name"><span class="body-icon">🌙</span>Lune</span>
                            <span class="body-coords">[${moonSummary.coords}]</span>
                        </div>
                        <div class="expedition-status">
                            <span class="expedition-counter ${moonCounterClass}">${moonSummary.active} / <span class="expected-value" data-key="${moonSummary.key}">${moonExpectedCount}</span></span>
                            <input type="number"
                                   class="cfg-body-expedition"
                                   data-key="${moonSummary.key}"
                                   value="${moonExpectedCount}"
                                   min="0"
                                   max="20"
                                   title="Nombre d'expéditions à lancer">
                        </div>
                    </div>
                `;
            }
        });

        const totalActive = getTotalActiveExpeditions();
        const totalExpected = getTotalExpectedExpeditions();
        const totalMissing = getTotalMissingExpeditions();
        const totalFinished = getTotalFinishedExpeditions();
        const hasClass = totalMissing > 0 ? 'has-missing' : '';

        html += `
            <div class="expeditions-total">
                <span class="total-label">Total expéditions :</span>
                <span class="total-value ${hasClass}" id="cfg-expeditions-total">${totalActive} / ${totalExpected}${totalMissing > 0 ? ` (${totalMissing} manquante${totalMissing > 1 ? 's' : ''})` : ''}${totalFinished > 0 ? ` (${totalFinished} terminée${totalFinished > 1 ? 's' : ''})` : ''}</span>
            </div>
        `;

        container.innerHTML = html;

        container.querySelectorAll('.cfg-body-expedition').forEach(input => {
            input.addEventListener('input', (e) => {
                updateExpeditionsDisplay(e.target);
            });
        });

        updateLaunchButton();
    }

    function updateExpeditionsDisplay(changedInput) {
        const key = changedInput.dataset.key;
        const newValue = parseInt(changedInput.value) || 0;

        const expectedEl = document.querySelector(`.expected-value[data-key="${key}"]`);
        if (expectedEl) {
            expectedEl.textContent = newValue;
        }

        const row = changedInput.closest('.body-expedition-row');
        const counterEl = row.querySelector('.expedition-counter');
        const activeCount = parseInt(counterEl.textContent.split('/')[0].trim()) || 0;

        counterEl.classList.remove('ok', 'missing', 'none');
        if (newValue > 0) {
            counterEl.classList.add(activeCount >= newValue ? 'ok' : 'missing');
        } else {
            counterEl.classList.add('none');
        }

        updateExpeditionsTotal();
        updateLaunchButton();
    }

    function updateExpeditionsTotal() {
        const inputs = document.querySelectorAll('.cfg-body-expedition');
        const summary = getExpeditionsSummary();
        let totalExpected = 0;
        let totalActive = getTotalActiveExpeditions();

        inputs.forEach(input => {
            totalExpected += parseInt(input.value) || 0;
        });

        let totalMissing = 0;
        inputs.forEach(input => {
            const key = input.dataset.key;
            const expected = parseInt(input.value) || 0;
            const bodySummary = summary.find(b => b.key === key);
            const active = bodySummary ? bodySummary.active : 0;
            totalMissing += Math.max(0, expected - active);
        });

        const totalFinished = getTotalFinishedExpeditions();

        const totalEl = document.getElementById('cfg-expeditions-total');
        if (totalEl) {
            const hasClass = totalMissing > 0 ? 'has-missing' : '';
            totalEl.className = `total-value ${hasClass}`;
            totalEl.textContent = `${totalActive} / ${totalExpected}${totalMissing > 0 ? ` (${totalMissing} manquante${totalMissing > 1 ? 's' : ''})` : ''}${totalFinished > 0 ? ` (${totalFinished} terminée${totalFinished > 1 ? 's' : ''})` : ''}`;
        }
    }

    function updateLaunchButton() {
        const btn = document.getElementById('cfg-launch-expeditions');
        if (!btn) return;

        const inputs = document.querySelectorAll('.cfg-body-expedition');
        const summary = getExpeditionsSummary();

        let totalMissing = 0;
        inputs.forEach(input => {
            const key = input.dataset.key;
            const expected = parseInt(input.value) || 0;
            const bodySummary = summary.find(b => b.key === key);
            const active = bodySummary ? bodySummary.active : 0;
            totalMissing += Math.max(0, expected - active);
        });

        btn.disabled = totalMissing === 0;
        btn.textContent = totalMissing > 0
            ? `🚀 Lancer ${totalMissing} expédition${totalMissing > 1 ? 's' : ''} manquante${totalMissing > 1 ? 's' : ''}`
            : '✅ Toutes les expéditions sont lancées';
    }

    // Liste des flottes enregistrées vues sur la page Flotte (+ celle configurée si elle n'y est plus)
    function renderExpeditionTemplateOptions() {
        const select = document.getElementById('cfg-expedition-template');
        if (!select) return;
        const names = loadFleetTemplates();
        if (CONFIG.expeditionTemplate && !names.includes(CONFIG.expeditionTemplate)) {
            names.push(CONFIG.expeditionTemplate);
        }
        const escape = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        select.innerHTML = names.length === 0
            ? '<option value="">— Ouvrez la page Flotte pour charger la liste —</option>'
            : names.map(n => `<option value="${escape(n)}">${escape(n)}</option>`).join('');
        if (CONFIG.expeditionTemplate) select.value = CONFIG.expeditionTemplate;
    }

    function updateExpeditionModeVisibility() {
        const mode = document.getElementById('cfg-expedition-mode')?.value;
        const keyGroup = document.getElementById('cfg-expedition-key-group');
        const templateGroup = document.getElementById('cfg-expedition-template-group');
        const usesTemplate = mode === 'template' || mode === 'direct';
        if (keyGroup) keyGroup.style.display = usesTemplate ? 'none' : '';
        if (templateGroup) templateGroup.style.display = usesTemplate ? '' : 'none';
        const directHint = document.getElementById('cfg-expedition-direct-hint');
        if (directHint) directHint.style.display = mode === 'direct' ? '' : 'none';
    }

    function loadFormValues() {
        document.getElementById('cfg-alert-attack').checked = CONFIG.alertAttack;
        document.getElementById('cfg-alert-espionage').checked = CONFIG.alertEspionage;
        document.getElementById('cfg-webhook').value = CONFIG.discordWebhook;
        document.getElementById('cfg-report-enabled').checked = CONFIG.expeditionReport.enabled;
        document.getElementById('cfg-report-interval').value = CONFIG.expeditionReport.interval;
        document.getElementById('cfg-expedition-launch-alerts').checked = !!CONFIG.expeditionLaunchAlerts;
        updateExpeditionCooldownVisibility();
        renderExpeditionReportStatus();
        document.getElementById('cfg-auto-launch').checked = CONFIG.autoLaunchExpeditions;
        document.getElementById('cfg-expedition-key').value = CONFIG.expeditionKey === 's' ? 's' : 'l';
        document.getElementById('cfg-expedition-mode').value = ['template', 'direct'].includes(CONFIG.expeditionMode) ? CONFIG.expeditionMode : 'key';
        renderExpeditionTemplateOptions();
        updateExpeditionModeVisibility();
        document.getElementById('cfg-expedition-start-hour').value = CONFIG.expeditionStartHour !== null ? CONFIG.expeditionStartHour : '';
        document.getElementById('cfg-expedition-end-hour').value = CONFIG.expeditionEndHour !== null ? CONFIG.expeditionEndHour : '';
        document.getElementById('cfg-expedition-check-interval').value = CONFIG.expeditionCheckInterval / 1000;
        document.getElementById('cfg-random-click-enabled').checked = CONFIG.randomClickEnabled;
        document.getElementById('cfg-random-click-interval').value = CONFIG.randomClickInterval;
        document.getElementById('cfg-cd-expedition').value = CONFIG.cooldowns.expedition / 1000;
        document.getElementById('cfg-cd-attack').value = CONFIG.cooldowns.attack / 1000;
        document.getElementById('cfg-cd-espionage').value = CONFIG.cooldowns.espionage / 1000;
        document.getElementById('cfg-cd-disconnected').value = CONFIG.cooldowns.disconnected / 1000;
        document.getElementById('cfg-auto-reconnect').checked = CONFIG.autoReconnect;
        document.getElementById('cfg-reconnect-delay').value = CONFIG.reconnectDelay / 1000;
        document.getElementById('cfg-panic-speed').value = CONFIG.panic.speed || 10;
        document.getElementById('cfg-panic-auto').checked = CONFIG.panic.autoPanicOnAttack || false;
        document.getElementById('cfg-panic-delay').value = CONFIG.panic.autoPanicDelay || 10;

        document.getElementById('cfg-flee-enabled').checked = CONFIG.fleeConfig.enabled || false;
        document.getElementById('cfg-flee-speed').value = CONFIG.fleeConfig.speed || 10;
        document.getElementById('cfg-flee-delay').value = CONFIG.fleeConfig.delayBeforeImpact || 30;

        document.getElementById('cfg-buildqueue-enabled').checked = CONFIG.buildQueue.enabled;
        document.getElementById('cfg-buildqueue-recheck').value = CONFIG.buildQueue.recheckInterval;
        document.getElementById('cfg-idle-enabled').checked = CONFIG.idle.enabled;
        document.getElementById('cfg-idle-delay').value = CONFIG.idle.delay;
        document.getElementById('cfg-discovery-enabled').checked = CONFIG.discovery.enabled;
        document.getElementById('cfg-discovery-origin').innerHTML = '<option value="">-- Choisir --</option>'
            + getAllCelestialBodies().map(b => `<option value="${b.id}">${b.type === 'moon' ? '🌙 Lune' : `🪐 ${b.name}`} [${b.coords}]</option>`).join('');
        document.getElementById('cfg-discovery-origin').value = CONFIG.discovery.originId || '';
        document.getElementById('cfg-discovery-from').value = CONFIG.discovery.from || '';
        document.getElementById('cfg-discovery-to').value = CONFIG.discovery.to || '';
        document.getElementById('cfg-discovery-keep-free').value = CONFIG.discovery.keepFreeSlots || 0;
        document.getElementById('cfg-discovery-max-active').value = CONFIG.discovery.maxActive || 0;
        document.getElementById('cfg-discovery-interval').value = CONFIG.discovery.interval || 5;
        renderDiscoveryStatus();
        document.getElementById('cfg-autodef-enabled').checked = CONFIG.autoDefense.enabled;
        document.getElementById('cfg-autodef-interval').value = CONFIG.autoDefense.interval;
        renderAutoDefenseConfig();
        renderAutoDefenseStatus();

        renderPanicSelects();
        renderExpeditionsConfig();
        renderFleeDestinations();
        renderBuildQueueConfig();
        renderBuildLog();
        if (document.querySelector('#ogame-plugin-panel .cfg-tab.active')?.dataset.tab === 'stats') {
            refreshFleetStats();
        }
    }

    function saveFormValues() {
        const expeditionsPerBody = {};
        document.querySelectorAll('.cfg-body-expedition').forEach(input => {
            const key = input.dataset.key;
            const value = parseInt(input.value) || 0;
            expeditionsPerBody[key] = value;
        });

        const fleeDestinations = {};
        document.querySelectorAll('.cfg-flee-dest').forEach(select => {
            const sourceKey = select.dataset.sourceKey;
            const value = select.value;
            if (value) {
                const parts = value.split('|');
                if (parts.length === 2) {
                    fleeDestinations[sourceKey] = {
                        type: parts[0],
                        coords: parts[1]
                    };
                    console.log(`[Config] Flee destination pour ${sourceKey}: ${parts[0]} [${parts[1]}]`);
                }
            }
        });

        const randomClickInterval = Math.max(60, parseInt(document.getElementById('cfg-random-click-interval').value) || 570);

        const startHourValue = document.getElementById('cfg-expedition-start-hour').value;
        const endHourValue = document.getElementById('cfg-expedition-end-hour').value;
        const expeditionStartHour = startHourValue !== '' ? parseInt(startHourValue) : null;
        const expeditionEndHour = endHourValue !== '' ? parseInt(endHourValue) : null;

        const panicSourceValue = document.getElementById('cfg-panic-source').value;
        const panicDestValue = document.getElementById('cfg-panic-destination').value;

        let panicSourceId = null;
        let panicSourceType = 'planet';
        let panicDestinationId = null;
        let panicDestinationType = 'planet';

        if (panicSourceValue) {
            const [type, id] = panicSourceValue.split('_');
            panicSourceType = type;
            panicSourceId = id;
        }

        if (panicDestValue) {
            const [type, id] = panicDestValue.split('_');
            panicDestinationType = type;
            panicDestinationId = id;
        }

        CONFIG = {
            ...CONFIG,
            alertAttack: document.getElementById('cfg-alert-attack').checked,
            alertEspionage: document.getElementById('cfg-alert-espionage').checked,
            discordWebhook: document.getElementById('cfg-webhook').value.trim(),
            expeditionsPerBody,
            autoLaunchExpeditions: document.getElementById('cfg-auto-launch').checked,
            expeditionKey: document.getElementById('cfg-expedition-key').value === 's' ? 's' : 'l',
            expeditionMode: ['template', 'direct'].includes(document.getElementById('cfg-expedition-mode').value) ? document.getElementById('cfg-expedition-mode').value : 'key',
            expeditionTemplate: document.getElementById('cfg-expedition-template').value || '',
            expeditionStartHour,
            expeditionEndHour,
            expeditionCheckInterval: (parseInt(document.getElementById('cfg-expedition-check-interval').value) || 60) * 1000,
            randomClickEnabled: document.getElementById('cfg-random-click-enabled').checked,
            randomClickInterval,
            cooldowns: {
                expedition: (parseInt(document.getElementById('cfg-cd-expedition').value) || 1800) * 1000,
                attack: (parseInt(document.getElementById('cfg-cd-attack').value) || 60) * 1000,
                espionage: (parseInt(document.getElementById('cfg-cd-espionage').value) || 60) * 1000,
                disconnected: (parseInt(document.getElementById('cfg-cd-disconnected').value) || 60) * 1000,
            },
            autoReconnect: document.getElementById('cfg-auto-reconnect').checked,
            reconnectDelay: (parseInt(document.getElementById('cfg-reconnect-delay').value) || 300) * 1000,
            panic: {
                sourceId: panicSourceId,
                sourceType: panicSourceType,
                destinationId: panicDestinationId,
                destinationType: panicDestinationType,
                speed: parseInt(document.getElementById('cfg-panic-speed').value) || 10,
                autoPanicOnAttack: document.getElementById('cfg-panic-auto').checked,
                autoPanicDelay: parseInt(document.getElementById('cfg-panic-delay').value) || 10,
            },
            fleeConfig: {
                enabled: document.getElementById('cfg-flee-enabled').checked,
                speed: parseInt(document.getElementById('cfg-flee-speed').value) || 10,
                delayBeforeImpact: parseInt(document.getElementById('cfg-flee-delay').value) || 30,
                destinations: fleeDestinations
            },
            buildQueue: {
                enabled: document.getElementById('cfg-buildqueue-enabled').checked,
                recheckInterval: Math.max(60, parseInt(document.getElementById('cfg-buildqueue-recheck').value) || 60),
            },
            idle: {
                enabled: document.getElementById('cfg-idle-enabled').checked,
                delay: Math.max(5, parseInt(document.getElementById('cfg-idle-delay').value) || 60),
            },
            discovery: {
                enabled: document.getElementById('cfg-discovery-enabled').checked,
                originId: document.getElementById('cfg-discovery-origin').value,
                from: document.getElementById('cfg-discovery-from').value.trim(),
                to: document.getElementById('cfg-discovery-to').value.trim(),
                keepFreeSlots: Math.max(0, parseInt(document.getElementById('cfg-discovery-keep-free').value) || 0),
                maxActive: Math.max(0, parseInt(document.getElementById('cfg-discovery-max-active').value) || 0),
                interval: Math.max(1, parseInt(document.getElementById('cfg-discovery-interval').value) || 5),
            },
            autoDefense: {
                enabled: document.getElementById('cfg-autodef-enabled').checked,
                interval: Math.max(5, parseInt(document.getElementById('cfg-autodef-interval').value) || 30),
                bodies: collectAutoDefenseBodies(),
            },
            expeditionReport: {
                enabled: document.getElementById('cfg-report-enabled').checked,
                interval: Math.max(60, parseInt(document.getElementById('cfg-report-interval').value) || 3600),
            },
            expeditionLaunchAlerts: document.getElementById('cfg-expedition-launch-alerts').checked,
        };

        saveConfig(CONFIG);
        renderBuildQueuePanel();
        updateWebhookIndicator();
        closeConfigPanel();
        // Confirmation dans la page (pas de popup navigateur)
        const settingsBtn = document.getElementById('ogame-plugin-btn');
        if (settingsBtn) {
            settingsBtn.textContent = '✅ Sauvegardé';
            setTimeout(() => { settingsBtn.textContent = '⚙️ OgOwnax'; }, 2000);
        }
        const { discordWebhook, ...loggable } = CONFIG;
        console.log('[Monitor] Configuration mise à jour:', loggable);
    }

    // ===== File de construction (par planète/lune) =====

    const SERVER_OFFSET_MS = (() => {
        const meta = document.querySelector('meta[name="ogame-timestamp"]');
        return meta ? parseInt(meta.getAttribute('content')) * 1000 - Date.now() : 0;
    })();

    // Chargement de la page : tout ce qui s'est passé après (lancement…) n'est pas reflété par les tuiles
    const PAGE_START_TIME = Date.now();

    function serverSecondsToLocalMs(seconds) {
        return seconds * 1000 - SERVER_OFFSET_MS;
    }

    // Journal conservé (localStorage de l'univers) pour comprendre après coup ce qu'a fait la file
    const BUILD_LOG_KEY = 'ogame_plugin_build_log';
    const BUILD_LOG_SIZE = 80;

    function buildLog(...args) {
        const text = args
            .map(a => a instanceof Error ? a.message : (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' ');
        console.log('[Build]', text);
        try {
            const log = JSON.parse(localStorage.getItem(BUILD_LOG_KEY) || '[]');
            log.push({ t: Date.now(), p: getCurrentPlanetCoords(), m: text });
            localStorage.setItem(BUILD_LOG_KEY, JSON.stringify(log.slice(-BUILD_LOG_SIZE)));
        } catch (e) {}
    }

    function renderBuildLog() {
        const container = document.getElementById('cfg-buildqueue-log');
        if (!container) return;
        let log = [];
        try {
            log = JSON.parse(localStorage.getItem(BUILD_LOG_KEY) || '[]');
        } catch (e) {}
        if (log.length === 0) {
            container.textContent = 'Journal vide';
            return;
        }
        container.textContent = log.slice().reverse().map(entry => {
            const d = new Date(entry.t);
            const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
            return `${time} [${entry.p || '?'}] ${entry.m}`;
        }).join('\n');
    }

    function loadBuildQueues() {
        try {
            return JSON.parse(localStorage.getItem(BUILD_QUEUE_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function saveBuildQueues(queues) {
        localStorage.setItem(BUILD_QUEUE_KEY, JSON.stringify(queues));
        scheduleNextBuildCheck();
    }

    function loadBuildState() {
        try {
            return JSON.parse(localStorage.getItem(BUILD_STATE_KEY));
        } catch (e) {
            return null;
        }
    }

    function saveBuildState(state) {
        localStorage.setItem(BUILD_STATE_KEY, JSON.stringify(state));
    }

    function clearBuildState() {
        localStorage.removeItem(BUILD_STATE_KEY);
    }

    // Verrous propres à cet onglet : une file évaluée sur place (détail ouvert), et un lancement qui attend
    // la réponse d'OGame. Le lancement OGame ne précise pas la planète : il vaut pour la planète « courante »
    // du serveur, qu'une navigation ou une découverte (cp=…) ne doit pas changer entre-temps.
    let buildEvaluating = false;
    let launchLockUntil = 0;

    function isActionInProgress() {
        return buildEvaluating || discoveryRunning || expeditionDirectRunning || Date.now() < launchLockUntil || isNavigationInProgress();
    }

    // Action enregistrée qui se poursuit de page en page (lancement d'expéditions, panic, repli, file, défense)
    function isNavigationInProgress() {
        const launchState = loadLaunchState();
        const panicState = loadPanicState();
        const fleeState = loadFleeState();
        const buildState = loadBuildState();
        const defenseState = loadDefenseState();
        const hasActiveFlee = Object.values(fleeState).some(s => s && s.active);
        return !!((launchState && launchState.active) || (panicState && panicState.active) || hasActiveFlee || (buildState && buildState.active)
            || (defenseState && defenseState.active));
    }

    function getCurrentBody() {
        const nameMeta = document.querySelector('meta[name="ogame-planet-name"]');
        return {
            id: getCurrentPlanetId(),
            type: getCurrentPlanetType(),
            coords: getCurrentPlanetCoords(),
            name: nameMeta ? nameMeta.getAttribute('content') : '',
        };
    }

    function getLaneOfComponent(component) {
        return Object.keys(BUILD_LANES).find(lane => BUILD_LANES[lane].pages.includes(component)) || null;
    }

    // Clé de stockage d'une file : l'id de la planète pour les bâtiments (compatible avec les files existantes),
    // « id|lf » pour les formes de vie, « id|lr » pour les recherches de formes de vie, « id|rs » pour la recherche
    const LANE_KEY_SUFFIX = { lifeform: '|lf', lfresearch: '|lr', research: '|rs' };

    function getQueueKey(planetId, lane) {
        return `${planetId}${LANE_KEY_SUFFIX[lane] || ''}`;
    }

    function getQueuePlanetId(key) {
        return String(key).split('|')[0];
    }

    function getQueueLane(key) {
        const suffix = '|' + (String(key).split('|')[1] || '');
        return Object.keys(LANE_KEY_SUFFIX).find(lane => LANE_KEY_SUFFIX[lane] === suffix) || 'building';
    }

    const isResearchLane = lane => lane === 'research' || lane === 'lfresearch';

    const LANE_ICONS = { building: '🏗️', lifeform: '🧬', lfresearch: '🧪', research: '🔬' };

    function getLaneLabel(lane) {
        return { building: 'File de construction', lifeform: 'File formes de vie', lfresearch: 'File recherches formes de vie', research: 'File de recherche' }[lane];
    }

    function getBuildingTiles() {
        const lane = getLaneOfComponent(getCurrentPage());
        if (!lane) return [];
        return [...document.querySelectorAll('#technologies li.technology[data-technology]')]
            .filter(tile => BUILD_LANES[lane].isTechnology(parseInt(tile.dataset.technology)));
    }

    // Constructions en cours vues sur chaque planète : { planetId: { building: {technologyId, end}, lifeform: {...} } }
    // Nécessaire car la page Formes de vie n'affiche pas le cadre « Bâtiment » (et inversement)
    function loadConstructionInfo() {
        try {
            return JSON.parse(localStorage.getItem(BUILD_INFO_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function recordConstructionInfoHere() {
        const planetId = getCurrentPlanetId();
        if (!planetId) return;
        const info = loadConstructionInfo();
        const planetInfo = info[planetId] || {};
        let changed = false;
        Object.keys(BUILD_LANES).forEach(lane => {
            const box = document.querySelector(BUILD_LANES[lane].box);
            if (!box) return;
            const countdown = box.querySelector('[data-end]');
            let technologyId = null;
            if (countdown) {
                // ex. onclick="cancelbuilding(14, 12095, ...)" ; repli sur la tuile en construction si elle est affichée
                const cancel = [...box.querySelectorAll('[onclick]')].map(e => e.getAttribute('onclick')).find(s => /cancel\w*\(\s*\d+/.test(s));
                const match = cancel && cancel.match(/cancel\w*\(\s*(\d+)/);
                const activeTile = document.querySelector('#technologies li.technology[data-status="active"]');
                technologyId = match ? parseInt(match[1]) : (activeTile && getLaneOfComponent(getCurrentPage()) === lane ? parseInt(activeTile.dataset.technology) : null);
            }
            const entry = {
                technologyId,
                end: countdown ? serverSecondsToLocalMs(parseInt(countdown.dataset.end)) : 0,
                seenAt: Date.now(),
            };
            // La recherche en cours vaut pour tout le compte, quelle que soit la planète affichée
            if (BUILD_LANES[lane].accountWide) {
                info[ACCOUNT_INFO_KEY] = { ...(info[ACCOUNT_INFO_KEY] || {}), [lane]: entry };
            } else {
                planetInfo[lane] = entry;
            }
            changed = true;
        });
        if (changed) {
            info[planetId] = planetInfo;
            localStorage.setItem(BUILD_INFO_KEY, JSON.stringify(info));
        }
    }

    // Contraintes entre files : { reason, until } ou null
    // - usine de robots/nanites ↔ formes de vie (même planète)
    // - laboratoire de recherche (planète) ↔ recherche (compte)
    function getLaneBlocker(planetId, lane, item, now = Date.now()) {
        const allInfo = loadConstructionInfo();
        const info = allInfo[planetId] || {};
        const research = (allInfo[ACCOUNT_INFO_KEY] || {}).research;
        const b = info.building;

        if (lane === 'lifeform') {
            if (b && b.end > now && LIFEFORM_BLOCKING_BUILDINGS[b.technologyId]) {
                return { reason: `${LIFEFORM_BLOCKING_BUILDINGS[b.technologyId]} en construction`, until: b.end };
            }
        } else if (lane === 'research') {
            if (research && research.end > now) {
                return { reason: 'Recherche en cours', until: research.end };
            }
            if (b && b.end > now && b.technologyId === RESEARCH_LAB_ID) {
                return { reason: 'Laboratoire de recherche en extension', until: b.end };
            }
        } else if (lane === 'building' && item) {
            if (LIFEFORM_BLOCKING_BUILDINGS[item.technologyId]) {
                const l = info.lifeform;
                if (l && l.end > now) {
                    return { reason: 'Bâtiment de forme de vie en construction', until: l.end };
                }
            }
            if (item.technologyId === RESEARCH_LAB_ID && research && research.end > now) {
                return { reason: 'Recherche en cours', until: research.end };
            }
        }
        return null;
    }

    function getBuildingTile(technologyId) {
        return document.querySelector(`#technologies li.technology[data-technology="${technologyId}"]`);
    }

    // Niveau atteint une fois la construction en cours terminée
    function getTileReachedLevel(tile) {
        const target = tile.querySelector('.targetlevel');
        if (tile.dataset.status === 'active' && target) {
            return parseInt(target.dataset.value) || 0;
        }
        const level = tile.querySelector('.level');
        return level ? parseInt(level.dataset.value) || 0 : 0;
    }

    function getTileReason(tile) {
        // OGame déplace le title vers data-tooltip-title une fois l'infobulle initialisée
        const title = tile.getAttribute('title') || tile.dataset.tooltipTitle || tile.dataset.title || '';
        const parts = title.split(/<br\s*\/?>/i);
        return parts.length > 1 ? parts.slice(1).join(' ').replace(/<[^>]+>/g, '').trim() : '';
    }

    // Fin (heure locale, ms) de la construction en cours de cette file sur la planète affichée
    function getConstructionEnd(lane = 'building') {
        const box = document.querySelector(BUILD_LANES[lane].box);
        if (!box) return null;
        // Même vide (« Aucun bâtiment en construction »), le cadre garde table.construction.active :
        // seul le compte à rebours indique une construction réelle
        const countdown = box.querySelector('time.buildingCountdown[data-end], [data-end]');
        if (!countdown) return 0;
        return serverSecondsToLocalMs(parseInt(countdown.dataset.end));
    }

    // Ajoute les niveaux manquants jusqu'à `upToLevel` (par défaut : le niveau suivant)
    function addToBuildQueue(tile, upToLevel = null) {
        const body = getCurrentBody();
        const component = getCurrentPage();
        const lane = getLaneOfComponent(component);
        if (!body.id || !lane) return 0;

        const technologyId = parseInt(tile.dataset.technology);
        const name = tile.getAttribute('aria-label') || `Bâtiment ${technologyId}`;
        const key = getQueueKey(body.id, lane);
        const queues = loadBuildQueues();
        const queue = queues[key] || { items: [] };
        queue.type = body.type;
        queue.coords = body.coords;
        queue.name = body.name;

        const planned = queue.items.filter(i => i.technologyId === technologyId).map(i => i.targetLevel);
        const firstLevel = Math.max(getTileReachedLevel(tile), ...planned) + 1;
        const lastLevel = upToLevel === null ? firstLevel : upToLevel;
        if (lastLevel < firstLevel) {
            buildLog(`${name} niv. ${lastLevel} : déjà atteint ou déjà dans la file`);
            return 0;
        }

        for (let level = firstLevel; level <= lastLevel; level++) {
            queue.items.push({ technologyId, name, targetLevel: level, component });
        }
        queue.nextCheckAt = 0;
        queue.status = '';
        queues[key] = queue;
        saveBuildQueues(queues);

        buildLog(`Ajout file ${body.coords} (${body.type}): ${name} niv. ${firstLevel === lastLevel ? firstLevel : `${firstLevel} à ${lastLevel}`}`);
        renderBuildQueueUI();
        return lastLevel - firstLevel + 1;
    }

    // Retire de la file les niveaux d'un bâtiment jusqu'à `upToLevel` inclus (au-delà du niveau atteint)
    function removeLevelsFromBuildQueue(tile, upToLevel) {
        const body = getCurrentBody();
        const lane = getLaneOfComponent(getCurrentPage());
        if (!body.id || !lane) return 0;
        const technologyId = parseInt(tile.dataset.technology);
        const key = getQueueKey(body.id, lane);
        const queues = loadBuildQueues();
        const queue = queues[key];
        if (!queue) return 0;

        const before = queue.items.length;
        queue.items = queue.items.filter(i => !(i.technologyId === technologyId && i.targetLevel <= upToLevel));
        const removed = before - queue.items.length;
        if (removed === 0) return 0;
        // Les niveaux supérieurs restants du même bâtiment sont décalés
        queue.items.forEach(i => {
            if (i.technologyId === technologyId) i.targetLevel -= removed;
        });
        queue.nextCheckAt = 0;
        if (queue.items.length === 0) delete queues[key];
        saveBuildQueues(queues);
        buildLog(`Retrait file ${body.coords}: ${tile.getAttribute('aria-label') || technologyId} jusqu'au niv. ${upToLevel} (${removed} niveau(x))`);
        renderBuildQueueUI();
        return removed;
    }

    // Bouton « lists » d'OGLight dans le détail d'un bâtiment : OGLight note les ressources à rapatrier,
    // et on ajoute (ou retire, si le bouton était déjà actif) les niveaux jusqu'au niveau visé dans OGLight
    // (en-tête du détail : « 18 → 21 », réglé avec ses flèches ‹ ›).
    function watchOgLightListButton() {
        document.addEventListener('click', (e) => {
            const button = e.target.closest && e.target.closest('#technologydetails .ogl_actions .ogl_button');
            if (!button || button.textContent.trim() !== 'lists') return;
            const details = button.closest('#technologydetails');
            const technologyId = parseInt(details?.dataset.technologyId);
            const tile = technologyId ? getBuildingTile(technologyId) : null;
            const lane = getLaneOfComponent(getCurrentPage());
            if (!tile || !lane || !BUILD_LANES[lane].isTechnology(technologyId)) return;

            const levels = (details.querySelector('.information .level')?.textContent || '').match(/\d+/g);
            const target = levels && levels.length >= 2 ? parseInt(levels[levels.length - 1]) : null;
            if (!target) {
                buildLog(`OGLight : niveau visé introuvable pour ${tile.getAttribute('aria-label') || technologyId}`);
                return;
            }
            // L'état est lu avant qu'OGLight ne le bascule (écoute en phase de capture)
            if (button.classList.contains('ogl_active')) {
                removeLevelsFromBuildQueue(tile, target);
            } else {
                addToBuildQueue(tile, target);
            }
        }, true);
    }

    function removeFromBuildQueue(key, index) {
        const queues = loadBuildQueues();
        const queue = queues[key];
        if (!queue) return;
        const [removed] = queue.items.splice(index, 1);
        // Les niveaux suivants du même bâtiment sont décalés d'un cran
        if (removed) {
            queue.items.forEach(item => {
                if (item.technologyId === removed.technologyId && item.targetLevel > removed.targetLevel) {
                    item.targetLevel--;
                }
            });
        }
        queue.nextCheckAt = 0;
        if (queue.items.length === 0) {
            delete queues[key];
        }
        saveBuildQueues(queues);
        renderBuildQueueUI();
    }

    function moveUpInBuildQueue(key, index) {
        const queues = loadBuildQueues();
        const queue = queues[key];
        if (!queue || index <= 0) return;
        const items = queue.items;
        // Un niveau ne peut pas passer devant le niveau précédent du même bâtiment
        if (items[index - 1].technologyId === items[index].technologyId) return;
        [items[index - 1], items[index]] = [items[index], items[index - 1]];
        queue.nextCheckAt = 0;
        saveBuildQueues(queues);
        renderBuildQueueUI();
    }

    function clearBuildQueue(key) {
        const queues = loadBuildQueues();
        delete queues[key];
        saveBuildQueues(queues);
        renderBuildQueueUI();
    }

    function getBuildPageUrl(component, planetId) {
        return `${window.location.origin}/game/index.php?page=ingame&component=${component}&cp=${planetId}`;
    }

    function formatBodyLabel(queue) {
        const icon = queue.type === 'moon' ? '🌙' : '🌍';
        return `${icon} ${queue.name || ''} [${queue.coords}]`;
    }

    function formatDelay(ms) {
        const total = Math.max(0, Math.round(ms / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    const BUILD_RESOURCES = ['metal', 'crystal', 'deuterium'];
    const RESOURCE_LABELS = { metal: 'métal', crystal: 'cristal', deuterium: 'deutérium', energy: 'énergie' };
    let pageResourcesCache;
    // Instant auquel correspond le stock mémorisé (chargement de la page, ou dernière mise à jour détectée)
    let resourcesSnapshotAt = Date.now();

    function setResourcesSnapshot(resources, at = Date.now()) {
        const snapshot = {
            // Bilan énergétique disponible (ne s'accumule pas avec le temps)
            energy: { amount: Number(resources.energy?.amount) || 0 },
        };
        BUILD_RESOURCES.forEach(r => {
            const res = resources[r] || {};
            snapshot[r] = {
                amount: Number(res.amount) || 0,
                production: Number(res.production) || 0,
                storage: Number(res.storage) || Infinity,
            };
        });
        pageResourcesCache = snapshot;
        resourcesSnapshotAt = at;
    }

    // Stock, production/s (bonus compris) et stockage de la planète affichée,
    // lus dans l'appel reloadResources({...}) que la page contient au chargement
    function getPageResources() {
        if (pageResourcesCache !== undefined) return pageResourcesCache;
        pageResourcesCache = null;
        const script = [...document.scripts].map(s => s.textContent).find(t => t.includes('reloadResources({'));
        if (!script) return null;

        const start = script.indexOf('reloadResources({') + 'reloadResources('.length;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < script.length; i++) {
            const c = script[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') inString = false;
                continue;
            }
            if (c === '"') inString = true;
            else if (c === '{') depth++;
            else if (c === '}' && --depth === 0) {
                try {
                    setResourcesSnapshot(JSON.parse(script.slice(start, i + 1)).resources, resourcesSnapshotAt);
                } catch (e) {
                    buildLog('Lecture des ressources impossible:', e);
                }
                break;
            }
        }
        return pageResourcesCache;
    }

    // Stock estimé à un instant donné : stock mémorisé + production écoulée (plafonnée au stockage)
    function getResourceAmountAt(resource, time) {
        const res = getPageResources()?.[resource];
        if (!res) return null;
        if (res.amount >= res.storage) return res.amount;
        const produced = res.production * Math.max(0, time - resourcesSnapshotAt) / 1000;
        return Math.min(res.storage, res.amount + produced);
    }

    // Stock affiché en haut de page (OGame le fait avancer chaque seconde ; il change aussi
    // quand une flotte arrive ou qu'une dépense est faite). null si illisible (ex. « 1,2M »).
    function readDisplayedResource(resource) {
        const el = document.getElementById(`resources_${resource}`);
        if (!el) return null;
        const text = el.textContent.trim();
        if (!/^[\d.\s ]+$/.test(text)) return null;
        const value = parseInt(text.replace(/\D/g, ''), 10);
        return Number.isFinite(value) ? value : null;
    }

    // Ressources de la page mises à jour sans rechargement : on recalcule les estimations et le minuteur
    let resourcesChangeTimer = null;
    function onResourcesChanged(source) {
        clearTimeout(resourcesChangeTimer);
        resourcesChangeTimer = setTimeout(() => {
            buildLog(`Ressources mises à jour (${source}), estimation recalculée`);
            refreshBuildEstimateHere();
            renderBuildQueuePanel();
        }, 500);
    }

    function watchPageResources() {
        // 1. OGame recharge les ressources (arrivée de flotte, action…) via reloadResources(data) :
        //    nouveau stock ET nouvelle production
        try {
            const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const original = page.reloadResources;
            if (typeof original === 'function' && !original.__ogpWrapped) {
                const wrapped = function (data) {
                    try {
                        if (data && data.resources && data.resources.metal) {
                            setResourcesSnapshot(data.resources);
                            onResourcesChanged('rechargement OGame');
                        }
                    } catch (e) {}
                    return original.apply(this, arguments);
                };
                wrapped.__ogpWrapped = true;
                page.reloadResources = wrapped;
            }
        } catch (e) {
            buildLog('Interception de reloadResources impossible:', e);
        }

        // 2. Filet de sécurité : le stock affiché s'écarte nettement de la prévision
        setInterval(() => {
            const resources = getPageResources();
            if (!resources) return;
            const now = Date.now();
            let changed = false;
            BUILD_RESOURCES.forEach(r => {
                const shown = readDisplayedResource(r);
                const expected = getResourceAmountAt(r, now);
                if (shown === null || expected === null) return;
                // Uniquement vers le haut (ressources reçues : récompense, flotte…). En arrière-plan, Chrome ralentit
                // les minuteurs et le chiffre affiché par OGame prend du retard : un écart vers le bas n'est pas fiable.
                // Les dépenses sont signalées par OGame lui-même via reloadResources.
                if (shown - expected > Math.max(50, expected * 0.01)) {
                    resources[r].amount = shown;
                    changed = true;
                }
            });
            if (changed) {
                // Les autres ressources repartent de leur valeur prévue à cet instant
                BUILD_RESOURCES.forEach(r => {
                    const shown = readDisplayedResource(r);
                    if (shown === null) resources[r].amount = getResourceAmountAt(r, now);
                });
                resourcesSnapshotAt = now;
                onResourcesChanged('stock affiché différent de la prévision');
            }
        }, 5000);
    }

    function isCostForItem(cost, item) {
        return !!cost && cost.technologyId === item.technologyId && cost.level === item.targetLevel;
    }

    // Ouvre le panneau de détail OGame d'un bâtiment (chargé à neuf par OGame à chaque ouverture).
    // Retourne { element, opened } ou null s'il n'apparaît pas.
    async function openTechnologyDetails(tile, technologyId) {
        const selector = `#technologydetails[data-technology-id="${technologyId}"]`;
        const alreadyOpen = !!document.querySelector(selector);
        if (!alreadyOpen) {
            // OGame ouvre le détail au clic sur l'icône (délégué sur `.technology.hasDetails:not(.showsDetails) .icon`)
            (tile.querySelector('.icon') || tile).click();
        }
        try {
            const element = await waitForElement(selector, 8000);
            // Laisse le contenu (coûts, boutons) se remplir
            await waitForElement(`${selector} .costs, ${selector} button.upgrade, ${selector} .build-it_wrap`, 3000).catch(() => {});
            return { element, opened: !alreadyOpen };
        } catch (e) {
            if (!alreadyOpen) closeTechnologyDetails();
            return null;
        }
    }

    function closeTechnologyDetails() {
        document.querySelector('#technologydetails .close')?.click();
    }

    // Coût exact (bonus compris) affiché dans le détail ; null si le niveau ne correspond pas
    function readCostFromDetails(element, item) {
        const costs = element.querySelector('.costs');
        if (!costs) return null;
        const levelMatch = (costs.querySelector('p')?.textContent || '').match(/(\d+)\s*:?\s*$/);
        const level = levelMatch ? parseInt(levelMatch[1]) : item.targetLevel;
        const cost = { technologyId: item.technologyId, level };
        [...BUILD_RESOURCES, 'energy'].forEach(r => {
            const li = costs.querySelector(`li.resource.${r}[data-value]`);
            cost[r] = li ? parseInt(li.dataset.value) || 0 : 0;
        });
        if (level !== item.targetLevel) return null;
        buildLog(`Coût ${item.name} niv. ${level}:`, cost);
        return cost;
    }

    // { missing: {metal, crystal, deuterium}, readyAt (ms, null si jamais), storageBlocked }
    function estimateBuildReady(cost, now = Date.now()) {
        const resources = getPageResources();
        if (!cost || !resources) return null;

        const missing = {};
        let readyAt = now;
        let storageBlocked = null;
        for (const r of BUILD_RESOURCES) {
            const need = cost[r] || 0;
            const have = getResourceAmountAt(r, now);
            const lack = Math.max(0, need - have);
            missing[r] = Math.ceil(lack);
            if (lack <= 0) continue;
            if (need > resources[r].storage) {
                storageBlocked = `hangar de ${RESOURCE_LABELS[r]} trop petit`;
                readyAt = null;
            } else if (resources[r].production <= 0) {
                readyAt = null;
            } else if (readyAt !== null) {
                readyAt = Math.max(readyAt, now + lack / resources[r].production * 1000);
            }
        }

        // Énergie requise (ex. Terraformeur) : il faut construire une centrale, attendre ne suffit pas
        let energyBlocked = false;
        if (cost.energy > 0) {
            const lackEnergy = cost.energy - (resources.energy?.amount || 0);
            missing.energy = Math.max(0, Math.ceil(lackEnergy));
            if (lackEnergy > 0) {
                energyBlocked = true;
                readyAt = null;
            }
        }
        return { missing, readyAt, storageBlocked, energyBlocked };
    }

    function formatMissing(missing) {
        const parts = [...BUILD_RESOURCES, 'energy']
            .filter(r => missing[r] > 0)
            .map(r => `${missing[r].toLocaleString('fr-FR')} ${RESOURCE_LABELS[r]}`);
        return parts.join(' · ');
    }

    function formatClock(time) {
        const d = new Date(time);
        const sameDay = d.toDateString() === new Date().toDateString();
        const hm = `${d.getHours()}h${d.getMinutes().toString().padStart(2, '0')}`;
        return sameDay ? hm : `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${hm}`;
    }

    // À chaque chargement d'une page de la planète : nouvelle estimation avec les ressources réelles
    // (arrivée de flotte, nouvelle production…). Si c'est prêt, la vérification est avancée.
    function refreshBuildEstimateHere() {
        const planetId = getCurrentPlanetId();
        const queues = loadBuildQueues();
        const now = Date.now();
        let changed = false;

        Object.keys(BUILD_LANES).forEach(lane => {
            const queue = queues[getQueueKey(planetId, lane)];
            if (!queue || queue.items.length === 0) return;
            // Construction en cours dans cette file, déjà connue : l'échéance reste la fin de construction
            if ((queue.busyUntil || 0) > now) return;

            // La page montre une construction en cours que la file ignore (lancement non encore contrôlé,
            // construction lancée à la main…) : on resynchronise tout de suite au lieu d'estimer
            const constructionEnd = document.querySelector(BUILD_LANES[lane].box) ? getConstructionEnd(lane) : null;
            if (constructionEnd && constructionEnd > now) {
                if ((queue.nextCheckAt || 0) > now + 2000) {
                    buildLog(`${BUILD_LANES[lane].title} : construction en cours détectée, resynchronisation`);
                    queue.nextCheckAt = now;
                    changed = true;
                }
                return;
            }

            // Déjà due : l'évaluation sur la page s'en charge à l'instant, on ne la déplace pas
            if ((queue.nextCheckAt || 0) <= now) return;

            if (!isCostForItem(queue.cost, queue.items[0])) return;

            const estimate = estimateBuildReady(queue.cost, now);
            if (!estimate || estimate.storageBlocked || estimate.energyBlocked) return;
            const previousReadyAt = queue.readyAt;
            queue.readyAt = estimate.readyAt;
            changed = true;

            if (!estimate.readyAt) return;

            if (estimate.readyAt <= now) {
                // Les ressources qui manquaient lors de la dernière vérification sont arrivées
                // (récompense, flotte…) : on vérifie tout de suite. Une seule fois par vérification,
                // pour ne pas boucler quand OGame bloque pour une autre raison (chantier occupé, usine…).
                // (files enregistrées avant la 1.12.1 : pas de drapeau, on se fie au statut OGame)
                const awaiting = queue.awaitingResources
                    || (queue.awaitingResources === undefined && /ressource/i.test(queue.status || ''));
                if (awaiting) {
                    queue.awaitingResources = false;
                    const blocker = getLaneBlocker(planetId, lane, queue.items[0], now);
                    const target = Math.max(now + 2000, blocker ? blocker.until + 5000 : 0);
                    if (target < (queue.nextCheckAt || 0)) {
                        buildLog(`${queue.items[0].name} niv. ${queue.items[0].targetLevel} : ressources disponibles, vérification immédiate`);
                        queue.nextCheckAt = target;
                    }
                }
                return;
            }

            // Échéance recalée dans les deux sens : plus tôt (flotte arrivée, production en hausse)
            // ou plus tard (ressources dépensées, production en baisse)
            const blocker = getLaneBlocker(planetId, lane, queue.items[0], now);
            const target = Math.max(estimate.readyAt + 5000, blocker ? blocker.until + 5000 : 0);
            if (Math.abs(target - (queue.nextCheckAt || 0)) > 3000) {
                const moved = target < (queue.nextCheckAt || 0) ? 'avancée' : 'repoussée';
                if (!previousReadyAt || Math.abs(estimate.readyAt - previousReadyAt) > 30 * 1000) {
                    buildLog(`${queue.items[0].name} niv. ${queue.items[0].targetLevel} : manque ${formatMissing(estimate.missing)}, prêt vers ${formatClock(estimate.readyAt)} (vérification ${moved})`);
                }
                queue.nextCheckAt = target;
            }
        });

        if (changed) saveBuildQueues(queues);
    }

    // Traite la file `key` sur la page affichée (planète et page de la bonne file).
    // Retourne le composant à ouvrir si le prochain élément est sur une autre page.
    async function evaluateBuildQueueHere(key) {
        const planetId = getQueuePlanetId(key);
        const lane = getQueueLane(key);
        const laneLabel = getLaneLabel(lane);
        const body = getCurrentBody();
        const component = getCurrentPage();
        if (body.id !== planetId || getLaneOfComponent(component) !== lane) return null;

        const queues = loadBuildQueues();
        const queue = queues[key];
        if (!queue || queue.items.length === 0) return null;
        // Réarmé seulement si cette vérification conclut à un manque de ressources
        queue.awaitingResources = false;
        // Page chargée après le dernier lancement : elle reflète ce lancement
        if (queue.reloadAfter && queue.reloadAfter < PAGE_START_TIME) delete queue.reloadAfter;

        // Retire les niveaux déjà atteints (lancés par le plugin ou à la main)
        const before = queue.items.length;
        queue.items = queue.items.filter(item => {
            if (item.component !== component) return true;
            const tile = getBuildingTile(item.technologyId);
            return !tile || getTileReachedLevel(tile) < item.targetLevel;
        });
        if (queue.items.length !== before) {
            buildLog(`${before - queue.items.length} élément(s) déjà construit(s) retiré(s)`);
        }

        if (queue.items.length === 0) {
            delete queues[key];
            saveBuildQueues(queues);
            notifyDiscord(`✅ **${laneLabel} terminée** sur ${formatBodyLabel(queue)}`);
            renderBuildQueueUI();
            return null;
        }

        const constructionEnd = getConstructionEnd(lane);
        if (constructionEnd) {
            // Fin déjà passée : OGame finalise la construction, on revient dans quelques secondes
            const busyLabel = isResearchLane(lane) ? 'Recherche en cours' : 'Construction en cours';
            queue.status = constructionEnd > Date.now() ? busyLabel : `${busyLabel} de finalisation`;
            queue.nextCheckAt = Math.max(constructionEnd, Date.now()) + 5000;
            queue.busyUntil = constructionEnd;
            queue.readyAt = null;
            saveBuildQueues(queues);
            buildLog(`${laneLabel} : construction en cours sur ${body.coords}, prochaine vérification dans ${formatDelay(queue.nextCheckAt - Date.now())}`);
            renderBuildQueueUI();
            return null;
        }
        queue.busyUntil = 0;

        const item = queue.items[0];
        if (item.component !== component) {
            saveBuildQueues(queues);
            return item.component;
        }

        // Contrainte entre files (usine de robots/nanites ↔ formes de vie), connue même si cette page ne l'affiche pas
        const blocker = getLaneBlocker(planetId, lane, item);
        if (blocker) {
            queue.status = blocker.reason;
            queue.nextCheckAt = blocker.until + 5000;
            saveBuildQueues(queues);
            buildLog(`${laneLabel} : ${blocker.reason}, attente jusqu'à ${formatClock(blocker.until)}`);
            renderBuildQueueUI();
            return null;
        }

        const tile = getBuildingTile(item.technologyId);
        if (!tile) {
            queue.items.shift();
            saveBuildQueues(queues);
            buildLog(`${item.name} introuvable sur ${body.coords}, retiré de la file`);
            notifyDiscord(`⚠️ **${laneLabel}** : ${item.name} introuvable sur ${formatBodyLabel(queue)}, retiré de la file`);
            renderBuildQueueUI();
            return null;
        }

        const recheckAt = Date.now() + (CONFIG.buildQueue.recheckInterval || 60) * 1000;
        const tileReason = getTileReason(tile);

        if (tile.dataset.status === 'off') {
            queue.status = tileReason || 'Prérequis manquants';
            queue.nextCheckAt = recheckAt;
            saveBuildQueues(queues);
            buildLog(`${item.name} niv. ${item.targetLevel} non disponible (off): ${queue.status}`);
            renderBuildQueueUI();
            return null;
        }

        // Le statut des tuiles n'est calculé qu'au chargement de la page. Si l'estimation (tenue à jour en continu)
        // dit qu'il manque encore des ressources, inutile d'ouvrir le détail.
        if (tile.dataset.status !== 'on' && isCostForItem(queue.cost, item)) {
            const estimate = estimateBuildReady(queue.cost);
            if (estimate && (!estimate.readyAt || estimate.readyAt > Date.now() + 2000)) {
                applyBuildUnavailable(queue, item, tileReason || 'Pas assez de ressources!', estimate, recheckAt);
                saveBuildQueues(queues);
                renderBuildQueueUI();
                return null;
            }
        }

        // Détail OGame : rechargé à chaque ouverture, il dit si on peut lancer maintenant (bouton « Développer »),
        // sans avoir à recharger la page
        const details = await openTechnologyDetails(tile, item.technologyId);
        try {
            if (!details) {
                queue.status = 'Détail du bâtiment introuvable';
                queue.nextCheckAt = recheckAt;
                buildLog(`${item.name} niv. ${item.targetLevel} : détail introuvable, nouvel essai plus tard`);
            } else {
                const cost = readCostFromDetails(details.element, item);
                if (cost) queue.cost = cost;
                const upgradeBtn = details.element.querySelector(`button.upgrade[data-technology="${item.technologyId}"]`);

                if (upgradeBtn && !upgradeBtn.disabled) {
                    buildLog(`Lancement ${item.name} niv. ${item.targetLevel} sur ${body.coords}`);
                    queue.status = 'Lancement…';
                    queue.nextCheckAt = Date.now() + 10 * 1000;
                    // Le contrôle post-lancement se fait sur une page rechargée (tuiles et cadre à jour)
                    queue.reloadAfter = Date.now();
                    // Le coût mémorisé est celui du bâtiment qu'on lance : sans ça, le rechargement des ressources
                    // qui suit la dépense ferait repousser le contrôle post-lancement (le bâtiment resterait dans la file)
                    queue.cost = null;
                    queue.readyAt = null;
                    queue.awaitingResources = false;
                    saveBuildQueues(queues);
                    await wait(300);
                    // Aucune navigation ni découverte tant qu'OGame n'a pas traité le lancement (il recharge la page)
                    launchLockUntil = Date.now() + 8000;
                    upgradeBtn.click();
                    const icon = LANE_ICONS[lane];
                    notifyDiscord(`${icon} **${isResearchLane(lane) ? 'Recherche lancée' : 'Construction lancée'}** : ${item.name} niveau ${item.targetLevel} sur ${formatBodyLabel(queue)}${queue.items.length > 1 ? ` (${queue.items.length - 1} restant(s) dans la file)` : ''}`);
                    renderBuildQueueUI();
                    return null;
                }

                // Pas de bouton « Développer » : OGame refuse pour l'instant (ressources, ou autre raison)
                const insufficient = details.element.querySelector('.costs li.insufficient');
                const reason = (tile.dataset.status === 'disabled' && tileReason)
                    ? tileReason
                    : (insufficient ? 'Pas assez de ressources!' : 'Indisponible pour le moment');
                const estimate = isCostForItem(queue.cost, item) ? estimateBuildReady(queue.cost) : null;
                applyBuildUnavailable(queue, item, reason, estimate, recheckAt);
            }
        } catch (e) {
            buildLog('Échec du lancement:', e);
            queue.status = `Échec du lancement : ${e.message}`;
            queue.nextCheckAt = recheckAt;
        } finally {
            if (details && details.opened) closeTechnologyDetails();
        }
        saveBuildQueues(queues);
        renderBuildQueueUI();
        return null;
    }

    const BLOCKED_RECHECK_DELAY = 15 * 60 * 1000;

    // Statut et prochaine vérification quand le prochain élément ne peut pas être lancé
    function applyBuildUnavailable(queue, item, reason, estimate, recheckAt) {
        queue.status = reason;
        queue.nextCheckAt = recheckAt;
        if (estimate) {
            queue.readyAt = estimate.readyAt;
            if (estimate.storageBlocked || estimate.energyBlocked) {
                queue.status = estimate.storageBlocked ? `Stockage insuffisant (${estimate.storageBlocked})` : 'Énergie insuffisante';
                // Attendre ne suffit pas (hangar ou centrale à construire) : inutile de revenir chaque minute.
                // Une visite de la planète revérifie aussitôt si le blocage a disparu (refreshBuildEstimateHere).
                queue.nextCheckAt = Math.max(recheckAt, Date.now() + BLOCKED_RECHECK_DELAY);
                queue.awaitingResources = true;
            } else if (estimate.readyAt && estimate.readyAt > Date.now()) {
                queue.nextCheckAt = estimate.readyAt + 5000;
                // Si ces ressources arrivent plus tôt (récompense, flotte), refreshBuildEstimateHere vérifiera aussitôt
                queue.awaitingResources = true;
                buildLog(`${item.name} niv. ${item.targetLevel} : manque ${formatMissing(estimate.missing)}, prêt vers ${formatClock(estimate.readyAt)}`);
            } else if (estimate.readyAt && /ressource/i.test(reason)) {
                // Le calcul dit « prêt » mais OGame dit « pas assez » (quelques unités d'écart, dépense entre-temps…) :
                // c'est OGame qui a raison, on revient vite plutôt que d'attendre l'intervalle complet
                queue.nextCheckAt = Date.now() + 15 * 1000;
                buildLog(`${item.name} niv. ${item.targetLevel} : OGame indique encore « ${reason} » alors que le calcul donne les ressources disponibles, nouvel essai dans 15 s`);
            }
            // Sinon les ressources sont là mais OGame refuse pour une autre raison (usine en extension, chantier occupé…) :
            // motif OGame affiché et revérification normale
        }
        buildLog(`${item.name} niv. ${item.targetLevel} non disponible : ${queue.status}`);
    }

    // La page affichée suffit-elle pour décider ? Non si :
    // - un lancement a eu lieu depuis son chargement (le contrôle post-lancement se fait sur une page rechargée) ;
    // - son cadre affiche une construction dont la fin est passée (tuiles et cadre figés depuis).
    function canEvaluateInPlace(queue, lane) {
        if (queue.reloadAfter && queue.reloadAfter >= PAGE_START_TIME) return false;
        const box = document.querySelector(BUILD_LANES[lane].box);
        const countdown = box && box.querySelector('[data-end]');
        if (countdown && serverSecondsToLocalMs(parseInt(countdown.dataset.end)) <= Date.now() + 2000) return false;
        return true;
    }

    function navigateToBuildPage(key, component) {
        const planetId = getQueuePlanetId(key);
        saveBuildState({ active: true, key, planetId, component, startedAt: Date.now(), attempts: 0 });
        window.location.href = getBuildPageUrl(component, planetId);
    }

    // freshPage : la page vient d'être chargée, son contenu reflète l'état réel du jeu.
    // Sinon (minuteur, cycle), le DOM peut être figé depuis des minutes : on recharge toujours.
    async function checkBuildQueues(freshPage = false) {
        if (!CONFIG.buildQueue.enabled) return;
        if (isActionInProgress()) return;

        // Vous êtes en train de jouer : la file attend la fin de votre activité (ni navigation, ni détail ouvert)
        if (!isUserIdle()) {
            const anyDue = Object.values(loadBuildQueues()).some(q => q.items.length > 0 && (q.nextCheckAt || 0) <= Date.now());
            if (anyDue && !idleRetryTimers.build) {
                buildLog(`Activité en cours, file reportée de ${Math.round(getIdleRemaining() / 1000)} s`);
                runWhenIdle('build', () => checkBuildQueues(false));
            }
            return;
        }

        const queues = loadBuildQueues();
        const now = Date.now();
        const currentId = getCurrentPlanetId();
        const currentLane = getLaneOfComponent(getCurrentPage());
        let changed = false;

        // Planète/lune abandonnée ou détruite : sa file ne peut plus être traitée
        const bodyIds = new Set(getAllCelestialBodies().map(b => b.id));
        if (bodyIds.size > 0) {
            Object.keys(queues).filter(key => !bodyIds.has(getQueuePlanetId(key))).forEach(key => {
                buildLog(`${queues[key].coords} n'existe plus, file supprimée`);
                notifyDiscord(`⚠️ **File de construction supprimée** : ${formatBodyLabel(queues[key])} n'existe plus`);
                delete queues[key];
                changed = true;
            });
        }

        let due = Object.keys(queues).filter(key => queues[key].items.length > 0 && (queues[key].nextCheckAt || 0) <= now);

        // File bloquée par l'autre (usine de robots/nanites ↔ formes de vie) : on attend sans naviguer
        due = due.filter(key => {
            const blocker = getLaneBlocker(getQueuePlanetId(key), getQueueLane(key), queues[key].items[0], now);
            if (!blocker) return true;
            queues[key].status = blocker.reason;
            queues[key].nextCheckAt = blocker.until + 5000;
            changed = true;
            return false;
        });

        if (changed) saveBuildQueues(queues);
        if (due.length === 0) return;

        // D'abord la file de la page affichée (pas de navigation), puis la planète affichée
        const score = key => (getQueuePlanetId(key) === currentId ? 2 : 0) + (getQueueLane(key) === currentLane ? 1 : 0);
        due.sort((a, b) => score(b) - score(a));
        const key = due[0];
        const firstItem = queues[key].items[0];

        // Sur la bonne planète et la bonne page : évaluation sur place, sans recharger (le détail OGame fait foi),
        // sauf si la page est périmée (voir canEvaluateInPlace)
        if (getQueuePlanetId(key) === currentId && getQueueLane(key) === currentLane
            && (freshPage || canEvaluateInPlace(queues[key], currentLane))) {
            buildEvaluating = true;
            let neededComponent = null;
            try {
                neededComponent = await evaluateBuildQueueHere(key);
            } finally {
                buildEvaluating = false;
            }
            if (neededComponent) navigateToBuildPage(key, neededComponent);
            return;
        }

        buildLog(`Navigation vers ${queues[key].coords} (${firstItem.component}) pour la file de construction`);
        navigateToBuildPage(key, firstItem.component);
    }

    // Déclenche la vérification pile à l'échéance la plus proche, sans attendre le cycle
    let buildCheckTimer = null;
    function scheduleNextBuildCheck() {
        if (buildCheckTimer) {
            clearTimeout(buildCheckTimer);
            buildCheckTimer = null;
        }
        if (!CONFIG.buildQueue.enabled) return;

        const queues = loadBuildQueues();
        const times = Object.values(queues)
            .filter(q => q.items.length > 0)
            .map(q => q.nextCheckAt || 0);
        if (times.length === 0) return;

        const delay = Math.max(1000, Math.min(...times) - Date.now());
        buildCheckTimer = setTimeout(() => {
            buildCheckTimer = null;
            if (isActionInProgress()) {
                // Une autre action (expédition, panic…) navigue : on réessaie plus tard
                buildCheckTimer = setTimeout(scheduleNextBuildCheck, 15000);
                return;
            }
            buildLog('Échéance atteinte, vérification de la file');
            checkBuildQueues(false);
        }, delay);
    }

    async function processBuildState() {
        const state = loadBuildState();
        if (!state || !state.active) return;
        const key = state.key || getQueueKey(state.planetId, getLaneOfComponent(state.component));

        if (Date.now() - state.startedAt > 2 * 60 * 1000) {
            buildLog('État de navigation expiré, abandon');
            clearBuildState();
            return;
        }

        const onTarget = getCurrentPlanetId() === state.planetId && getCurrentPage() === state.component;
        if (!onTarget) {
            if (state.attempts >= 2) {
                buildLog('Impossible d\'atteindre la page cible, abandon');
                clearBuildState();
                const queues = loadBuildQueues();
                if (queues[key]) {
                    queues[key].nextCheckAt = Date.now() + (CONFIG.buildQueue.recheckInterval || 60) * 1000;
                    saveBuildQueues(queues);
                }
                return;
            }
            saveBuildState({ ...state, key, attempts: state.attempts + 1 });
            window.location.href = getBuildPageUrl(state.component, state.planetId);
            return;
        }

        clearBuildState();
        try {
            await waitForElement('#technologies li.technology', 5000);
        } catch (e) {
            buildLog('Bâtiments non chargés');
            return;
        }
        await wait(500);
        buildEvaluating = true;
        let neededComponent = null;
        try {
            neededComponent = await evaluateBuildQueueHere(key);
        } finally {
            buildEvaluating = false;
        }
        if (neededComponent) navigateToBuildPage(key, neededComponent);
    }

    function injectBuildQueueStyle() {
        const style = document.createElement('style');
        style.textContent = `
            #technologies li.technology .ogp-queue-badge {
                position: absolute;
                top: 2px;
                right: 2px;
                z-index: 5;
                padding: 0 4px;
                font-size: 10px;
                font-weight: bold;
                color: #0d1f29;
                background: #cfaf6f;
                border-radius: 3px;
                pointer-events: none;
            }
            /* Carte du bloc du bas (style commun .ogp-card) */
            #ogame-plugin-buildqueue {
                flex: 0 1 auto;
                min-height: 0;
                max-height: 40vh;
                overflow-y: auto;
                padding: 8px 10px;
            }
            #ogame-plugin-buildqueue .bq-title {
                display: flex;
                justify-content: space-between;
                align-items: center;
                color: #6fcfff;
                font-weight: bold;
                margin-bottom: 4px;
            }
            #ogame-plugin-buildqueue .bq-clear {
                padding: 1px 6px;
                background: rgba(90, 29, 29, 0.6);
                border: 1px solid #6a3c3c;
                border-radius: 4px;
                color: #ffb0b0;
                font-family: inherit;
                font-size: 10px;
                cursor: pointer;
            }
            #ogame-plugin-buildqueue .bq-clear:hover {
                filter: brightness(1.3);
            }
            #ogame-plugin-buildqueue .bq-clear.armed {
                background: #8a2c2c;
                color: #fff;
                border-color: #cf6f6f;
            }
            #ogame-plugin-buildqueue .bq-title:not(:first-child) {
                margin-top: 10px;
                padding-top: 8px;
                border-top: 1px solid #2c4a5a;
            }
            #ogame-plugin-buildqueue .bq-status {
                color: #cfaf6f;
                font-size: 10px;
                margin-bottom: 6px;
            }
            #ogame-plugin-buildqueue .bq-estimate {
                color: #9fd6c3;
                font-size: 10px;
                margin: -3px 0 6px;
            }
            #ogame-plugin-buildqueue .bq-item {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 3px 4px;
                margin-bottom: 2px;
                background: #0a1520;
                border: 1px solid #2c4a5a;
                border-radius: 3px;
            }
            #ogame-plugin-buildqueue .bq-item.first {
                border-color: #3c6a4a;
            }
            #ogame-plugin-buildqueue .bq-item .bq-name {
                flex: 1;
            }
            #ogame-plugin-buildqueue .bq-item button {
                background: none;
                border: none;
                color: #9fc3d6;
                cursor: pointer;
                padding: 0 3px;
                font-size: 11px;
            }
            #ogame-plugin-buildqueue .bq-others {
                color: #6a8a9a;
                font-size: 10px;
                margin-top: 6px;
            }
        `;
        document.head.appendChild(style);
    }

    function renderBuildTileButtons() {
        const component = getCurrentPage();
        const lane = getLaneOfComponent(component);
        if (!lane) return;

        const queue = loadBuildQueues()[getQueueKey(getCurrentPlanetId(), lane)];

        getBuildingTiles().forEach(tile => {
            if (getComputedStyle(tile).position === 'static') {
                tile.style.position = 'relative';
            }
            // Tuile déjà traitée (repère pour réinjecter l'étiquette si OGame recharge la liste)
            tile.dataset.ogpReady = '1';

            const technologyId = parseInt(tile.dataset.technology);
            const queued = queue ? queue.items.filter(i => i.technologyId === technologyId && i.component === component) : [];
            let badge = tile.querySelector('.ogp-queue-badge');
            if (queued.length > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'ogp-queue-badge';
                    tile.appendChild(badge);
                }
                badge.textContent = `→ ${Math.max(...queued.map(i => i.targetLevel))}`;
            } else if (badge) {
                badge.remove();
            }
        });
    }

    function getBuildEstimateText(queue) {
        const estimate = isCostForItem(queue.cost, queue.items[0]) ? estimateBuildReady(queue.cost) : null;
        if (!estimate) return null;
        const missingText = formatMissing(estimate.missing);
        if (!missingText) {
            return /ressource/i.test(queue.status || '')
                ? '⏳ Ressources presque disponibles (confirmation OGame)'
                : '✅ Ressources disponibles';
        }
        if (estimate.storageBlocked) return `Manque : ${missingText} · ${estimate.storageBlocked}`;
        if (estimate.energyBlocked) return `Manque : ${missingText} · production d'énergie à augmenter`;
        if (estimate.readyAt) return `Manque : ${missingText} · prêt vers ${formatClock(estimate.readyAt)} (dans ${formatDelay(estimate.readyAt - Date.now())})`;
        return `Manque : ${missingText} · production nulle`;
    }

    function renderBuildQueuePanel() {
        const queues = loadBuildQueues();
        const currentId = getCurrentPlanetId();
        const laneKeys = Object.keys(BUILD_LANES)
            .map(lane => ({ lane, key: getQueueKey(currentId, lane) }))
            .filter(({ key }) => queues[key] && queues[key].items.length > 0);
        const othersCount = Object.keys(queues)
            .filter(key => getQueuePlanetId(key) !== currentId)
            .reduce((sum, key) => sum + queues[key].items.length, 0);

        let panel = document.getElementById('ogame-plugin-buildqueue');
        const onBuildingPage = BUILDING_PAGES.includes(getCurrentPage());

        if (laneKeys.length === 0 && !(onBuildingPage && othersCount > 0)) {
            if (panel) panel.remove();
            return;
        }

        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'ogame-plugin-buildqueue';
            panel.className = 'ogp-card';
            panel.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                const index = parseInt(btn.dataset.index);
                if (btn.dataset.action === 'remove') removeFromBuildQueue(btn.dataset.key, index);
                if (btn.dataset.action === 'up') moveUpInBuildQueue(btn.dataset.key, index);
                if (btn.dataset.action === 'clear') {
                    // Confirmation dans la page (pas de popup) : 1er clic arme, 2e clic dans les 3 s vide
                    if (btn.dataset.armed) {
                        buildLog(`${getLaneLabel(getQueueLane(btn.dataset.key))} vidée`);
                        clearBuildQueue(btn.dataset.key);
                    } else {
                        btn.dataset.armed = '1';
                        btn.textContent = 'Confirmer ?';
                        btn.classList.add('armed');
                        setTimeout(() => {
                            delete btn.dataset.armed;
                            btn.textContent = '🗑️ Vider';
                            btn.classList.remove('armed');
                        }, 3000);
                    }
                }
            });
            // Sous la barre de boutons, au-dessus de la carte « Prochain clic »
            getDock().insertBefore(panel, document.getElementById('ogame-plugin-timer'));
        }

        // Partie statique (reconstruite seulement si elle change) ; les textes qui bougent
        // chaque seconde sont mis à jour à part pour ne pas casser les clics sur ▲ / ✕
        let html = '';
        const dynamic = [];
        laneKeys.forEach(({ lane, key }) => {
            const queue = queues[key];
            html += `<div class="bq-title"><span>${BUILD_LANES[lane].title} (${queue.items.length})</span><button class="bq-clear" data-action="clear" data-key="${key}" title="Vider toute la file">🗑️ Vider</button></div>`;
            if (!CONFIG.buildQueue.enabled) {
                html += `<div class="bq-status">⏸️ Lancement automatique désactivé</div>`;
            } else {
                html += `<div class="bq-status">${queue.status || ''}<span class="bq-next" data-key="${key}"></span></div>`;
            }
            const nextText = queue.nextCheckAt && queue.nextCheckAt > Date.now()
                ? ` · vérif. dans ${formatDelay(queue.nextCheckAt - Date.now())}`
                : '';
            const estimateText = getBuildEstimateText(queue);
            if (estimateText !== null) {
                html += `<div class="bq-estimate" data-key="${key}"></div>`;
            }
            dynamic.push({ key, nextText, estimateText });

            queue.items.forEach((item, index) => {
                html += `
                    <div class="bq-item ${index === 0 ? 'first' : ''}">
                        <span class="bq-name">${index + 1}. ${item.name} <b>niv. ${item.targetLevel}</b></span>
                        ${index > 0 ? `<button data-action="up" data-key="${key}" data-index="${index}" title="Monter">▲</button>` : ''}
                        <button data-action="remove" data-key="${key}" data-index="${index}" title="Retirer">✕</button>
                    </div>
                `;
            });
        });
        if (laneKeys.length === 0) {
            html += `<div class="bq-title">🏗️ File de construction</div>`;
        }
        if (othersCount > 0) {
            html += `<div class="bq-others">+ ${othersCount} élément(s) sur d'autres planètes/lunes</div>`;
        }
        if (panel.dataset.html !== html) {
            panel.dataset.html = html;
            panel.innerHTML = html;
        }
        dynamic.forEach(({ key, nextText, estimateText }) => {
            const nextEl = panel.querySelector(`.bq-next[data-key="${key}"]`);
            if (nextEl) nextEl.textContent = nextText;
            const estimateEl = panel.querySelector(`.bq-estimate[data-key="${key}"]`);
            if (estimateEl) estimateEl.textContent = estimateText || '';
        });
    }

    function renderBuildQueueUI() {
        renderBuildTileButtons();
        renderBuildQueuePanel();
        renderBuildQueueConfig();
    }

    function renderBuildQueueConfig() {
        const container = document.getElementById('cfg-buildqueue-container');
        if (!container) return;

        const queues = loadBuildQueues();
        const keys = Object.keys(queues).filter(key => queues[key].items.length > 0);
        if (keys.length === 0) {
            container.innerHTML = `<div class="hint">Aucune file. Dans le détail d'un bâtiment ou d'une recherche, réglez le niveau visé avec les flèches ‹ › d'OGLight puis cliquez sur son bouton ☰ (lists).</div>`;
            return;
        }

        container.innerHTML = keys.map(key => {
            const q = queues[key];
            const next = q.items[0];
            const laneIcon = LANE_ICONS[getQueueLane(key)];
            return `
                <div class="body-expedition-row">
                    <div class="body-info">
                        <span class="body-name">${laneIcon} ${formatBodyLabel(q)}</span>
                        <span class="body-coords">${q.items.length} élément(s) · prochain : ${next.name} niv. ${next.targetLevel}${q.status ? ` · ${q.status}` : ''}${q.readyAt && isCostForItem(q.cost, next) ? ` · prêt vers ${formatClock(q.readyAt)}` : ''}</span>
                    </div>
                    <button class="refresh-btn" data-clear-queue="${key}" title="Vider la file">🗑️</button>
                </div>
            `;
        }).join('');

        container.querySelectorAll('[data-clear-queue]').forEach(btn => {
            btn.addEventListener('click', () => clearBuildQueue(btn.dataset.clearQueue));
        });
    }

    function initBuildQueueUI() {
        injectBuildQueueStyle();
        renderBuildQueueUI();

        // OGame recharge certaines zones en AJAX : on réinjecte les boutons si besoin
        const technologies = document.getElementById('technologies');
        if (technologies) {
            new MutationObserver(() => {
                if (getBuildingTiles().some(tile => !tile.dataset.ogpReady)) {
                    renderBuildTileButtons();
                }
            }).observe(technologies, { childList: true, subtree: true });
        }

        setInterval(renderBuildQueuePanel, 1000);

        // Filet de sécurité : si aucun minuteur n'est armé (page chargée pendant une autre action du plugin,
        // par exemple un lancement d'expéditions), on le réarme. Premier passage après 30 s pour laisser
        // l'initialisation normale faire sa vérification sur la page fraîche.
        setInterval(() => {
            if (!CONFIG.buildQueue.enabled || buildCheckTimer || isActionInProgress()) return;
            const pending = Object.values(loadBuildQueues()).some(q => q.items.length > 0);
            if (pending) {
                buildLog('Minuteur de la file réarmé');
                scheduleNextBuildCheck();
            }
        }, 30 * 1000);
    }

    // ===== Défense automatique (par planète/lune) =====
    // Dès qu'une ressource atteint son seuil, commande le maximum de chaque défense dans l'ordre choisi,
    // en gardant le stock minimum configuré. Tournée périodique, uniquement quand vous êtes inactif.

    const DEFENSE_STATE_KEY = 'ogame_plugin_defense_state';
    const DEFENSE_INFO_KEY = 'ogame_plugin_defense_info';
    const DEFENSE_NAMES = {
        401: 'Lanceur de missiles',
        402: 'Artillerie laser légère',
        403: 'Artillerie laser lourde',
        404: 'Canon de Gauss',
        405: 'Artillerie à ions',
        406: 'Lanceur de plasma',
        407: 'Petit bouclier',
        408: 'Grand bouclier',
        502: 'Missile d\'interception',
        503: 'Missile interplanétaire',
    };
    const DEFENSE_IDS = Object.keys(DEFENSE_NAMES).map(Number);
    // Le champ « Nombre » d'OGame n'accepte pas plus (checkIntInput(this, 1, 99999))
    const DEFENSE_MAX_PER_ORDER = 99999;

    // « 100M », « 1,5G », « 500k », « 100.000.000 » -> nombre (0 si vide ou illisible)
    function parseAmount(text) {
        const s = String(text || '').trim().toLowerCase().replace(/[\s  ]/g, '');
        const match = s.match(/^([\d.,]+)([kmg]?)$/);
        if (!match) return 0;
        const multiplier = { '': 1, k: 1e3, m: 1e6, g: 1e9 }[match[2]];
        const number = match[2]
            ? parseFloat(match[1].replace(',', '.'))
            : parseFloat(match[1].replace(/[.,]/g, ''));
        return Number.isFinite(number) ? Math.round(number * multiplier) : 0;
    }

    function formatAmount(value) {
        if (!value) return '';
        const units = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
        for (const [size, unit] of units) {
            if (value >= size && value % (size / 100) === 0) {
                return `${parseFloat((value / size).toFixed(2)).toString().replace('.', ',')}${unit}`;
            }
        }
        return value.toLocaleString('fr-FR');
    }

    function getAutoDefenseBodyConfig(bodyId) {
        const body = (CONFIG.autoDefense.bodies || {})[bodyId];
        if (!body) return null;
        return {
            enabled: !!body.enabled,
            threshold: { metal: 0, crystal: 0, deuterium: 0, ...body.threshold },
            keep: { metal: 0, crystal: 0, deuterium: 0, ...body.keep },
            order: (body.order || []).filter(id => DEFENSE_NAMES[id]),
        };
    }

    function isAutoDefenseActiveFor(bodyId) {
        const cfg = getAutoDefenseBodyConfig(bodyId);
        return !!(cfg && cfg.enabled && cfg.order.length > 0
            && BUILD_RESOURCES.some(r => cfg.threshold[r] > 0));
    }

    function loadDefenseState() {
        return loadJson(DEFENSE_STATE_KEY, null);
    }

    function saveDefenseState(state) {
        localStorage.setItem(DEFENSE_STATE_KEY, JSON.stringify(state));
    }

    function clearDefenseState() {
        localStorage.removeItem(DEFENSE_STATE_KEY);
    }

    function loadDefenseInfo() {
        return loadJson(DEFENSE_INFO_KEY, {});
    }

    function saveDefenseInfo(info) {
        localStorage.setItem(DEFENSE_INFO_KEY, JSON.stringify(info));
    }

    // Ressources de la planète affichée mémorisées à chaque chargement : on sait ainsi, sans y aller,
    // quand une autre planète atteindra son seuil (stock + production, plafonné au hangar)
    function recordDefenseResourcesHere() {
        const planetId = getCurrentPlanetId();
        const resources = getPageResources();
        if (!planetId || !resources) return;
        const info = loadDefenseInfo();
        const snapshot = {};
        BUILD_RESOURCES.forEach(r => {
            snapshot[r] = {
                amount: resources[r].amount,
                production: resources[r].production,
                storage: Number.isFinite(resources[r].storage) ? resources[r].storage : null,
            };
        });
        info[planetId] = { ...(info[planetId] || {}), resources: snapshot, at: resourcesSnapshotAt };
        saveDefenseInfo(info);
    }

    function predictAmount(snapshot, at, time) {
        if (!snapshot) return 0;
        const storage = snapshot.storage === null || snapshot.storage === undefined ? Infinity : snapshot.storage;
        if (snapshot.amount >= storage) return snapshot.amount;
        return Math.min(storage, snapshot.amount + snapshot.production * Math.max(0, time - at) / 1000);
    }

    // Instant où une des ressources atteint son seuil (null si jamais avec la production actuelle)
    function getThresholdReachTime(cfg, bodyInfo, now = Date.now()) {
        if (!bodyInfo || !bodyInfo.resources) return now;
        let best = null;
        BUILD_RESOURCES.forEach(r => {
            const threshold = cfg.threshold[r];
            const snapshot = bodyInfo.resources[r];
            if (!threshold || !snapshot) return;
            if (predictAmount(snapshot, bodyInfo.at, now) >= threshold) {
                best = now;
                return;
            }
            const storage = snapshot.storage === null || snapshot.storage === undefined ? Infinity : snapshot.storage;
            if (snapshot.production <= 0 || threshold > storage) return;
            const reach = Math.max(now, bodyInfo.at + (threshold - snapshot.amount) / snapshot.production * 1000);
            if (best === null || reach < best) best = reach;
        });
        return best;
    }

    function getAutoDefenseInterval() {
        return Math.max(5, CONFIG.autoDefense.interval || 30) * 60 * 1000;
    }

    // Prochain passage sur la planète : seuil prévu atteint, ou relevé trop ancien (tournée).
    // Au plus un passage par intervalle (évite de boucler quand rien n'est constructible).
    function getAutoDefenseNextAt(bodyId, now = Date.now()) {
        const cfg = getAutoDefenseBodyConfig(bodyId);
        const bodyInfo = loadDefenseInfo()[bodyId];
        const interval = getAutoDefenseInterval();
        if (!bodyInfo || !bodyInfo.at) return now;
        const reach = getThresholdReachTime(cfg, bodyInfo, now);
        const stale = bodyInfo.at + interval;
        const due = reach === null ? stale : Math.min(reach, stale);
        return Math.max(due, (bodyInfo.lastRunAt || 0) + interval);
    }

    function getDefensePageUrl(planetId) {
        return getBuildPageUrl('defenses', planetId);
    }

    function navigateToDefensePage(planetId) {
        saveDefenseState({ active: true, planetId, startedAt: Date.now(), attempts: 0, done: [], orders: [] });
        window.location.href = getDefensePageUrl(planetId);
    }

    async function checkAutoDefense() {
        if (!CONFIG.autoDefense.enabled) return;
        if (isActionInProgress()) return;
        if (!isUserIdle()) {
            runWhenIdle('defense', checkAutoDefense);
            return;
        }

        const now = Date.now();
        const currentId = getCurrentPlanetId();
        const bodies = getAllCelestialBodies().filter(b => isAutoDefenseActiveFor(b.id));
        const due = bodies
            .map(b => ({ body: b, at: getAutoDefenseNextAt(b.id, now) }))
            .filter(d => d.at <= now)
            .sort((a, b) => (b.body.id === currentId) - (a.body.id === currentId) || a.at - b.at);
        if (due.length === 0) return;

        const target = due[0].body;
        if (target.id === currentId && getCurrentPage() === 'defenses') {
            await runAutoDefenseHere({ active: true, planetId: target.id, startedAt: now, attempts: 0, done: [], orders: [] });
            return;
        }
        buildLog(`🏰 Défense auto : passage sur ${target.coords} (${target.name})`);
        navigateToDefensePage(target.id);
    }

    async function processDefenseState() {
        const state = loadDefenseState();
        if (!state || !state.active) return;
        if (Date.now() - state.startedAt > 3 * 60 * 1000) {
            buildLog('🏰 Défense auto : état expiré, abandon');
            finishAutoDefense(state, 'Abandon (délai dépassé)');
            return;
        }
        if (getCurrentPlanetId() !== state.planetId || getCurrentPage() !== 'defenses') {
            if (state.attempts >= 2) {
                buildLog('🏰 Défense auto : page Défense inaccessible, abandon');
                finishAutoDefense(state, 'Page Défense inaccessible');
                return;
            }
            saveDefenseState({ ...state, attempts: state.attempts + 1 });
            window.location.href = getDefensePageUrl(state.planetId);
            return;
        }
        await runAutoDefenseHere(state);
    }

    function finishAutoDefense(state, result) {
        clearDefenseState();
        const info = loadDefenseInfo();
        info[state.planetId] = { ...(info[state.planetId] || {}), lastRunAt: Date.now(), lastResult: result };
        saveDefenseInfo(info);
        renderAutoDefenseStatus();
    }

    function formatDefenseOrders(orders) {
        return orders.map(o => `${o.count.toLocaleString('fr-FR')} ${DEFENSE_NAMES[o.id]}`).join(', ');
    }

    // Sur la page Défense de la planète : commande au plus une défense par chargement de page
    // (OGame recharge la page après « Ajouter » ; les ressources restantes sont alors à jour)
    async function runAutoDefenseHere(state) {
        const cfg = getAutoDefenseBodyConfig(state.planetId);
        const body = getCurrentBody();
        if (!cfg || !cfg.enabled) {
            finishAutoDefense(state, 'Désactivée');
            return;
        }
        try {
            await waitForElement('#technologies li.technology', 5000);
        } catch (e) {
            buildLog('🏰 Défense auto : défenses non chargées');
            finishAutoDefense(state, 'Défenses non chargées');
            return;
        }
        const resources = getPageResources();
        if (!resources) {
            finishAutoDefense(state, 'Ressources illisibles');
            return;
        }
        const have = {};
        BUILD_RESOURCES.forEach(r => { have[r] = getResourceAmountAt(r, Date.now()); });

        // Le seuil ne compte qu'au départ : ensuite on continue la cascade avec ce qui reste au-dessus du stock minimum
        if (state.orders.length === 0 && state.done.length === 0) {
            const reached = BUILD_RESOURCES.filter(r => cfg.threshold[r] > 0 && have[r] >= cfg.threshold[r]);
            if (reached.length === 0) {
                buildLog(`🏰 Défense auto ${body.coords} : seuil non atteint`);
                finishAutoDefense(state, 'Seuil non atteint');
                return;
            }
            buildLog(`🏰 Défense auto ${body.coords} : seuil atteint (${reached.map(r => RESOURCE_LABELS[r]).join(', ')})`);
        }

        for (const id of cfg.order) {
            if (state.done.includes(id)) continue;
            state.done.push(id);
            saveDefenseState(state);
            const name = DEFENSE_NAMES[id];
            const tile = document.querySelector(`#technologies li.technology[data-technology="${id}"]`);
            if (!tile || tile.dataset.status === 'off') {
                buildLog(`🏰 ${name} : non disponible`);
                continue;
            }
            const details = await openTechnologyDetails(tile, id);
            if (!details) {
                buildLog(`🏰 ${name} : détail introuvable`);
                continue;
            }
            const element = details.element;
            const input = element.querySelector('#build_amount, input[name="build_amount"]');
            const button = element.querySelector(`button.upgrade[data-technology="${id}"]`);
            if (!input || !button || button.disabled) {
                closeTechnologyDetails();
                buildLog(`🏰 ${name} : construction impossible pour le moment`);
                continue;
            }

            // Nombre possible en gardant le stock minimum, plafonné par OGame (boucliers, silo…)
            let count = DEFENSE_MAX_PER_ORDER;
            BUILD_RESOURCES.forEach(r => {
                const unitCost = parseInt(element.querySelector(`.costs li.resource.${r}[data-value]`)?.dataset.value) || 0;
                if (unitCost > 0) count = Math.min(count, Math.floor((have[r] - cfg.keep[r]) / unitCost));
            });
            const ogameMax = parseInt(input.getAttribute('max'));
            if (Number.isFinite(ogameMax)) count = Math.min(count, ogameMax);
            if (count <= 0) {
                closeTechnologyDetails();
                buildLog(`🏰 ${name} : 0 possible (stock minimum gardé)`);
                continue;
            }

            state.orders.push({ id, count });
            state.reloadAt = Date.now();
            saveDefenseState(state);
            buildLog(`🏰 Commande de ${count.toLocaleString('fr-FR')} ${name} sur ${body.coords}`);
            input.value = String(count);
            ['input', 'keyup', 'change'].forEach(type => input.dispatchEvent(new Event(type, { bubbles: true })));
            await wait(300);
            button.click();
            // OGame recharge la page ; sinon on la recharge nous-mêmes pour repartir des ressources à jour
            setTimeout(() => {
                const current = loadDefenseState();
                if (current && current.active && current.reloadAt === state.reloadAt) {
                    window.location.href = getDefensePageUrl(state.planetId);
                }
            }, 8000);
            return;
        }

        const result = state.orders.length > 0 ? `Commandé : ${formatDefenseOrders(state.orders)}` : 'Rien de constructible (stock minimum)';
        buildLog(`🏰 Défense auto ${body.coords} terminée : ${result}`);
        if (state.orders.length > 0) {
            notifyDiscord(`🏰 **Défenses lancées** sur ${body.name} [${body.coords}] : ${formatDefenseOrders(state.orders)}`);
        }
        finishAutoDefense(state, result);
    }

    // ----- Configuration (onglet 🏰 Auto-défense) -----

    let autoDefenseDraft = null;

    function renderAutoDefenseConfig() {
        const container = document.getElementById('cfg-autodef-container');
        if (!container) return;
        autoDefenseDraft = JSON.parse(JSON.stringify(CONFIG.autoDefense.bodies || {}));
        const bodies = getAllCelestialBodies();
        if (bodies.length === 0) {
            container.innerHTML = '<div class="hint">Aucune planète détectée</div>';
            return;
        }
        container.innerHTML = bodies.map(b => `<div class="autodef-body" data-body="${b.id}"></div>`).join('');
        bodies.forEach(b => renderAutoDefenseBody(b));
    }

    function renderAutoDefenseBody(body) {
        const el = document.querySelector(`#cfg-autodef-container .autodef-body[data-body="${body.id}"]`);
        if (!el) return;
        const cfg = autoDefenseDraft[body.id] || { enabled: false, threshold: {}, keep: {}, order: [] };
        autoDefenseDraft[body.id] = cfg;
        const order = (cfg.order || []).filter(id => DEFENSE_NAMES[id]);
        const unused = DEFENSE_IDS.filter(id => !order.includes(id));
        const info = loadDefenseInfo()[body.id] || {};
        const icon = body.type === 'moon' ? '🌙' : '🪐';
        const field = (kind, r) => `<input type="text" class="autodef-amount" data-kind="${kind}" data-res="${r}" value="${formatAmount((cfg[kind] || {})[r] || 0)}" placeholder="0">`;

        el.innerHTML = `
            <label class="checkbox-label autodef-head">
                <input type="checkbox" class="autodef-enabled" ${cfg.enabled ? 'checked' : ''}>
                ${icon} ${body.name} <span class="body-coords">[${body.coords}]</span>
            </label>
            <div class="autodef-details" style="display: ${cfg.enabled ? 'block' : 'none'}">
                <table class="autodef-table">
                    <tr><th></th><th>Métal</th><th>Cristal</th><th>Deut</th></tr>
                    <tr><td>Seuil</td>${BUILD_RESOURCES.map(r => `<td>${field('threshold', r)}</td>`).join('')}</tr>
                    <tr><td>Garder</td>${BUILD_RESOURCES.map(r => `<td>${field('keep', r)}</td>`).join('')}</tr>
                </table>
                <div class="autodef-order">
                    ${order.map((id, i) => `
                        <div class="autodef-item">
                            <span class="autodef-rank">${i + 1}.</span>
                            <span class="autodef-name">${DEFENSE_NAMES[id]}</span>
                            <button data-move="up" data-id="${id}" ${i === 0 ? 'disabled' : ''} title="Monter">▲</button>
                            <button data-move="down" data-id="${id}" ${i === order.length - 1 ? 'disabled' : ''} title="Descendre">▼</button>
                            <button data-remove="${id}" title="Retirer">✕</button>
                        </div>`).join('') || '<div class="hint">Aucune défense choisie</div>'}
                </div>
                ${unused.length ? `<select class="autodef-add"><option value="">+ Ajouter une défense…</option>${unused.map(id => `<option value="${id}">${DEFENSE_NAMES[id]}</option>`).join('')}</select>` : ''}
                <div class="hint">${info.lastRunAt ? `Dernier passage ${formatClock(info.lastRunAt)} : ${info.lastResult || ''}` : 'Jamais passé'}</div>
            </div>
        `;

        const readFields = () => {
            el.querySelectorAll('.autodef-amount').forEach(input => {
                cfg[input.dataset.kind] = { ...(cfg[input.dataset.kind] || {}), [input.dataset.res]: parseAmount(input.value) };
            });
        };
        el.querySelector('.autodef-enabled').addEventListener('change', (e) => {
            readFields();
            cfg.enabled = e.target.checked;
            renderAutoDefenseBody(body);
        });
        el.querySelectorAll('.autodef-amount').forEach(input => {
            input.addEventListener('change', () => {
                readFields();
                input.value = formatAmount(parseAmount(input.value));
            });
        });
        el.querySelectorAll('[data-move]').forEach(btn => {
            btn.addEventListener('click', () => {
                readFields();
                const id = parseInt(btn.dataset.id);
                const i = order.indexOf(id);
                const j = btn.dataset.move === 'up' ? i - 1 : i + 1;
                if (j < 0 || j >= order.length) return;
                [order[i], order[j]] = [order[j], order[i]];
                cfg.order = order;
                renderAutoDefenseBody(body);
            });
        });
        el.querySelectorAll('[data-remove]').forEach(btn => {
            btn.addEventListener('click', () => {
                readFields();
                cfg.order = order.filter(id => id !== parseInt(btn.dataset.remove));
                renderAutoDefenseBody(body);
            });
        });
        el.querySelector('.autodef-add')?.addEventListener('change', (e) => {
            const id = parseInt(e.target.value);
            if (!id) return;
            readFields();
            cfg.order = [...order, id];
            renderAutoDefenseBody(body);
        });
    }

    // Valeurs saisies dans l'onglet (y compris les champs modifiés mais pas encore validés)
    function collectAutoDefenseBodies() {
        const bodies = JSON.parse(JSON.stringify(autoDefenseDraft || CONFIG.autoDefense.bodies || {}));
        document.querySelectorAll('#cfg-autodef-container .autodef-body').forEach(el => {
            const cfg = bodies[el.dataset.body] || (bodies[el.dataset.body] = { enabled: false, threshold: {}, keep: {}, order: [] });
            cfg.enabled = el.querySelector('.autodef-enabled').checked;
            el.querySelectorAll('.autodef-amount').forEach(input => {
                cfg[input.dataset.kind] = { ...(cfg[input.dataset.kind] || {}), [input.dataset.res]: parseAmount(input.value) };
            });
        });
        return bodies;
    }

    function renderAutoDefenseStatus() {
        const el = document.getElementById('cfg-autodef-status');
        if (!el) return;
        if (!CONFIG.autoDefense.enabled) {
            el.textContent = 'Désactivée';
            return;
        }
        const now = Date.now();
        const active = getAllCelestialBodies().filter(b => isAutoDefenseActiveFor(b.id));
        if (active.length === 0) {
            el.textContent = 'Aucune planète configurée (seuil + au moins une défense)';
            return;
        }
        const next = active
            .map(b => ({ b, at: getAutoDefenseNextAt(b.id, now) }))
            .sort((x, y) => x.at - y.at)[0];
        el.textContent = `${active.length} planète(s) suivie(s) · prochain passage : ${next.b.name} [${next.b.coords}] ${next.at <= now ? 'maintenant' : `vers ${formatClock(next.at)}`}`;
    }

    // ===== Découverte de formes de vie =====
    // Envoie des vaisseaux d'exploration (mission 18) sur les positions découvrables d'une plage de systèmes,
    // par les mêmes requêtes que la page Galaxie (aucune navigation). Limites : slots de flotte à garder libres
    // et/ou nombre maximum de découvertes en vol (les deux s'appliquent ensemble, la plus stricte l'emporte).

    const DISCOVERY_STATE_KEY = 'ogame_plugin_discovery_state';
    const DISCOVERY_MISSION = 18;
    const SYSTEMS_PER_GALAXY = 499;
    // Systèmes lus au plus par passage (une requête chacun)
    const DISCOVERY_MAX_SYSTEMS_PER_RUN = 40;
    let discoveryRunning = false;

    // « 4:100 » -> { galaxy: 4, system: 100 } ; null si illisible
    function parseSystemCoords(text) {
        const match = String(text || '').trim().match(/^(\d+)\s*:\s*(\d+)$/);
        if (!match) return null;
        const galaxy = parseInt(match[1]);
        if (galaxy < 1) return null;
        // « 3:0 » = début de la galaxie, « 3:999 » = fin
        const system = Math.min(SYSTEMS_PER_GALAXY, Math.max(1, parseInt(match[2])));
        return { galaxy, system };
    }

    function getDiscoveryRange() {
        const from = parseSystemCoords(CONFIG.discovery.from);
        const to = parseSystemCoords(CONFIG.discovery.to) || from;
        if (!from) return null;
        const index = c => (c.galaxy - 1) * SYSTEMS_PER_GALAXY + (c.system - 1);
        const [a, b] = index(from) <= index(to) ? [from, to] : [to, from];
        return { from: a, to: b, start: index(a), end: index(b) };
    }

    function systemFromIndex(i) {
        return { galaxy: Math.floor(i / SYSTEMS_PER_GALAXY) + 1, system: (i % SYSTEMS_PER_GALAXY) + 1 };
    }

    // « … possible dans 18h 7m 43s » / « 1j 2h » -> millisecondes (null si aucune durée)
    function parseDiscoveryDelay(text) {
        const units = { j: 86400, d: 86400, h: 3600, m: 60, s: 1 };
        let seconds = 0;
        let found = false;
        String(text || '').replace(/(\d+)\s*([jdhms])\b/gi, (all, n, unit) => {
            seconds += parseInt(n) * units[unit.toLowerCase()];
            found = true;
            return all;
        });
        return found ? seconds * 1000 : null;
    }

    // Message d'erreur OGame : { errors: [{ message, error }] } ou { error: { message } }
    function getOgameErrorMessage(res) {
        const response = (res && res.response) || {};
        const raw = (res && res.errors && res.errors[0] && res.errors[0].message)
            || (res && res.error && res.error.message)
            || response.message || (res && res.message) || 'refusée';
        return String(raw).replace(/<[^>]+>/g, ' ').replace(/#time#/g, '…').replace(/\s+/g, ' ').trim();
    }

    function loadDiscoveryState() {
        return loadJson(DISCOVERY_STATE_KEY, {});
    }

    function saveDiscoveryState(state) {
        localStorage.setItem(DISCOVERY_STATE_KEY, JSON.stringify(state));
    }

    async function ogamePost(url, params) {
        const response = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            body: new URLSearchParams(params).toString(),
        });
        return response.json();
    }

    // cp : planète/lune pour laquelle OGame répond (elle devient la planète courante côté serveur)
    async function fetchSolarSystem(galaxy, system, cp = null) {
        return ogamePost(`${window.location.origin}/game/index.php?page=ingame&component=galaxy&action=fetchSolarSystemData&asJson=1${cp ? `&cp=${cp}` : ''}`, { galaxy, system });
    }

    function getDiscoveryOrigin() {
        const id = String(CONFIG.discovery.originId || '');
        return id ? getAllCelestialBodies().find(b => b.id === id) || null : null;
    }

    // Découvertes en vol : page Mouvements de flotte (une ligne par flotte, aller comme retour)
    async function countActiveDiscoveries() {
        const response = await fetch(`${window.location.origin}/game/index.php?page=ingame&component=movement`, { credentials: 'include' });
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const fleets = [...doc.querySelectorAll('.fleetDetails[data-mission-type]')];
        const slotsMatch = (doc.querySelector('.fleetSlots, #slots')?.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
        return {
            discoveries: fleets.filter(f => parseInt(f.dataset.missionType) === DISCOVERY_MISSION).length,
            usedSlots: slotsMatch ? parseInt(slotsMatch[1]) : null,
            maxSlots: slotsMatch ? parseInt(slotsMatch[2]) : null,
        };
    }

    // Nombre de découvertes encore autorisées
    function getDiscoveryAllowance(active, usedSlots, maxSlots) {
        let allowed = Infinity;
        if (usedSlots !== null && maxSlots !== null) {
            allowed = Math.min(allowed, maxSlots - usedSlots - Math.max(0, CONFIG.discovery.keepFreeSlots || 0));
        }
        if (CONFIG.discovery.maxActive > 0) {
            allowed = Math.min(allowed, CONFIG.discovery.maxActive - active);
        }
        return Number.isFinite(allowed) ? Math.max(0, allowed) : 0;
    }

    function setPageAjaxToken(newToken) {
        if (!newToken) return;
        try {
            const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            // La page Galaxie garde ce jeton pour ses propres actions : on le tient à jour
            if (typeof page.token === 'string') page.token = newToken;
        } catch (e) {}
    }

    function getDiscoveryConfigError() {
        if (!getDiscoveryRange()) return 'Plage invalide : saisissez « galaxie:système », ex. 3:1 → 3:100';
        if (!getDiscoveryOrigin()) return 'Planète de départ non choisie';
        return null;
    }

    async function runDiscovery(force = false) {
        if (!CONFIG.discovery.enabled) return 'Découverte désactivée (cochez et sauvegardez)';
        if (discoveryRunning) return 'Passage déjà en cours';
        if (isActionInProgress()) return 'Une autre action du plugin est en cours, réessayez dans un instant';
        if (!isUserIdle()) {
            runWhenIdle('discovery', () => runDiscovery(force));
            return 'En attente de votre inactivité';
        }
        const state = loadDiscoveryState();
        const interval = Math.max(1, CONFIG.discovery.interval || 5) * 60 * 1000;
        if (!force && state.lastRunAt && Date.now() - state.lastRunAt < interval) return null;

        const configError = getDiscoveryConfigError();
        if (configError) {
            // Journalisé une seule fois tant que le réglage ne change pas
            if (state.lastResult !== configError) {
                buildLog(`🔭 Découverte : ${configError}`);
                state.lastResult = configError;
                saveDiscoveryState(state);
            }
            renderDiscoveryStatus();
            return configError;
        }
        const range = getDiscoveryRange();
        const origin = getDiscoveryOrigin();
        const currentId = getCurrentPlanetId();
        let switched = false;

        discoveryRunning = true;
        const sent = [];
        let result = '';
        try {
            const fleets = await countActiveDiscoveries();
            let active = fleets.discoveries;
            let usedSlots = fleets.usedSlots;
            let maxSlots = fleets.maxSlots;
            let allowed = getDiscoveryAllowance(active, usedSlots, maxSlots);
            if (allowed <= 0) {
                result = `Rien à lancer (${active} en vol, slots ${usedSlots ?? '?'}/${maxSlots ?? '?'})`;
                return result;
            }

            const size = range.end - range.start + 1;
            let cursor = Number.isInteger(state.cursor) && state.cursor >= range.start && state.cursor <= range.end ? state.cursor : range.start;
            let token = null;
            let scanned = 0;
            let visited = 0;
            let stop = false;
            // Systèmes dont toutes les positions sont en attente : { index: instant de disponibilité }
            const waitUntil = state.waitUntil || {};
            Object.keys(waitUntil).forEach(i => { if (waitUntil[i] <= Date.now()) delete waitUntil[i]; });
            while (!stop && allowed > 0 && visited < size && scanned < DISCOVERY_MAX_SYSTEMS_PER_RUN) {
                visited++;
                if (waitUntil[cursor] > Date.now()) {
                    cursor = cursor >= range.end ? range.start : cursor + 1;
                    continue;
                }
                // Vous reprenez la main : la planète courante du serveur doit redevenir celle affichée
                // (sinon une construction lancée à la main partirait sur la planète de départ)
                if (!isUserIdle()) {
                    result = `${sent.length > 0 ? `${sent.length} lancée(s), ` : ''}interrompue (activité détectée)`;
                    break;
                }
                const { galaxy, system } = systemFromIndex(cursor);
                const data = await fetchSolarSystem(galaxy, system, origin.id);
                switched = switched || origin.id !== currentId;
                scanned++;
                token = data.newAjaxToken || data.token || token;
                const sys = data.system || {};
                if (Number.isInteger(sys.usedFleetSlots)) usedSlots = sys.usedFleetSlots;
                if (Number.isInteger(sys.maximumFleetSlots)) maxSlots = sys.maximumFleetSlots;
                allowed = getDiscoveryAllowance(active, usedSlots, maxSlots);

                // canSend vaut true, ou un texte « … à nouveau possible dans 18h 7m » quand la position est en attente
                const missions = (sys.galaxyContent || [])
                    .map(p => ({ position: p.position, mission: (p.availableMissions || []).find(m => m.missionType === DISCOVERY_MISSION) }))
                    .filter(p => p.mission);
                const positions = missions.filter(p => p.mission.canSend === true).map(p => p.position);
                if (positions.length === 0) {
                    const delays = missions.map(p => parseDiscoveryDelay(p.mission.canSend)).filter(d => d !== null);
                    // Rien d'envoyable ici : on n'y revient qu'à la fin de la plus courte attente (24 h si inconnue)
                    waitUntil[cursor] = Date.now() + (delays.length ? Math.min(...delays) : 24 * 3600 * 1000) + 60 * 1000;
                }
                for (const position of positions) {
                    if (allowed <= 0) break;
                    await wait(400 + Math.random() * 600);
                    if (!isUserIdle()) {
                        result = `${sent.length > 0 ? `${sent.length} lancée(s), ` : ''}interrompue (activité détectée)`;
                        stop = true;
                        break;
                    }
                    const res = await ogamePost(`${window.location.origin}/game/index.php?page=ingame&component=fleetdispatch&action=sendDiscoveryFleet&asJson=1&cp=${origin.id}`,
                        { galaxy, system, position, token });
                    token = res.newAjaxToken || token;
                    const response = res.response || {};
                    if (res.success && response.success) {
                        sent.push(`${galaxy}:${system}:${position}`);
                        active++;
                        usedSlots = usedSlots === null ? null : usedSlots + 1;
                        allowed--;
                        buildLog(`🔭 Découverte envoyée en ${galaxy}:${system}:${position}`);
                    } else {
                        const message = getOgameErrorMessage(res);
                        buildLog(`🔭 Découverte ${galaxy}:${system}:${position} refusée : ${message}`);
                        // Attente propre à cette position : on passe à la suivante ; sinon (ressources, slots…) on arrête
                        if (/à nouveau possible/i.test(message)) continue;
                        result = `Arrêt : ${message}`;
                        stop = true;
                        break;
                    }
                    if (response.discovery && response.discovery.canSendDiscovery === false) {
                        result = 'OGame n\'autorise plus de découverte pour le moment';
                        stop = true;
                        break;
                    }
                }
                // Système épuisé (ou lu en entier) : on passe au suivant ; sinon on y revient au prochain passage
                if (!stop && allowed > 0) {
                    cursor = cursor >= range.end ? range.start : cursor + 1;
                }
                if (!stop && allowed > 0) await wait(300 + Math.random() * 400);
            }
            setPageAjaxToken(token);
            state.cursor = cursor;
            state.waitUntil = waitUntil;
            if (!result) {
                result = sent.length > 0
                    ? `${sent.length} lancée(s)`
                    : (allowed > 0 ? `Aucune position découvrable (${scanned} système(s) lu(s), ${Object.keys(waitUntil).length} en attente)` : 'Limite atteinte');
            }
        } catch (e) {
            result = `Erreur : ${e.message}`;
            buildLog('🔭 Découverte : échec', e);
        } finally {
            // Retour sur la planète affichée (sinon la prochaine page ouverte serait la planète de départ)
            if (switched && currentId) {
                try {
                    const back = await fetchSolarSystem(range.from.galaxy, range.from.system, currentId);
                    setPageAjaxToken(back.newAjaxToken || back.token);
                } catch (e) {
                    buildLog('🔭 Découverte : retour sur la planète affichée impossible', e);
                }
            }
            discoveryRunning = false;
            state.lastRunAt = Date.now();
            state.lastResult = result;
            state.lastSent = sent;
            saveDiscoveryState(state);
            buildLog(`🔭 Découverte : ${result}`);
            if (sent.length > 0) {
                notifyDiscord(`🔭 **${sent.length} découverte(s) lancée(s)** : ${sent.join(', ')}`);
                // Nouvelles flottes : liste des événements et ressources à jour sur la page
                try {
                    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                    if (typeof page.getAjaxEventbox === 'function') page.getAjaxEventbox();
                    if (typeof page.getAjaxResourcebox === 'function') page.getAjaxResourcebox();
                } catch (e) {}
            }
            renderDiscoveryStatus();
        }
        return result;
    }

    function renderDiscoveryStatus() {
        const el = document.getElementById('cfg-discovery-status');
        if (!el) return;
        const state = loadDiscoveryState();
        const range = getDiscoveryRange();
        const parts = [];
        if (range) {
            const origin = getDiscoveryOrigin();
            parts.push(`Départ ${origin ? `${origin.type === 'moon' ? 'Lune' : origin.name} [${origin.coords}]` : 'non choisi'}`);
            parts.push(`plage ${range.from.galaxy}:${range.from.system} → ${range.to.galaxy}:${range.to.system}`);
            if (Number.isInteger(state.cursor)) {
                const c = systemFromIndex(state.cursor);
                parts.push(`reprise en ${c.galaxy}:${c.system}`);
            }
        }
        const configError = CONFIG.discovery.enabled ? getDiscoveryConfigError() : null;
        if (configError) parts.push(`⚠️ ${configError}`);
        else if (state.lastRunAt) parts.push(`dernier passage ${formatClock(state.lastRunAt)} : ${state.lastResult || ''}`);
        el.textContent = parts.join(' · ') || 'Jamais lancée';
    }

    function isLoggedIn() {
        return !!document.querySelector('#countColonies');
    }

    function getRandomInterval() {
        const baseInterval = CONFIG.randomClickInterval * 1000;
        const minInterval = baseInterval - 30000;
        const maxInterval = baseInterval + 30000;
        return Math.floor(Math.random() * (maxInterval - minInterval + 1)) + minInterval;
    }

    function canSendAlert(key, cooldownType) {
        const lastSent = localStorage.getItem(`monitor_${key}`);
        if (!lastSent) return true;

        const elapsed = Date.now() - parseInt(lastSent);
        const cooldown = CONFIG.cooldowns[cooldownType];

        if (elapsed > cooldown) {
            return true;
        }

        const remaining = Math.ceil((cooldown - elapsed) / 1000);
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

        console.log(`[Monitor] Alerte "${key}" en cooldown (${timeStr} restant)`);
        return false;
    }

    function markAlertSent(key) {
        localStorage.setItem(`monitor_${key}`, Date.now().toString());
    }

    function sendDiscord(message, alertKey, cooldownType) {
        if (!canSendAlert(alertKey, cooldownType)) {
            return;
        }

        markAlertSent(alertKey);

        notifyDiscord(message).then(ok => {
            if (ok) console.log('[Monitor] Discord notifié');
        });
    }

    // ===== Bilan périodique des expéditions =====
    // Résultats lus dans les messages (onglet Flottes → Expéditions, et Combats pour les pertes) :
    // chaque message porte ses données brutes dans .rawMessageData (data-raw-*)

    const EXPEDITION_REPORT_KEY = 'ogame_plugin_expedition_report';
    const MESSAGES_SUBTAB = { expeditions: 22, combats: 21 };
    const MESSAGE_TYPE = { expedition: '41', discovery: '61', combat: '25' };
    const EXPEDITION_RESULT_LABELS = {
        ressources: '💰 Ressources', shipwrecks: '🛸 Vaisseaux', darkmatter: '🌑 Antimatière', items: '🎁 Objet',
        trader: '🤝 Marchand', navigation: '⏱️ Retard/avance', nothing: '∅ Rien',
        combatPirates: '🏴‍☠️ Pirates', combatAliens: '👽 Aliens',
    };

    function loadExpeditionReportState() {
        return loadJson(EXPEDITION_REPORT_KEY, {});
    }

    function saveExpeditionReportState(state) {
        localStorage.setItem(EXPEDITION_REPORT_KEY, JSON.stringify(state));
    }

    function parseJsonSafe(text, fallback = null) {
        try {
            return JSON.parse(text);
        } catch (e) {
            return fallback;
        }
    }

    // 12345678 -> « 12,3M »
    function formatCompact(value) {
        const v = Math.round(value || 0);
        const units = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
        for (const [size, unit] of units) {
            if (Math.abs(v) >= size) return `${parseFloat((v / size).toFixed(v >= size * 100 ? 0 : 1)).toString().replace('.', ',')}${unit}`;
        }
        return v.toLocaleString('fr-FR');
    }

    // Messages d'un onglet postérieurs à `since` (ms locales), du plus récent au plus ancien
    async function fetchMessagesSince(subTab, since, maxPages = 15) {
        const found = [];
        for (let page = 1; page <= maxPages; page++) {
            const res = await ogamePost(`${window.location.origin}/game/index.php?page=componentOnly&component=messages&asJson=1&action=getMessagesList`,
                { activeSubTab: subTab, showTrash: false, messagePage: page });
            const messages = Array.isArray(res && res.messages) ? res.messages : [];
            let reachedOlder = messages.length === 0;
            messages.forEach(html => {
                const raw = new DOMParser().parseFromString(html, 'text/html').querySelector('.rawMessageData');
                if (!raw) return;
                const data = {};
                [...raw.attributes].forEach(a => {
                    if (a.name.startsWith('data-raw-')) data[a.name.slice(9)] = a.value;
                });
                data.at = serverSecondsToLocalMs(parseInt(data.timestamp) || 0);
                if (data.at < since) {
                    reachedOlder = true;
                    return;
                }
                found.push(data);
            });
            if (reachedOlder || page >= (parseInt(res.pageCount) || 1)) break;
        }
        return found;
    }

    // Expéditions en vol : page Mouvements de flotte
    async function fetchExpeditionsInFlight() {
        const response = await fetch(`${window.location.origin}/game/index.php?page=ingame&component=movement`, { credentials: 'include' });
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const fleets = [...doc.querySelectorAll(`.fleetDetails[data-mission-type="15"]`)];
        const byOrigin = {};
        let returning = 0;
        let nextReturn = null;
        fleets.forEach(f => {
            const origin = (f.querySelector('.originCoords')?.textContent || '?').trim();
            byOrigin[origin] = (byOrigin[origin] || 0) + 1;
            if (f.dataset.returnFlight && f.dataset.returnFlight !== 'false' && f.dataset.returnFlight !== '0') {
                returning++;
                const at = serverSecondsToLocalMs(parseInt(f.dataset.arrivalTime) || 0);
                if (at > Date.now() && (!nextReturn || at < nextReturn)) nextReturn = at;
            }
        });
        const slotText = sel => (doc.querySelector(sel)?.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
        const fleetSlots = slotText('.fleetSlots');
        const expSlots = slotText('.expSlots');
        return {
            total: fleets.length,
            returning,
            byOrigin,
            nextReturn,
            fleetSlots: fleetSlots ? `${fleetSlots[1]}/${fleetSlots[2]}` : null,
            expSlots: expSlots ? `${expSlots[1]}/${expSlots[2]}` : null,
        };
    }

    // Pertes d'un rapport de combat d'expédition : vaisseaux détruits de vos flottes (dernier round, cumulé)
    function getCombatLosses(report, playerId) {
        const fleets = parseJsonSafe(report.fleets, []) || [];
        const mine = fleets.filter(f => String(f.player?.id) === String(playerId));
        const side = mine[0]?.side || 'defender';
        const myFleetIds = new Set(mine.map(f => f.fleetId));
        const rounds = parseJsonSafe(report.combatrounds, []) || [];
        const last = rounds[rounds.length - 1];
        const lost = {};
        (last?.fleets || [])
            .filter(f => myFleetIds.size ? myFleetIds.has(f.fleetId) : f.side === side)
            .forEach(f => (f.technologies || []).forEach(t => {
                if (t.destroyedTotal > 0) lost[t.technologyId] = (lost[t.technologyId] || 0) + t.destroyedTotal;
            }));
        const result = parseJsonSafe(report.result, {}) || {};
        const value = ((result.totalValueOfUnitsLost || []).find(v => v.side === side) || {}).value || 0;
        return { lost, value };
    }

    function summarizeExpeditionMessages(messages, combats, playerId) {
        const s = {
            count: 0, results: {}, resources: { metal: 0, crystal: 0, deuterium: 0, darkMatter: 0 }, ships: {},
            early: 0, late: 0, fleetsLost: 0, combats: 0, lost: {}, lostValue: 0,
            discoveries: { count: 0, artifacts: 0, xp: 0, shipsLost: 0, nothing: 0 },
        };
        messages.forEach(m => {
            if (m.messagetype === MESSAGE_TYPE.discovery) {
                s.discoveries.count++;
                if (m.discoverytype === 'artifacts') s.discoveries.artifacts += parseInt(m.artifactsfound) || 0;
                else if (m.discoverytype === 'lifeform-xp') s.discoveries.xp += parseInt(m.lifeformgainedexperience) || 0;
                else if (m.discoverytype === 'ship-lost') s.discoveries.shipsLost++;
                else s.discoveries.nothing++;
                return;
            }
            if (m.messagetype !== MESSAGE_TYPE.expedition) return;
            s.count++;
            const result = m.expeditionresult || 'inconnu';
            s.results[result] = (s.results[result] || 0) + 1;
            const gained = parseJsonSafe(m.resourcesgained, {}) || {};
            Object.keys(gained).forEach(r => { s.resources[r] = (s.resources[r] || 0) + (Number(gained[r]) || 0); });
            const ships = parseJsonSafe(m.technologiesgained, {}) || {};
            Object.keys(ships).forEach(id => { s.ships[id] = (s.ships[id] || 0) + (Number(ships[id].amount) || 0); });
            if (m.navigation) {
                const nav = parseJsonSafe(m.navigation, {}) || {};
                if ((nav.returnTimeAbsoluteIncreaseHours || 0) > 0 || (nav.returnTimeMultiplier || 1) > 1) s.late++;
                else if ((nav.returnTimeMultiplier || 1) < 1) s.early++;
            }
            if (/lost|black|hole/i.test(result)) s.fleetsLost++;
        });
        combats
            .filter(c => c.messagetype === MESSAGE_TYPE.combat && /:16$/.test(c.coords || ''))
            .forEach(c => {
                s.combats++;
                const { lost, value } = getCombatLosses(c, playerId);
                Object.keys(lost).forEach(id => { s.lost[id] = (s.lost[id] || 0) + lost[id]; });
                s.lostValue += value;
            });
        return s;
    }

    function formatShipList(ships) {
        const entries = Object.entries(ships).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
        return entries.map(([id, n]) => `${n.toLocaleString('fr-FR')} ${SHIP_NAMES[id] || id}`).join(', ');
    }

    function buildExpeditionReport(flight, s, from, to) {
        const lines = [`📊 **Bilan expéditions** · ${formatClock(from)} → ${formatClock(to)}`];
        if (flight) {
            const origins = Object.entries(flight.byOrigin).map(([c, n]) => `${c} ×${n}`).join(', ');
            lines.push(`🚀 **En cours : ${flight.total}**${flight.expSlots ? ` (slots expé ${flight.expSlots}` : ''}${flight.fleetSlots ? `${flight.expSlots ? ', ' : ' ('}flottes ${flight.fleetSlots})` : (flight.expSlots ? ')' : '')}`
                + `${flight.total ? ` · ${flight.total - flight.returning} à l'aller, ${flight.returning} au retour` : ''}`
                + `${flight.nextReturn ? ` · prochain retour ${formatClock(flight.nextReturn)}` : ''}`);
            if (origins) lines.push(`　${origins}`);
        }
        if (s.count === 0) {
            lines.push('📥 Aucun résultat d\'expédition sur la période');
        } else {
            lines.push(`📥 **${s.count} résultat(s)** : ${Object.entries(s.results).sort((a, b) => b[1] - a[1])
                .map(([r, n]) => `${EXPEDITION_RESULT_LABELS[r] || r} ${n}`).join(' · ')}`);
            const r = s.resources;
            const total = (r.metal || 0) + (r.crystal || 0) + (r.deuterium || 0);
            const res = [['métal', r.metal], ['cristal', r.crystal], ['deut', r.deuterium]].filter(([, v]) => v > 0)
                .map(([n, v]) => `${formatCompact(v)} ${n}`);
            if (res.length) lines.push(`💰 Ressources : ${res.join(' · ')} (total ${formatCompact(total)})`);
            if (r.darkMatter > 0) lines.push(`🌑 Antimatière : ${r.darkMatter.toLocaleString('fr-FR')}`);
            const ships = formatShipList(s.ships);
            if (ships) lines.push(`🛸 Vaisseaux trouvés : ${ships}`);
            if (s.early || s.late) lines.push(`⏱️ Retour : ${s.early} en avance · ${s.late} en retard`);
        }
        if (s.combats > 0 || s.fleetsLost > 0) {
            const lost = formatShipList(s.lost);
            lines.push(`⚔️ Combats : ${s.combats}${lost ? ` · pertes : ${lost} (${formatCompact(s.lostValue)} de valeur)` : ' · aucune perte'}`);
            if (s.fleetsLost > 0) lines.push(`🕳️ **Flotte(s) perdue(s) : ${s.fleetsLost}**`);
        } else if (s.count > 0) {
            lines.push('⚔️ Aucun combat, aucune perte');
        }
        const d = s.discoveries;
        if (d.count > 0) {
            const parts = [d.xp ? `+${d.xp.toLocaleString('fr-FR')} XP` : '', d.artifacts ? `${d.artifacts.toLocaleString('fr-FR')} artefacts` : '',
                d.nothing ? `${d.nothing} sans résultat` : '', d.shipsLost ? `${d.shipsLost} vaisseau(x) perdu(s)` : ''].filter(Boolean);
            lines.push(`🔭 Découvertes : ${d.count}${parts.length ? ` (${parts.join(' · ')})` : ''}`);
        }
        // Limite Discord : 2000 caractères
        return lines.join('\n').slice(0, 1990);
    }

    // manual : envoi immédiat sur la dernière période, sans décaler le prochain bilan
    async function sendExpeditionReport(manual = false) {
        const state = loadExpeditionReportState();
        const now = Date.now();
        const interval = Math.max(60, CONFIG.expeditionReport.interval || 3600) * 1000;
        const from = manual ? now - interval : (state.lastAt || now - interval);
        if (!manual) {
            // Noté avant les requêtes : un autre onglet n'envoie pas le même bilan
            state.lastAt = now;
            saveExpeditionReportState(state);
        }
        const playerId = document.querySelector('meta[name="ogame-player-id"]')?.getAttribute('content');
        const [flight, messages, combats] = await Promise.all([
            fetchExpeditionsInFlight().catch(() => null),
            fetchMessagesSince(MESSAGES_SUBTAB.expeditions, from),
            fetchMessagesSince(MESSAGES_SUBTAB.combats, from),
        ]);
        const report = buildExpeditionReport(flight, summarizeExpeditionMessages(messages, combats, playerId), from, now);
        const ok = await notifyDiscord(report);
        if (!manual) {
            state.lastResult = ok ? 'envoyé' : 'échec de l\'envoi Discord';
            saveExpeditionReportState(state);
        }
        return { ok, report };
    }

    // Le délai « Expédition » ne vaut que pour les messages de lancement : masqué s'ils sont désactivés
    function updateExpeditionCooldownVisibility() {
        const group = document.getElementById('cfg-cd-expedition-group');
        const checkbox = document.getElementById('cfg-expedition-launch-alerts');
        if (group && checkbox) group.style.display = checkbox.checked ? '' : 'none';
    }

    function renderExpeditionReportStatus() {
        const el = document.getElementById('cfg-report-status');
        if (!el) return;
        const state = loadExpeditionReportState();
        const interval = Math.max(60, CONFIG.expeditionReport.interval || 3600) * 1000;
        el.textContent = !CONFIG.expeditionReport.enabled ? 'Bilan désactivé'
            : !state.lastAt ? 'Premier bilan dans un intervalle'
                : `Dernier bilan ${formatClock(state.lastAt)}${state.lastResult ? ` (${state.lastResult})` : ''} · prochain vers ${formatClock(state.lastAt + interval)}`;
    }

    async function checkExpeditionReport() {
        if (!CONFIG.expeditionReport.enabled || !CONFIG.discordWebhook) return;
        const state = loadExpeditionReportState();
        const interval = Math.max(60, CONFIG.expeditionReport.interval || 3600) * 1000;
        if (!state.lastAt) {
            // Première fois : la période démarre maintenant
            saveExpeditionReportState({ ...state, lastAt: Date.now() });
            return;
        }
        if (Date.now() - state.lastAt < interval) return;
        try {
            await sendExpeditionReport(false);
        } catch (e) {
            console.log('[Monitor] Bilan des expéditions impossible:', e);
        }
    }

    function reconnect() {
        // Avec des @grant, le script tourne en sandbox : `document` reste celui de la page
        const btn = document.querySelector('button.button-default.button-md');

        if (btn) {
            console.log('[Monitor] Clic sur "Dernière partie"');
            btn.focus();
            btn.click();
        } else {
            console.log('[Monitor] Bouton "Dernière partie" non trouvé');
        }
    }

    function handleDisconnected() {
        sendDiscord('⚠️ **Déconnexion détectée !**', 'disconnected', 'disconnected');
        console.log('[Monitor] Déconnexion détectée !');

        if (CONFIG.autoReconnect) {
            const delayMin = CONFIG.reconnectDelay / 60000;
            console.log(`[Monitor] Reconnexion dans ${delayMin} minutes...`);
            sendDiscord(`🔄 Reconnexion automatique dans ${delayMin} minutes...`, 'reconnect_info', 'disconnected');
            setTimeout(reconnect, CONFIG.reconnectDelay);
        }
    }

    function checkExpeditions() {
        const expectedTotal = getTotalExpectedExpeditions();

        if (expectedTotal === 0) {
            console.log('[Monitor] Aucune expédition configurée');
            return;
        }

        const activeTotal = getTotalActiveExpeditions();
        const finishedTotal = getTotalFinishedExpeditions();
        const missingTotal = getTotalMissingExpeditions();

        console.log(`[Monitor] Expéditions: ${activeTotal}/${expectedTotal} (${finishedTotal} terminée(s), ${missingTotal} manquante(s))`);

        const lastCount = localStorage.getItem('monitor_expedition_count');
        const lastCountNum = lastCount !== null ? parseInt(lastCount) : activeTotal;
        const countDecreased = activeTotal < lastCountNum;

        localStorage.setItem('monitor_expedition_count', activeTotal.toString());

        if (finishedTotal > 0 || missingTotal > 0) {
            if (countDecreased || finishedTotal > 0) {
                localStorage.removeItem('monitor_expedition');
            }
            if (CONFIG.expeditionLaunchAlerts) sendDiscord(`🚀 **${activeTotal}/${expectedTotal} Expédition(s)** (${finishedTotal} terminée(s))`, 'expedition', 'expedition');

            autoLaunchExpeditions();
        }
    }

    function clickRandomPlanet() {
        const links = document.querySelectorAll('a[href*="&cp="]');
        if (links.length > 0) {
            const randomIndex = Math.floor(Math.random() * links.length);
            const link = links[randomIndex];
            console.log(`[Monitor] Clic sur lien ${randomIndex + 1}/${links.length}:`, link.href);
            link.click();
        } else {
            console.log('[Monitor] Aucun lien trouvé');
        }
    }

    // ===== Statistiques : flotte disponible par planète/lune =====

    const SHIP_NAMES = {
        202: 'Petit transporteur', 203: 'Grand transporteur', 204: 'Chasseur léger', 205: 'Chasseur lourd',
        206: 'Croiseur', 207: 'Vaisseau de bataille', 208: 'Vaisseau de colonisation', 209: 'Recycleur',
        210: 'Sonde d\'espionnage', 211: 'Bombardier', 212: 'Satellite solaire', 213: 'Destructeur',
        214: 'Étoile de la mort', 215: 'Traqueur', 217: 'Foreuse', 218: 'Faucheur', 219: 'Éclaireur',
    };
    const FLEET_STATS_KEY = 'ogame_plugin_fleet_stats';
    const FLEET_RETURNS_KEY = 'ogame_plugin_fleet_returns';

    function normalizeShipName(name) {
        return String(name).toLowerCase().replace(/[`’´]/g, '\'').replace(/\s+/g, ' ').trim();
    }
    const SHIP_IDS_BY_NAME = Object.fromEntries(Object.entries(SHIP_NAMES).map(([id, name]) => [normalizeShipName(name), parseInt(id)]));

    function loadJson(key, fallback) {
        try {
            return JSON.parse(localStorage.getItem(key)) || fallback;
        } catch (e) {
            return fallback;
        }
    }

    // Données de la page Flotte (variables JS de la page) : vaisseaux à quai, créneaux, flottes d'expédition
    function parseFleetDispatchData(text) {
        const json = (name) => {
            const m = text.match(new RegExp(`var ${name}\\s*=\\s*(\\[[\\s\\S]*?\\]);\\s*\\n`));
            if (!m) return null;
            try { return JSON.parse(m[1]); } catch (e) { return null; }
        };
        const number = (name) => {
            const m = text.match(new RegExp(`var ${name}\\s*=\\s*(\\d+)`));
            return m ? parseInt(m[1]) : null;
        };
        const shipsOnPlanet = json('shipsOnPlanet');
        if (!shipsOnPlanet) return null;
        const ships = {};
        shipsOnPlanet.forEach(s => { if (s && s.number > 0) ships[s.id] = s.number; });
        const templates = (json('expeditionFleetTemplates') || [])
            .filter(t => t && t.name && t.ships)
            .map(t => ({ name: t.name, ships: Object.fromEntries(Object.entries(t.ships).filter(([, n]) => n > 0).map(([id, n]) => [id, n])) }));
        return {
            ships,
            templates,
            expeditionCount: number('expeditionCount'),
            maxExpeditionCount: number('maxExpeditionCount'),
            fleetCount: number('fleetCount'),
            maxFleetCount: number('maxFleetCount'),
        };
    }

    function saveFleetStats(planetId, data, at = Date.now()) {
        const all = loadJson(FLEET_STATS_KEY, {});
        all[planetId] = { ...data, at };
        localStorage.setItem(FLEET_STATS_KEY, JSON.stringify(all));
    }

    // Sur la page Flotte, les données sont déjà là
    function recordFleetStatsHere() {
        if (getCurrentPage() !== 'fleetdispatch') return;
        const text = [...document.scripts].map(s => s.textContent).filter(t => t.includes('shipsOnPlanet')).join('\n');
        const data = text && parseFleetDispatchData(text);
        if (data) saveFleetStats(getCurrentPlanetId(), data);
    }

    // Vaisseaux d'une infobulle de flotte : { id: nombre } (les ressources et les « ? » sont ignorés)
    function parseFleetShips(tooltipHtml) {
        const ships = {};
        for (const m of String(tooltipHtml || '').matchAll(/<td colspan="2">([^<]+):<\/td>\s*<td class="value">([^<]+)<\/td>/g)) {
            const id = SHIP_IDS_BY_NAME[normalizeShipName(m[1])];
            const count = parseInt(m[2].replace(/\D/g, ''), 10);
            if (id && count > 0) ships[id] = (ships[id] || 0) + count;
        }
        return ships;
    }

    // Flottes qui reviennent, par planète/lune de retour : lignes « retour » de vos propres flottes.
    // Sur chaque ligne d'un aller-retour, l'origine est la planète de départ, donc celle du retour.
    function recordReturningFleets() {
        const content = document.querySelector('#eventContent');
        if (!content) return;
        const rows = [...content.querySelectorAll('tr.eventFleet')];
        if (rows.length === 0 && !/Pas de mouvement/i.test(content.textContent)) return;

        const bodies = {};
        rows.forEach(row => {
            if (row.dataset.returnFlight !== 'true') return;
            const missionImg = row.querySelector('.missionFleet img');
            const missionTitle = missionImg ? (missionImg.getAttribute('data-tooltip-title') || missionImg.getAttribute('title') || '') : '';
            if (!missionTitle.includes('Propre flotte')) return;

            const coords = (row.querySelector('.coordsOrigin')?.textContent || '').replace(/[\[\]\s]/g, '');
            if (!coords) return;
            const origin = row.querySelector('.originFleet');
            const isMoon = !!origin && (!!origin.querySelector('figure.moon') || origin.innerHTML.toLowerCase().includes('lune'));
            const tooltip = row.querySelector('.icon_movement_reserve [data-tooltip-title], .icon_movement [data-tooltip-title], .icon_movement_reserve [title], .icon_movement [title]');
            const ships = parseFleetShips(tooltip ? (tooltip.getAttribute('data-tooltip-title') || tooltip.getAttribute('title')) : '');
            if (Object.keys(ships).length === 0) return;

            const key = getBodyKey(isMoon ? 'moon' : 'planet', coords);
            (bodies[key] = bodies[key] || []).push({
                arrival: serverSecondsToLocalMs(parseInt(row.dataset.arrivalTime) || 0),
                mission: parseInt(row.dataset.missionType) || 0,
                ships,
            });
        });
        localStorage.setItem(FLEET_RETURNS_KEY, JSON.stringify({ at: Date.now(), bodies }));
    }

    // Récupère la page Flotte de la planète affichée en arrière-plan (sans naviguer)
    let fleetStatsLoading = false;
    async function refreshFleetStats() {
        renderFleetStats();
        if (fleetStatsLoading) return;
        const planetId = getCurrentPlanetId();
        if (!planetId) return;
        fleetStatsLoading = true;
        renderFleetStats();
        try {
            const response = await fetch(`${window.location.origin}/game/index.php?page=ingame&component=fleetdispatch&cp=${planetId}`, { credentials: 'include' });
            const data = parseFleetDispatchData(await response.text());
            if (data) saveFleetStats(planetId, data);
        } catch (e) {
            console.log('[Stats] Lecture de la page Flotte impossible:', e);
        } finally {
            fleetStatsLoading = false;
            recordReturningFleets();
            renderFleetStats();
        }
    }

    function formatAgo(time) {
        const s = Math.max(0, Math.round((Date.now() - time) / 1000));
        if (s < 60) return `${s} s`;
        if (s < 3600) return `${Math.floor(s / 60)} min`;
        return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60).toString().padStart(2, '0')}`;
    }

    function renderFleetStats() {
        const container = document.getElementById('cfg-stats-container');
        if (!container) return;

        const body = getCurrentBody();
        const stats = loadJson(FLEET_STATS_KEY, {})[body.id];
        const returnsData = loadJson(FLEET_RETURNS_KEY, { bodies: {} });
        const label = `${body.type === 'moon' ? '🌙' : '🌍'} ${body.name || ''} [${body.coords}]`;
        const fmt = n => Number(n || 0).toLocaleString('fr-FR');

        if (!stats) {
            container.innerHTML = `<div class="hint">${label} : ${fleetStatsLoading ? 'chargement de la page Flotte…' : 'aucune donnée. Cliquez sur 🔄 ou ouvrez la page Flotte.'}</div>`;
            return;
        }

        // Retours attendus après le relevé « à quai » (ceux arrivés avant sont déjà comptés à quai)
        const now = Date.now();
        const returns = (returnsData.bodies[getBodyKey(body.type, body.coords)] || []).filter(r => r.arrival > stats.at);
        const returning = {};
        let nextArrival = null;
        returns.forEach(r => {
            Object.entries(r.ships).forEach(([id, n]) => { returning[id] = (returning[id] || 0) + n; });
            if (r.arrival > now && (!nextArrival || r.arrival < nextArrival)) nextArrival = r.arrival;
        });
        const total = { ...stats.ships };
        Object.entries(returning).forEach(([id, n]) => { total[id] = (total[id] || 0) + n; });

        const ids = Object.keys(total).map(Number).filter(id => total[id] > 0).sort((a, b) => a - b);
        let html = `<div class="stats-body">${label}</div>`;
        html += `<div class="hint">À quai : relevé il y a ${formatAgo(stats.at)}${fleetStatsLoading ? ' (actualisation…)' : ''} · Retours : ${returnsData.at ? `liste des mouvements lue il y a ${formatAgo(returnsData.at)}` : 'liste des mouvements jamais lue (ouvrez la Vue d\'ensemble)'}</div>`;

        if (ids.length === 0) {
            html += '<div class="hint" style="margin-top: 8px;">Aucun vaisseau.</div>';
        } else {
            html += '<table class="stats-table"><tr><th>Vaisseau</th><th>À quai</th><th>En retour</th><th>Total</th></tr>';
            ids.forEach(id => {
                html += `<tr><td>${SHIP_NAMES[id] || `#${id}`}</td><td>${fmt(stats.ships[id])}</td><td>${returning[id] ? fmt(returning[id]) : '–'}</td><td><b>${fmt(total[id])}</b></td></tr>`;
            });
            html += '</table>';
            html += `<div class="hint">${returns.length} flotte(s) en retour vers cette ${body.type === 'moon' ? 'lune' : 'planète'}${nextArrival ? ` · prochain retour ${formatClock(nextArrival)} (dans ${formatDelay(nextArrival - now)})` : ''}</div>`;
        }

        // Répartition : total (à quai + en retour) ÷ nombre maximum d'expéditions = composition d'une expédition
        html += '<div class="section-title">🚀 Répartition par expédition</div>';
        const maxExp = stats.maxExpeditionCount || 0;
        if (!maxExp) {
            html += '<div class="hint">Nombre maximum d\'expéditions inconnu (ouvrez la page Flotte puis 🔄).</div>';
        } else if (ids.length === 0) {
            html += '<div class="hint">Aucun vaisseau à répartir.</div>';
        } else {
            const templates = stats.templates || [];
            html += `<div class="stats-slots">Total ÷ <b>${maxExp}</b> expédition(s) max (en cours : ${stats.expeditionCount || 0})</div>`;
            html += `<table class="stats-table"><tr><th>Vaisseau</th><th>Total</th><th>÷ ${maxExp} par expé</th><th>Reste</th>${templates.map(t => `<th>${t.name}</th>`).join('')}</tr>`;
            const shipIds = [...new Set([...ids, ...templates.flatMap(t => Object.keys(t.ships).map(Number))])].sort((a, b) => a - b);
            shipIds.forEach(id => {
                const perExp = Math.floor((total[id] || 0) / maxExp);
                const rest = (total[id] || 0) - perExp * maxExp;
                const cells = templates.map(t => {
                    const want = t.ships[id] || 0;
                    if (!want) return '<td>–</td>';
                    // Plus que la répartition : impossible de remplir tous les créneaux avec cette flotte
                    return `<td class="${want > perExp ? 'stats-over' : 'stats-ok'}">${fmt(want)}</td>`;
                }).join('');
                html += `<tr><td>${SHIP_NAMES[id] || `#${id}`}</td><td>${fmt(total[id])}</td><td><b>${fmt(perExp)}</b></td><td>${rest ? fmt(rest) : '–'}</td>${cells}</tr>`;
            });
            html += '</table>';
            if (templates.length > 0) {
                html += `<div class="hint">Flotte enregistrée en <span class="stats-over">rouge</span> : elle demande plus que la répartition, les ${maxExp} expéditions ne pourront pas toutes partir ; en <span class="stats-ok">vert</span> : OK.</div>`;
            }
        }
        container.innerHTML = html;
    }

    // ===== Inactivité : les actions automatiques attendent que l'humain ait fini =====

    const ACTIVITY_KEY = 'ogame_plugin_last_activity';
    let lastActivityWrite = 0;

    // Seuls les événements réellement produits par l'utilisateur comptent (isTrusted) :
    // les clics/touches simulés par le plugin ne remettent pas le compteur à zéro.
    // Mémorisé en localStorage : un clic sur un lien compte aussi pour la page suivante.
    function watchUserActivity() {
        const onActivity = (e) => {
            if (!e.isTrusted) return;
            const now = Date.now();
            if (now - lastActivityWrite < 1000) return;
            lastActivityWrite = now;
            try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch (err) {}
        };
        ['mousedown', 'keydown', 'wheel', 'touchstart', 'mousemove'].forEach(type => {
            document.addEventListener(type, onActivity, { capture: true, passive: true });
        });
    }

    // Millisecondes restantes avant que les actions automatiques puissent reprendre (0 = inactif)
    function getIdleRemaining() {
        if (!CONFIG.idle || !CONFIG.idle.enabled) return 0;
        const last = parseInt(localStorage.getItem(ACTIVITY_KEY) || '0', 10) || 0;
        return Math.max(0, last + (CONFIG.idle.delay || 60) * 1000 - Date.now());
    }

    function isUserIdle() {
        return getIdleRemaining() === 0;
    }

    // Relance `fn` quand l'utilisateur sera inactif (un seul minuteur par clé)
    const idleRetryTimers = {};
    function runWhenIdle(key, fn) {
        if (idleRetryTimers[key]) return;
        const delay = getIdleRemaining() + 1000;
        idleRetryTimers[key] = setTimeout(() => {
            delete idleRetryTimers[key];
            if (!isUserIdle()) {
                runWhenIdle(key, fn);
                return;
            }
            fn();
        }, delay);
    }

    function renderIdleCard() {
        let card = document.getElementById('ogame-plugin-idle');
        const remaining = getIdleRemaining();
        if (remaining === 0) {
            if (card) card.remove();
            return;
        }
        if (!card) {
            card = document.createElement('div');
            card.id = 'ogame-plugin-idle';
            card.className = 'ogp-card';
            card.title = 'Expéditions auto, files de construction et clic aléatoire attendent la fin de votre activité. Panic, repli et alertes ne sont jamais retardés.';
            card.innerHTML = '<span class="idle-label">🖐️ Actions auto en pause</span><span class="idle-value"></span>';
            // Juste sous la barre de boutons
            const toolbar = document.getElementById('ogame-plugin-toolbar');
            getDock().insertBefore(card, toolbar ? toolbar.nextSibling : null);
        }
        card.querySelector('.idle-value').textContent = `reprise dans ${formatDelay(remaining)}`;
    }

    function scheduleNextClick() {
        if (!CONFIG.randomClickEnabled) {
            console.log('[Monitor] Clic aléatoire désactivé');
            stopTimerDisplay();
            return;
        }

        if (isNavigationInProgress()) {
            console.log('[Monitor] Action en cours, pas de clic aléatoire');
            return;
        }

        const delay = getRandomInterval();
        nextClickTime = Date.now() + delay;
        console.log(`[Monitor] Prochain clic dans ${Math.round(delay / 1000)}s`);

        startTimerDisplay();

        const performClick = () => {
            if (!CONFIG.randomClickEnabled) {
                console.log('[Monitor] Clic aléatoire désactivé, arrêt');
                stopTimerDisplay();
                return;
            }

            checkAlerts();
            // Vous êtes en train de jouer : pas de clic aléatoire, on attend la fin de votre activité
            if (!isUserIdle()) {
                const wait = getIdleRemaining() + 1000;
                console.log(`[Monitor] Activité en cours, clic aléatoire reporté de ${Math.round(wait / 1000)}s`);
                nextClickTime = Date.now() + wait;
                setTimeout(performClick, wait);
                return;
            }
            // Lancement, découverte ou évaluation en cours dans cet onglet : changer de planète maintenant les perturberait
            if (isActionInProgress()) {
                nextClickTime = Date.now() + 15000;
                setTimeout(performClick, 15000);
                return;
            }
            clickRandomPlanet();
            scheduleNextClick();
        };
        setTimeout(performClick, delay);
    }

    function startExpeditionChecker() {
        console.log(`[Monitor] Vérification des expéditions toutes les ${CONFIG.expeditionCheckInterval / 1000}s`);

        setInterval(async () => {
            // Bilan : lecture seule (messages, mouvements), sans navigation ni changement de planète
            checkExpeditionReport();
            if (isActionInProgress()) {
                console.log('[Monitor] Action en cours, vérification ignorée');
                return;
            }

            console.log('[Monitor] Vérification périodique des expéditions...');
            await waitForEventContent(5000);
            recordReturningFleets();
            checkAlerts();
            checkExpeditions();
            await checkBuildQueues();
            await checkAutoDefense();
            await runDiscovery();
        }, CONFIG.expeditionCheckInterval);
    }

    async function init() {
        console.log(`[Monitor] OgOwnax Plugin v${GM_info.script.version}`);

        if (!isPluginEnabled()) {
            console.log('[Monitor] ⛔ Plugin désactivé : aucune surveillance ni action automatique');
            const toolbar = createToolbar();
            toolbar.style.width = 'auto';
            toolbar.querySelector('.ogp-buttons').appendChild(createToggleButton());
            return;
        }

        createConfigPanel();
        // Mémorise les constructions visibles sur cette page (bâtiment et/ou formes de vie)
        recordConstructionInfoHere();
        rememberFleetTemplates();
        recordFleetStatsHere();
        watchUserActivity();
        watchOgLightListButton();
        setInterval(renderIdleCard, 1000);
        watchPageResources();
        initBuildQueueUI();
        recordDefenseResourcesHere();

        if (!CONFIG.discordWebhook) {
            console.log('[Monitor] ⚠️ Webhook Discord non configuré : ouvrez le panneau ⚙️ pour le renseigner');
        }

        const planets = getPlanets();
        const moons = getMoons();
        console.log('[Monitor] Planètes détectées:', planets);
        console.log('[Monitor] Lunes détectées:', moons);

        console.log(`[Monitor] Mode reconnexion: ${CONFIG.autoReconnect ? 'activé' : 'désactivé'}`);
        console.log(`[Monitor] Lancement auto: ${CONFIG.autoLaunchExpeditions ? 'activé' : 'désactivé'}`);
        console.log(`[Monitor] Repli auto: ${CONFIG.fleeConfig.enabled ? 'activé' : 'désactivé'}`);

        if (CONFIG.expeditionStartHour !== null || CONFIG.expeditionEndHour !== null) {
            const start = CONFIG.expeditionStartHour !== null ? `${CONFIG.expeditionStartHour}h` : '0h';
            const end = CONFIG.expeditionEndHour !== null ? `${CONFIG.expeditionEndHour}h` : '24h';
            console.log(`[Monitor] Créneau expéditions: ${start} - ${end}`);
            console.log(`[Monitor] Dans le créneau: ${isInExpeditionTimeSlot() ? 'oui' : 'non'}`);
        } else {
            console.log('[Monitor] Créneau expéditions: aucune limite');
        }

        console.log(`[Monitor] Clic aléatoire: ${CONFIG.randomClickEnabled ? 'activé' : 'désactivé'}`);
        console.log(`[Monitor] Alerte attaque: ${CONFIG.alertAttack ? 'activé' : 'désactivé'}`);
        console.log(`[Monitor] Alerte espionnage: ${CONFIG.alertEspionage ? 'activé' : 'désactivé'}`);

        if (CONFIG.panic.sourceId && CONFIG.panic.destinationId) {
            console.log(`[Monitor] Panic configuré: ${CONFIG.panic.sourceType}_${CONFIG.panic.sourceId} -> ${CONFIG.panic.destinationType}_${CONFIG.panic.destinationId} @ ${CONFIG.panic.speed}%`);
        } else {
            console.log('[Monitor] Panic non configuré');
        }

        if (CONFIG.fleeConfig.enabled) {
            const destCount = Object.keys(CONFIG.fleeConfig.destinations).length;
            console.log(`[Monitor] Repli configuré pour ${destCount} corps céleste(s)`);
            console.log(`[Monitor] Délai repli: ${CONFIG.fleeConfig.delayBeforeImpact}s avant impact`);
        }

        restoreAllScheduledFlee();

        const panicState = loadPanicState();
        if (panicState && panicState.active) {
            console.log('[Panic] Reprise du panic en cours...');
            processPanicState();
            return;
        }

        const fleeState = loadFleeState();
        const hasActiveFlee = Object.values(fleeState).some(s => s && s.active);
        if (hasActiveFlee) {
            console.log('[Flee] Reprise du repli en cours...');
            processFleeState();
            return;
        }

        const launchState = loadLaunchState();
        if (launchState && launchState.active) {
            console.log('[Monitor] Reprise du lancement en cours...');
            document.getElementById('ogame-plugin-btn').classList.add('launching');
            showLaunchProgress();
            processLaunchState();
            return;
        }

        const defenseState = loadDefenseState();
        if (defenseState && defenseState.active) {
            buildLog('🏰 Reprise de la défense automatique...');
            await processDefenseState();
            if (isNavigationInProgress()) {
                return;
            }
        }

        const buildState = loadBuildState();
        if (buildState && buildState.active) {
            buildLog('Reprise de la file de construction...');
            await processBuildState();
            if (isNavigationInProgress()) {
                return;
            }
        }

        if (!isLoggedIn()) {
            handleDisconnected();
        } else {
            console.log('[Monitor] Connecté ✓');

            await waitForEventContent();
            console.log('[Monitor] EventContent chargé');
            recordReturningFleets();

            const activeExpeditions = getActiveExpeditions();
            console.log('[Monitor] Expéditions actives:', activeExpeditions);

            const finishedExpeditions = getFinishedExpeditions();
            console.log('[Monitor] Expéditions terminées:', finishedExpeditions);

            console.log(`[Monitor] Total expéditions: ${getTotalActiveExpeditions()}/${getTotalExpectedExpeditions()}`);

            checkAlerts();
            checkExpeditions();
            refreshBuildEstimateHere();
            await checkBuildQueues(true);
            await checkAutoDefense();
            await runDiscovery();
            scheduleNextBuildCheck();
            startExpeditionChecker();
            scheduleNextClick();
        }
    }

    // En @run-at document-idle, l'événement load peut déjà être passé
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();
