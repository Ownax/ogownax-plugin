// ==UserScript==
// @name         OgOwnax Plugin
// @namespace    https://github.com/Ownax/ogownax-plugin
// @version      1.7.1
// @description  Alertes Discord, expéditions auto, panic et repli automatique pour OGame
// @author       Ownax
// @match        https://*.ogame.gameforge.com/*
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
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
        }
    };

    const LAUNCH_STATE_KEY = 'ogame_plugin_launch_state';
    const PANIC_STATE_KEY = 'ogame_plugin_panic_state';
    const FLEE_STATE_KEY = 'ogame_plugin_flee_state';
    const SCHEDULED_FLEE_KEY = 'ogame_plugin_scheduled_flee';
    const PROCESSED_ATTACKS_KEY = 'ogame_plugin_processed_attacks';

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
        }

        GM_setValue(ENABLED_STORAGE_KEY, enabled);
        console.log(`[Monitor] Plugin ${enabled ? 'activé' : 'désactivé'}`);
        await notifyDiscord(enabled
            ? `▶️ **OgOwnax Plugin activé** sur ${window.location.hostname}`
            : `⏸️ **OgOwnax Plugin désactivé** sur ${window.location.hostname} - plus aucune alerte ne sera envoyée`);
        window.location.reload();
    }

    function createToggleButton() {
        const style = document.createElement('style');
        style.textContent = `
            #ogame-plugin-buttons {
                position: fixed;
                top: 50px;
                right: 10px;
                z-index: 10000;
                display: flex;
                gap: 5px;
            }
            #ogame-plugin-toggle {
                padding: 8px 12px;
                cursor: pointer;
                font-size: 12px;
                border-radius: 4px;
                font-weight: bold;
            }
            #ogame-plugin-toggle.enabled {
                background: linear-gradient(180deg, #1a4a2a 0%, #0d2915 100%);
                border: 1px solid #3c6a4a;
                color: #9fffaf;
            }
            #ogame-plugin-toggle.disabled {
                background: linear-gradient(180deg, #3a3a3a 0%, #1a1a1a 100%);
                border: 1px solid #6a3c3c;
                color: #ff9f9f;
            }
        `;
        document.head.appendChild(style);

        const enabled = isPluginEnabled();
        const btn = document.createElement('button');
        btn.id = 'ogame-plugin-toggle';
        btn.className = enabled ? 'enabled' : 'disabled';
        btn.textContent = enabled ? '✅ Activé' : '⛔ Désactivé';
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
                    console.log('[Monitor] Sur la page flotte, appui sur L');
                    await wait(1000);
                    pressKey('l');
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
                    saveLaunchState({ ...state, step: 'send_fleet' });
                    await wait(1000);
                    processLaunchState();
                } catch (e) {
                    console.log('[Monitor] Bouton Continuer non disponible, annulation');
                    showLaunchStatus('Erreur: bouton Continuer non disponible', true);
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

                    notifyDiscord(`🚀 **Expédition lancée** depuis ${bodyLabel} [${state.currentBody.coords}] (${state.currentBody.launched}/${state.currentBody.missing})`);

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

        notifyDiscord(`🤖 **Lancement automatique** de ${totalMissing} expédition(s) sur ${bodyDesc}`);

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

        document.getElementById('ogame-plugin-panel').style.display = 'none';

        goToCelestialBody(firstBody.id, firstBody.type);
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
            #ogame-plugin-timer {
                position: fixed;
                top: 10px;
                right: 10px;
                z-index: 10000;
                background: linear-gradient(180deg, #1a3a4a 0%, #0d1f29 100%);
                border: 1px solid #3c5a6a;
                color: #9fc3d6;
                padding: 6px 12px;
                font-size: 11px;
                border-radius: 4px;
                font-family: Verdana, Arial, sans-serif;
                display: none;
            }
            #ogame-plugin-timer.active {
                display: block;
            }
            #ogame-plugin-timer .timer-label {
                color: #6a9aaa;
                margin-right: 5px;
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
            #ogame-plugin-btn, #ogame-plugin-panic-btn {
                background: linear-gradient(180deg, #1a3a4a 0%, #0d1f29 100%);
                border: 1px solid #3c5a6a;
                color: #9fc3d6;
                padding: 8px 12px;
                cursor: pointer;
                font-size: 12px;
                border-radius: 4px;
            }
            #ogame-plugin-btn:hover {
                background: linear-gradient(180deg, #2a4a5a 0%, #1d2f39 100%);
            }
            #ogame-plugin-btn.launching {
                background: linear-gradient(180deg, #3a4a1a 0%, #1f290d 100%);
                border-color: #5a6a3c;
            }
            #ogame-plugin-btn.no-webhook {
                border-color: #cfaf6f;
            }
            #ogame-plugin-panic-btn {
                background: linear-gradient(180deg, #4a1a1a 0%, #290d0d 100%);
                border-color: #6a3c3c;
                color: #ff9f9f;
            }
            #ogame-plugin-panic-btn:hover {
                background: linear-gradient(180deg, #5a2a2a 0%, #391d1d 100%);
            }
            #ogame-plugin-panel {
                display: none;
                position: fixed;
                top: 90px;
                right: 10px;
                z-index: 10001;
                background: linear-gradient(180deg, #0d1f29 0%, #061015 100%);
                border: 2px solid #3c5a6a;
                border-radius: 8px;
                padding: 15px;
                width: 450px;
                max-height: 80vh;
                overflow-y: auto;
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

        const timer = document.createElement('div');
        timer.id = 'ogame-plugin-timer';
        timer.innerHTML = `
            <span class="timer-label">⏱️ Prochain clic:</span>
            <span class="timer-value" id="timer-countdown">--:--</span>
        `;
        document.body.appendChild(timer);

        const buttonsContainer = document.createElement('div');
        buttonsContainer.id = 'ogame-plugin-buttons';
        buttonsContainer.innerHTML = `
            <button id="ogame-plugin-panic-btn">🚨 PANIC</button>
            <button id="ogame-plugin-btn">⚙️ OgOwnax Plugin</button>
        `;
        buttonsContainer.appendChild(createToggleButton());
        document.body.appendChild(buttonsContainer);

        const panel = document.createElement('div');
        panel.id = 'ogame-plugin-panel';
        panel.innerHTML = `
            <h3>⚙️ Configuration OgOwnax Plugin <span class="plugin-version">v${GM_info.script.version}</span></h3>

            <div class="section-title panic">🚨 Mode Panic (Global)</div>

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

                <div class="config-group">
                    <label>Vitesse (%)</label>
                    <select id="cfg-panic-speed">
                        <option value="10">10%</option>
                        <option value="20">20%</option>
                        <option value="30">30%</option>
                        <option value="40">40%</option>
                        <option value="50">50%</option>
                        <option value="60">60%</option>
                        <option value="70">70%</option>
                        <option value="80">80%</option>
                        <option value="90">90%</option>
                        <option value="100">100%</option>
                    </select>
                    <div class="hint">Vitesse recommandée: 10% pour maximiser le temps de vol</div>
                </div>
            </div>

            <div class="config-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="cfg-panic-auto">
                    🔥 Auto-Panic en cas d'attaque
                </label>
                <div class="hint">Déclenche automatiquement le panic avant l'impact</div>
            </div>

            <div class="config-group">
                <label>Délai avant impact (en secondes)</label>
                <input type="number" id="cfg-panic-delay" min="5" max="60" style="width: 80px;">
                <div class="hint">Le panic sera déclenché X secondes avant l'impact</div>
            </div>

            <div class="section-title flee">🏃 Repli automatique (par planète/lune)</div>

            <div class="flee-box">
                <div class="config-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="cfg-flee-enabled">
                        Activer le repli automatique
                    </label>
                    <div class="hint">Envoie automatiquement la flotte + ressources vers la destination de repli configurée</div>
                </div>

                <div class="config-group">
                    <label>Vitesse de repli (%)</label>
                    <select id="cfg-flee-speed">
                        <option value="10">10%</option>
                        <option value="20">20%</option>
                        <option value="30">30%</option>
                        <option value="40">40%</option>
                        <option value="50">50%</option>
                        <option value="60">60%</option>
                        <option value="70">70%</option>
                        <option value="80">80%</option>
                        <option value="90">90%</option>
                        <option value="100">100%</option>
                    </select>
                </div>

                <div class="config-group">
                    <label>Délai avant impact (en secondes)</label>
                    <input type="number" id="cfg-flee-delay" min="5" max="600" style="width: 80px;">
                    <div class="hint">Le repli sera déclenché X secondes avant l'impact (ex: 240 = 4 minutes avant)</div>
                </div>

                <div class="section-title" style="margin-top: 10px; font-size: 11px;">Destinations de repli</div>
                <div id="cfg-flee-destinations-container">
                </div>
            </div>

            <div class="section-title">🔔 Alertes</div>

            <div class="config-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="cfg-alert-attack">
                    ⚔️ Alerte attaque
                </label>
                <div class="hint">Notifie sur Discord lors d'une attaque ennemie</div>
            </div>

            <div class="config-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="cfg-alert-espionage">
                    🔍 Alerte espionnage
                </label>
                <div class="hint">Notifie sur Discord lors d'un espionnage ennemi</div>
            </div>

            <div class="config-group">
                <label>Webhook Discord</label>
                <textarea id="cfg-webhook" rows="2" placeholder="https://discord.com/api/webhooks/..."></textarea>
                <div class="hint">Stocké dans Tampermonkey (commun à tous les univers de ce navigateur), jamais dans le script</div>
                <button class="btn-test" id="cfg-test-webhook">📨 Tester le webhook</button>
            </div>

            <div class="section-title">
                🚀 Expéditions par planète/lune
                <button class="refresh-btn" id="cfg-refresh-expeditions" title="Rafraîchir">🔄</button>
            </div>

            <div id="cfg-expeditions-container">
            </div>

            <div class="config-group" style="margin-top: 10px;">
                <label class="checkbox-label">
                    <input type="checkbox" id="cfg-auto-launch">
                    Lancement automatique des expéditions
                </label>
                <div class="hint">Lance automatiquement les expéditions manquantes</div>
            </div>

            <div class="config-group">
                <label>Créneau horaire d'expédition</label>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="number" id="cfg-expedition-start-hour" min="0" max="23" style="width: 60px;" placeholder="--">
                    <span>h à</span>
                    <input type="number" id="cfg-expedition-end-hour" min="0" max="23" style="width: 60px;" placeholder="--">
                    <span>h</span>
                </div>
                <div class="hint">Laisser vide pour aucune limite (ex: 8 à 22 pour 8h-22h)</div>
            </div>

            <div class="config-group">
                <label>Intervalle de vérification (en secondes)</label>
                <input type="number" id="cfg-expedition-check-interval" min="10" max="600">
                <div class="hint">Fréquence de vérification des expéditions manquantes</div>
            </div>

            <button class="btn-launch" id="cfg-launch-expeditions">
                🚀 Lancer les expéditions manquantes
            </button>

            <div class="section-title">🖱️ Navigation automatique</div>

            <div class="config-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="cfg-random-click-enabled">
                    Activer le clic aléatoire
                </label>
                <div class="hint">Clique sur une planète aléatoire pour maintenir la session active</div>
            </div>

            <div class="config-group">
                <label>Intervalle clic aléatoire (en secondes)</label>
                <input type="number" id="cfg-random-click-interval" min="60" max="3600">
                <div class="hint">Clic aléatoire entre -30s et +30s de cette valeur (min: 60s)</div>
            </div>

            <div class="section-title">⏱️ Cooldowns (en secondes)</div>

            <div class="config-group">
                <label>Cooldown expédition</label>
                <input type="number" id="cfg-cd-expedition" min="1">
            </div>

            <div class="config-group">
                <label>Cooldown attaque</label>
                <input type="number" id="cfg-cd-attack" min="1">
            </div>

            <div class="config-group">
                <label>Cooldown espionnage</label>
                <input type="number" id="cfg-cd-espionage" min="1">
            </div>

            <div class="config-group">
                <label>Cooldown déconnexion</label>
                <input type="number" id="cfg-cd-disconnected" min="1">
            </div>

            <div class="section-title">🔄 Reconnexion</div>

            <div class="config-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="cfg-auto-reconnect">
                    Reconnexion automatique
                </label>
            </div>

            <div class="config-group">
                <label>Délai reconnexion (en secondes)</label>
                <input type="number" id="cfg-reconnect-delay" min="1">
            </div>

            <div class="btn-group">
                <button class="btn-save" id="cfg-save">💾 Sauvegarder</button>
                <button class="btn-reset" id="cfg-reset">🔄 Reset</button>
                <button class="btn-cancel" id="cfg-cancel">❌ Fermer</button>
            </div>
        `;
        document.body.appendChild(panel);

        updateWebhookIndicator();

        document.getElementById('ogame-plugin-btn').addEventListener('click', () => {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            if (panel.style.display === 'block') {
                loadFormValues();
            }
        });

        document.getElementById('ogame-plugin-panic-btn').addEventListener('click', executePanic);

        document.getElementById('cfg-save').addEventListener('click', saveFormValues);
        document.getElementById('cfg-cancel').addEventListener('click', () => {
            panel.style.display = 'none';
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
        document.getElementById('cfg-refresh-expeditions').addEventListener('click', () => {
            renderExpeditionsConfig();
            renderFleeDestinations();
        });
        document.getElementById('cfg-launch-expeditions').addEventListener('click', launchMissingExpeditions);
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

    function loadFormValues() {
        document.getElementById('cfg-alert-attack').checked = CONFIG.alertAttack;
        document.getElementById('cfg-alert-espionage').checked = CONFIG.alertEspionage;
        document.getElementById('cfg-webhook').value = CONFIG.discordWebhook;
        document.getElementById('cfg-auto-launch').checked = CONFIG.autoLaunchExpeditions;
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

        renderPanicSelects();
        renderExpeditionsConfig();
        renderFleeDestinations();
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
            }
        };

        saveConfig(CONFIG);
        updateWebhookIndicator();
        alert('Configuration sauvegardée !');
        document.getElementById('ogame-plugin-panel').style.display = 'none';
        const { discordWebhook, ...loggable } = CONFIG;
        console.log('[Monitor] Configuration mise à jour:', loggable);
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
            sendDiscord(`🚀 **${activeTotal}/${expectedTotal} Expédition(s)** (${finishedTotal} terminée(s))`, 'expedition', 'expedition');

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

    function scheduleNextClick() {
        if (!CONFIG.randomClickEnabled) {
            console.log('[Monitor] Clic aléatoire désactivé');
            stopTimerDisplay();
            return;
        }

        const state = loadLaunchState();
        const panicState = loadPanicState();
        const fleeState = loadFleeState();
        const hasActiveFlee = Object.values(fleeState).some(s => s && s.active);

        if ((state && state.active) || (panicState && panicState.active) || hasActiveFlee) {
            console.log('[Monitor] Action en cours, pas de clic aléatoire');
            return;
        }

        const delay = getRandomInterval();
        nextClickTime = Date.now() + delay;
        console.log(`[Monitor] Prochain clic dans ${Math.round(delay / 1000)}s`);

        startTimerDisplay();

        setTimeout(() => {
            if (!CONFIG.randomClickEnabled) {
                console.log('[Monitor] Clic aléatoire désactivé, arrêt');
                stopTimerDisplay();
                return;
            }

            checkAlerts();
            clickRandomPlanet();
            scheduleNextClick();
        }, delay);
    }

    function startExpeditionChecker() {
        console.log(`[Monitor] Vérification des expéditions toutes les ${CONFIG.expeditionCheckInterval / 1000}s`);

        setInterval(async () => {
            const state = loadLaunchState();
            const panicState = loadPanicState();
            const fleeState = loadFleeState();
            const hasActiveFlee = Object.values(fleeState).some(s => s && s.active);

            if ((state && state.active) || (panicState && panicState.active) || hasActiveFlee) {
                console.log('[Monitor] Action en cours, vérification ignorée');
                return;
            }

            console.log('[Monitor] Vérification périodique des expéditions...');
            await waitForEventContent(5000);
            checkAlerts();
            checkExpeditions();
        }, CONFIG.expeditionCheckInterval);
    }

    async function init() {
        console.log(`[Monitor] OgOwnax Plugin v${GM_info.script.version}`);

        if (!isPluginEnabled()) {
            console.log('[Monitor] ⛔ Plugin désactivé : aucune surveillance ni action automatique');
            const buttonsContainer = document.createElement('div');
            buttonsContainer.id = 'ogame-plugin-buttons';
            buttonsContainer.appendChild(createToggleButton());
            document.body.appendChild(buttonsContainer);
            return;
        }

        createConfigPanel();

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

        if (!isLoggedIn()) {
            handleDisconnected();
        } else {
            console.log('[Monitor] Connecté ✓');

            await waitForEventContent();
            console.log('[Monitor] EventContent chargé');

            const activeExpeditions = getActiveExpeditions();
            console.log('[Monitor] Expéditions actives:', activeExpeditions);

            const finishedExpeditions = getFinishedExpeditions();
            console.log('[Monitor] Expéditions terminées:', finishedExpeditions);

            console.log(`[Monitor] Total expéditions: ${getTotalActiveExpeditions()}/${getTotalExpectedExpeditions()}`);

            checkAlerts();
            checkExpeditions();
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
