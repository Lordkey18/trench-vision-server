const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const cors = require('cors'); // Ajout du middleware CORS
const app = express();

app.use(express.json());
app.use(cors()); // Active CORS pour toutes les routes

const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

let tokens = [];
let price_updates = {};
let running = false;
let websocket = null;
let alerts = [];

async function send_telegram_notification(chatId, message) {
    if (!chatId) {
        console.error(`[${new Date().toISOString()}] Chat ID non défini pour l'envoi Telegram`);
        return;
    }
    try {
        await telegramBot.sendMessage(chatId, message);
        console.log(`[${new Date().toISOString()}] Notification Telegram envoyée à ${chatId}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erreur envoi Telegram à ${chatId} : ${error.message}`);
    }
}

async function get_sol_usd_rate() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        return response.data.solana.usd || 150;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erreur taux SOL/USD : ${error.message}`);
        return 150;
    }
}

async function check_if_raydium(ca) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
        const isRaydium = response.data.pairs && response.data.pairs.some(pair => pair.dexId === "raydium");
        console.log(`[${new Date().toISOString()}] Vérification Raydium pour ${ca} : ${isRaydium}`);
        return isRaydium;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erreur vérif Raydium : ${error.message}`);
        return false;
    }
}

async function get_price_from_dexscreener(ca) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
        const raydiumPair = response.data.pairs && response.data.pairs.find(pair => pair.dexId === "raydium");
        const price = raydiumPair ? parseFloat(raydiumPair.priceUsd) : null;
        console.log(`[${new Date().toISOString()}] Prix Raydium pour ${ca} : ${price}`);
        return price;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erreur Dexscreener : ${error.message}`);
        return null;
    }
}

async function websocket_listener() {
    const uri = "wss://pumpportal.fun/api/data";
    const sol_usd_rate = await get_sol_usd_rate();
    console.log(`[${new Date().toISOString()}] Tentative de connexion WebSocket à ${uri}`);
    websocket = new WebSocket(uri);

    websocket.on('open', () => {
        console.log(`[${new Date().toISOString()}] Connexion WebSocket ouverte à ${uri}`);
        const pumpfun_tokens = tokens.filter(token => !token.is_raydium).map(token => token.ca);
        if (pumpfun_tokens.length) {
            const payload = { method: "subscribeTokenTrade", keys: pumpfun_tokens };
            websocket.send(JSON.stringify(payload));
            console.log(`[${new Date().toISOString()}] Abonnement WebSocket envoyé : ${JSON.stringify(payload)}`);
        } else {
            console.log(`[${new Date().toISOString()}] Aucun token Pumpfun à souscrire`);
        }
    });

    websocket.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] WebSocket reçu : ${JSON.stringify(data)}`);
            if (data.solAmount && data.tokenAmount && data.mint) {
                const ca = data.mint;
                const sol_amount = parseFloat(data.solAmount);
                const token_amount = parseFloat(data.tokenAmount);
                if (token_amount > 0) {
                    const price = sol_amount / token_amount;
                    const price_usd = price * sol_usd_rate;
                    price_updates[ca] = price_usd;
                    console.log(`[${timestamp}] Prix Pumpfun calculé pour ${ca} : ${price_usd}`);
                    tokens.filter(token => token.ca === ca && !token.is_raydium).forEach(token => {
                        const previousPrice = token.price;
                        token.price = price_usd;
                        console.log(`[${timestamp}] Prix appliqué au token ${token.ca} : ${price_usd}`);
                        const display_text = token.name || ca.substring(0, 10) + "...";

                        if (token.threshold_high && price_usd >= token.threshold_high && !token.high_alert_sent) {
                            console.log(`[${timestamp}] Seuil haut dépassé pour ${display_text} !`);
                            const alertMsg = `[${timestamp}] Haut - ${display_text}: ${price_usd.toFixed(6)} $ (Seuil: ${token.threshold_high.toFixed(6)} $)`;
                            alerts.push(alertMsg);
                            send_telegram_notification(token.chatId, `Le prix de ${token.name || token.ca} a dépassé ${token.threshold_high.toFixed(6)} $ ! Actuel : ${price_usd.toFixed(6)} $`);
                            token.high_alert_sent = true;
                        }
                        else if (token.threshold_low && price_usd <= token.threshold_low && !token.low_alert_sent) {
                            console.log(`[${timestamp}] Seuil bas atteint pour ${display_text} !`);
                            const alertMsg = `[${timestamp}] Bas - ${display_text}: ${price_usd.toFixed(6)} $ (Seuil: ${token.threshold_low.toFixed(6)} $)`;
                            alerts.push(alertMsg);
                            send_telegram_notification(token.chatId, `Le prix de ${token.name || token.ca} est tombé sous ${token.threshold_low.toFixed(6)} $ ! Actuel : ${price_usd.toFixed(6)} $`);
                            token.low_alert_sent = true;
                        }
                        if (token.threshold_high && token.threshold_low && token.threshold_low < price_usd && price_usd < token.threshold_high) {
                            if (token.high_alert_sent || token.low_alert_sent) {
                                console.log(`[${timestamp}] Prix de ${display_text} revenu dans la plage normale, réinitialisation des alertes`);
                                token.high_alert_sent = false;
                                token.low_alert_sent = false;
                            }
                        }
                    });
                } else {
                    console.log(`[${timestamp}] Token ${ca} : token_amount <= 0, pas de mise à jour du prix`);
                }
            } else {
                console.log(`[${timestamp}] Données WebSocket invalides ou incomplètes : ${JSON.stringify(data)}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Erreur parsing WebSocket : ${error.message}`);
        }
    });

    websocket.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] Erreur WebSocket : ${error.message}`);
    });

    websocket.on('close', () => {
        console.log(`[${new Date().toISOString()}] Connexion WebSocket fermée`);
        if (running) {
            console.log(`[${new Date().toISOString()}] Tentative de reconnexion dans 5s`);
            setTimeout(websocket_listener, 5000);
        }
    });
}

function check_prices_raydium() {
    setInterval(async () => {
        if (!running) {
            console.log(`[${new Date().toISOString()}] Polling Raydium inactif`);
            return;
        }
        for (const token of tokens.filter(t => t.is_raydium)) {
            try {
                const price_usd = await get_price_from_dexscreener(token.ca);
                if (price_usd !== null) {
                    const previousPrice = token.price;
                    token.price = price_usd;
                    price_updates[token.ca] = price_usd;
                    console.log(`[${new Date().toISOString()}] Prix Raydium appliqué pour ${token.ca} : ${price_usd}`);
                    const display_text = token.name || token.ca.substring(0, 10) + "...";
                    const timestamp = new Date().toISOString();

                    if (token.threshold_high && price_usd >= token.threshold_high && !token.high_alert_sent) {
                        console.log(`[${timestamp}] Seuil haut dépassé pour ${display_text} !`);
                        const alertMsg = `[${timestamp}] Haut - ${display_text}: ${price_usd.toFixed(6)} $ (Seuil: ${token.threshold_high.toFixed(6)} $)`;
                        alerts.push(alertMsg);
                        send_telegram_notification(token.chatId, `Le prix de ${token.name || token.ca} a dépassé ${token.threshold_high.toFixed(6)} $ ! Actuel : ${price_usd.toFixed(6)} $`);
                        token.high_alert_sent = true;
                    }
                    else if (token.threshold_low && price_usd <= token.threshold_low && !token.low_alert_sent) {
                        console.log(`[${timestamp}] Seuil bas atteint pour ${display_text} !`);
                        const alertMsg = `[${timestamp}] Bas - ${display_text}: ${price_usd.toFixed(6)} $ (Seuil: ${token.threshold_low.toFixed(6)} $)`;
                        alerts.push(alertMsg);
                        send_telegram_notification(token.chatId, `Le prix de ${token.name || token.ca} est tombé sous ${token.threshold_low.toFixed(6)} $ ! Actuel : ${price_usd.toFixed(6)} $`);
                        token.low_alert_sent = true;
                    }
                    if (token.threshold_high && token.threshold_low && token.threshold_low < price_usd && price_usd < token.threshold_high) {
                        if (token.high_alert_sent || token.low_alert_sent) {
                            console.log(`[${timestamp}] Prix de ${display_text} revenu dans la plage normale, réinitialisation des alertes`);
                            token.high_alert_sent = false;
                            token.low_alert_sent = false;
                        }
                    }
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Erreur Raydium pour ${token.ca} : ${error.message}`);
            }
        }
    }, 250);
}

// Routes API
app.post('/start_tracking', (req, res) => {
    if (!running) {
        running = true;
        websocket_listener();
        check_prices_raydium();
        console.log(`[${new Date().toISOString()}] Démarrage du suivi pour ${tokens.length} tokens`);
        res.status(200).json({ success: true });
    } else {
        console.log(`[${new Date().toISOString()}] Suivi déjà en cours`);
        res.status(200).json({ success: true });
    }
});

app.post('/add_token', async (req, res) => {
    const { ca, name, threshold_high, threshold_low, chatId } = req.body;
    if (!ca) return res.status(400).json({ error: "Contract Address requis" });
    if (threshold_high && threshold_low && threshold_low >= threshold_high) {
        return res.status(400).json({ error: "Seuil bas doit être inférieur au seuil haut" });
    }
    if (!chatId) return res.status(400).json({ error: "Chat ID Telegram requis" });
    tokens.push({
        ca,
        name,
        threshold_high: threshold_high ? parseFloat(threshold_high) : null,
        threshold_low: threshold_low ? parseFloat(threshold_low) : null,
        price: null,
        is_raydium: await check_if_raydium(ca),
        high_alert_sent: false,
        low_alert_sent: false,
        chatId
    });
    console.log(`[${new Date().toISOString()}] Token ajouté : ${ca} avec chatId ${chatId}`);
    if (running && websocket && websocket.readyState === WebSocket.OPEN) {
        const pumpfun_tokens = tokens.filter(token => !token.is_raydium).map(token => token.ca);
        const payload = { method: "subscribeTokenTrade", keys: pumpfun_tokens };
        websocket.send(JSON.stringify(payload));
        console.log(`[${new Date().toISOString()}] WebSocket resouscrit : ${JSON.stringify(payload)}`);
    }
    res.status(200).json({ success: true });
});

app.post('/edit_token/:index', async (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || index < 0 || index >= tokens.length) {
        return res.status(400).json({ error: "Index invalide" });
    }
    const { ca, name, threshold_high, threshold_low, chatId } = req.body;
    if (!ca) return res.status(400).json({ error: "Contract Address requis" });
    if (threshold_high && threshold_low && threshold_low >= threshold_high) {
        return res.status(400).json({ error: "Seuil bas doit être inférieur au seuil haut" });
    }
    if (!chatId) return res.status(400).json({ error: "Chat ID Telegram requis" });
    tokens[index] = {
        ...tokens[index],
        ca,
        name,
        threshold_high: threshold_high ? parseFloat(threshold_high) : null,
        threshold_low: threshold_low ? parseFloat(threshold_low) : null,
        is_raydium: await check_if_raydium(ca),
        chatId,
        high_alert_sent: false,
        low_alert_sent: false
    };
    console.log(`[${new Date().toISOString()}] Token modifié à l’index ${index} : ${ca} avec chatId ${chatId}`);
    if (running && websocket && websocket.readyState === WebSocket.OPEN) {
        const pumpfun_tokens = tokens.filter(token => !token.is_raydium).map(token => token.ca);
        const payload = { method: "subscribeTokenTrade", keys: pumpfun_tokens };
        websocket.send(JSON.stringify(payload));
        console.log(`[${new Date().toISOString()}] WebSocket resouscrit : ${JSON.stringify(payload)}`);
    }
    res.status(200).json({ success: true });
});

app.post('/stop_tracking', (req, res) => {
    running = false;
    if (websocket) websocket.close();
    console.log(`[${new Date().toISOString()}] Suivi arrêté`);
    res.status(200).json({ success: true });
});

app.post('/remove_token', (req, res) => {
    const { index } = req.body;
    const tokenIndex = parseInt(index, 10);
    if (isNaN(tokenIndex) || tokenIndex < 0 || tokenIndex >= tokens.length) {
        return res.status(400).json({ error: "Index invalide" });
    }
    if (running) {
        running = false;
        if (websocket) websocket.close();
        console.log(`[${new Date().toISOString()}] Suivi arrêté avant suppression`);
    }
    const removedToken = tokens[tokenIndex];
    tokens.splice(tokenIndex, 1);
    console.log(`[${new Date().toISOString()}] Token supprimé à l’index ${tokenIndex} : ${removedToken.ca}`);
    if (tokens.length > 0) {
        running = true;
        websocket_listener();
        check_prices_raydium();
        console.log(`[${new Date().toISOString()}] Suivi relancé pour ${tokens.length} tokens restants`);
    }
    res.status(200).json({ success: true });
});

app.post('/clear_alerts', (req, res) => {
    alerts = [];
    console.log(`[${new Date().toISOString()}] Historique des alertes effacé`);
    res.status(200).json({ success: true });
});

app.get('/get_tokens', (req, res) => {
    console.log(`[${new Date().toISOString()}] Renvoi des tokens : ${JSON.stringify(tokens)}`);
    res.status(200).json(tokens);
});

app.get('/get_alerts', (req, res) => {
    console.log(`[${new Date().toISOString()}] Renvoi des alertes : ${JSON.stringify(alerts.slice(-10))}`);
    res.status(200).json(alerts.slice(-10));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});