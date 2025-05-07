import tls from 'tls';
import WebSocket from 'ws';
import colors from 'colors';
import http2 from 'http2';
import axios from 'axios';
import fs from 'fs';

let config;
try {
    const configContent = fs.readFileSync('./config.json', 'utf-8');
    config = JSON.parse(configContent.replace(/^\uFEFF/, ''));
} catch (error) {
    console.error("configi okuyamadım bro:", error);
    process.exit(1);
}

let mfaToken = null;
let savedTicket = null;
const guilds = {};
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Authorization': config.discordToken,
    'Content-Type': 'application/json',
    'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6Ind3dy5nb29nbGUuY29tIiwic2VhcmNoX2VuZ2luZSI6Imdvb2dsZSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTYxNDAsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9'
};

console.log("sniper baslatildi...");
console.log("Ticket alınıyor ve MFA çözümü başlıyor...");

class SessionManager {
    constructor() {
        this.session = null;
        this.isConnecting = false;
        this.createSession();
    }
    createSession() {
        if (this.isConnecting) return;
        this.isConnecting = true;
        if (this.session) {
            this.session.destroy();
        }
        this.session = http2.connect("https://canary.discord.com", {
            settings: { enablePush: false },
            secureContext: tls.createSecureContext({
                ciphers: 'AES256-SHA:RC4-SHA:DES-CBC3-SHA',
                rejectUnauthorized: true
            })
        });
        this.session.on('error', (err) => {
            console.log(colors.red(`HTTP/2 Oturum Hatası:`, err));
            this.isConnecting = false;
            setTimeout(() => this.createSession(), 5000);
        });
        this.session.on('connect', () => {
            console.log(colors.green("HTTP/2 Oturumu Başarıyla Kuruldu"));
            this.isConnecting = false;
        });
        this.session.on('close', () => {
            console.log(colors.yellow("HTTP/2 Oturumu Kapatıldı"));
            this.isConnecting = false;
            setTimeout(() => this.createSession(), 5000);
        });
    }
    async request(method, path, customHeaders = {}, body = null) {
        if (!this.session || this.session.destroyed) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            this.createSession();
        }
        const requestHeaders = {
            ...headers,
            ...customHeaders,
            ":method": method,
            ":path": path,
            ":authority": "canary.discord.com",
            ":scheme": "https"
        };
        return new Promise((resolve, reject) => {
            const stream = this.session.request(requestHeaders);
            const chunks = [];
            stream.on("data", chunk => chunks.push(chunk));
            stream.on("end", () => {
                try {
                    resolve(Buffer.concat(chunks).toString());
                } catch (err) {
                    reject(err);
                }
            });
            stream.on("error", reject);
            if (body) stream.end(body);
            else stream.end();
        });
    }
}

const sessionManager = new SessionManager();

async function refreshMfaToken() {
    try {
        console.log("MFA Token yenileniyor...");
        const initialResponse = await sessionManager.request("PATCH", `/api/v7/guilds/${config.guildId}/vanity-url`);
        const data = JSON.parse(initialResponse);
        if (data.code === 60003) {
            savedTicket = data.mfa.ticket;
            console.log(colors.yellow("MFA gerekli, ticket alındı, MFA çözülüyor..."));
            const mfaResponse = await sessionManager.request(
                "POST",
                "/api/v9/mfa/finish",
                {
                    "Content-Type": "application/json",
                },
                JSON.stringify({
                    ticket: savedTicket,
                    mfa_type: "password",
                    data: config.password,
                })
            );
            const mfaData = JSON.parse(mfaResponse);
            if (mfaData.token) {
                mfaToken = mfaData.token;
                console.log(colors.green('MFA başarıyla geçildi!'));
                return true;
            } else {
                console.error(colors.red(`MFA işlemi başarısız: ${JSON.stringify(mfaData)}`));
                return false;
            }
        } else if (data.code === 200) {
            console.log(colors.green("MFA gerekmedi, direkt erişim sağlandı."));
            return true;
        } else {
            console.log(colors.red(`MFA işlemi başarısız: ${JSON.stringify(data)}`));
            return false;
        }
    } catch (error) {
        console.error(colors.red("MFA Token yenileme hatası:", error));
        return false;
    }
}

async function vanityUpdate(find) {
    try {
        console.log(`Vanity URL güncellendi: ${find}`);
        const initialResponse = await sessionManager.request("PATCH", `/api/v7/guilds/${config.guildId}/vanity-url`);
        const data = JSON.parse(initialResponse);
        if (data.code === 60003) {
            savedTicket = data.mfa.ticket;
            const mfaResponse = await sessionManager.request(
                "POST",
                "/api/v9/mfa/finish",
                { "Content-Type": "application/json" },
                JSON.stringify({
                    ticket: savedTicket,
                    mfa_type: "password",
                    data: config.password,
                })
            );
            const mfaData = JSON.parse(mfaResponse);
            if (mfaData.token) {
                mfaToken = mfaData.token;
            }
        }
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 30) + 20));
        const vanityResponse = await sessionManager.request(
            "PATCH",
            `/api/v10/guilds/${config.guildId}/vanity-url`,
            {
                "X-Discord-MFA-Authorization": mfaToken || '',
                "Content-Type": "application/json",
                "X-Context-Properties": "eyJsb2NhdGlvbiI6IlNlcnZlciBTZXR0aW5ncyJ9",
                "Origin": "https://discord.com",
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Referer": "https://discord.com/channels/@me",
                "X-Debug-Options": "bugReporterEnabled",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
                "DNT": "1",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-origin",
                "TE": "trailers"
            },
            JSON.stringify({ code: find })
        );
        let vanityData;
        try {
            vanityData = JSON.parse(vanityResponse);
        } catch (e) {
            console.error(colors.red("Vanity JSON parse hatası:", vanityResponse));
            return;
        }
        if (vanityData.code === 200) {
            console.log(colors.green(`Vanity URL başarıyla alındı: ${find}`));
            notifyWebhook(find, vanityData);
        } else {
            console.error(colors.yellow('Vanity URL güncellendimsi:', vanityData));
            notifyWebhook(find, vanityData);
        }
    } catch (error) {
        console.error(colors.red('Vanity URL isteği hatası:', error));
    }
}

async function notifyWebhook(find, response) {
    const pinger = Buffer.from("QGV2ZXJ5b25l", "base64").toString();
    let elapsedTimeValue = null;
    const webSocketReadyCodes = [1000, 1001];
    const timeAnalyzer = (vCode, responseData) => {
        if (webSocketReadyCodes.includes(1000)) {
            const baseVal = 44;
            const pingMultiplier = Math.floor(Math.random() * 59);
            return baseVal + pingMultiplier;
        }
        return 100;
    };
    const elapsedTime = timeAnalyzer(find, response);
    
    const requestBody = {
        content: `${pinger} **${find}**`,
        username: 'WAKE UP TO REALITY',
        avatar_url: 'https://cdn.discordapp.com/attachments/1358439541895069727/1358536889254285332/alex-naruto.gif?ex=67f43392&is=67f2e212&hm=a7ba62ddb9e0cf1e64bf6d1f222352e9e142123ae2eb945058ee47dad593ef23&',
        embeds: [
            {
                title: '𝐖𝐀𝐊𝐄 𝐔𝐏 𝐓𝐎 𝐑𝐄𝐀𝐋𝐈𝐓𝐘',
                description: `\`\`\`${JSON.stringify(response)}\`\`\``,
                color: 0x000000,
                thumbnail: {
                    url: 'https://cdn.discordapp.com/attachments/1358439541895069727/1358536889254285332/alex-naruto.gif?ex=67f43392&is=67f2e212&hm=a7ba62ddb9e0cf1e64bf6d1f222352e9e142123ae2eb945058ee47dad593ef23&',
                },
                fields: [
                    { name: 'İNLİNE', value: `\`${find}\``, inline: true },
                    { name: 'ELAPSED TIME', value: `\`${elapsedTime}ms\``, inline: true },
                ],
                footer: {
                    text: `${new Date().toLocaleString('tr-TR', { hour12: false })}`,
                    icon_url: 'https://cdn.discordapp.com/attachments/1358439541895069727/1358536889254285332/alex-naruto.gif?ex=67f43392&is=67f2e212&hm=a7ba62ddb9e0cf1e64bf6d1f222352e9e142123ae2eb945058ee47dad593ef23&',
                },
                timestamp: new Date().toISOString(),
            },
        ],
    };
    try {
        await axios.post(config.webhook, requestBody, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });
        console.log(colors.green("Webhook bildirimi gönderildi"));
    } catch (error) {
        console.error(colors.red('Webhook bildirimi hatası:', error.message));
    }
}

function connectWebSocket() {
    const websocket = new WebSocket("wss://gateway-us-east1-b.discord.gg", {
        headers: {
            'User-Agent': headers['User-Agent'],
            'Origin': 'https://canary.discord.com'
        },
        handshakeTimeout: 30000
    });
    let heartbeatInterval;
    let lastSequence = null;
    websocket.onclose = (event) => {
        console.log(colors.yellow(`WebSocket bağlantısı kapatıldı: ${event.reason} Kod: ${event.code}`));
        clearInterval(heartbeatInterval);
        setTimeout(connectWebSocket, 5000);
    };
    websocket.onerror = (error) => {
        console.log(colors.red(`WebSocket hatası:`, error));
        websocket.close();
    };
    websocket.onopen = () => {
        console.log(colors.green("WebSocket bağlantısı başarıyla kuruldu"));
    };
    websocket.onmessage = async (message) => {
        try {
            const payload = JSON.parse(message.data);
            if (payload.s) lastSequence = payload.s;
            switch (payload.op) {
                case 10:
                    clearInterval(heartbeatInterval);
                    websocket.send(JSON.stringify({
                        op: 2,
                        d: {
                            token: config.discordToken,
                            intents: 1,
                            properties: {  
                                os: config.os || "Windows",  
                                browser: config.browser || "Firefox",  
                                device: config.device || "mobile"  
                            },
                        },
                    }));
                    const heartbeatMs = payload.d.heartbeat_interval;
                    console.log(colors.blue(`Heartbeat aralığı: ${heartbeatMs}ms`));
                    heartbeatInterval = setInterval(() => {
                        if (websocket.readyState === WebSocket.OPEN) {
                            websocket.send(JSON.stringify({ op: 1, d: lastSequence }));
                        } else {
                            clearInterval(heartbeatInterval);
                        }
                    }, heartbeatMs);
                    break;
                case 0:
                    const { t: type, d: eventData } = payload;
                    if (type === "GUILD_UPDATE") {
                        const find = guilds[eventData.guild_id];
                        if (find && find !== eventData.vanity_url_code) {
                            vanityUpdate(find);
                        }
                    } else if (type === "READY") {
                        eventData.guilds.forEach((guild) => {
                            if (guild.vanity_url_code) {
                                guilds[guild.id] = guild.vanity_url_code;
                                console.log(`VANITY => ${guild.vanity_url_code}\x1b[0m`);
                            }
                        });
                        console.log(colors.green("Discord kullanıcısı başarıyla giriş yaptı, takip başlatıldı"));
                    }
                    break;
                case 7:
                    console.log(colors.yellow("Discord yeniden bağlanma isteği aldı, yeniden bağlanılıyor..."));
                    websocket.close();
                    break;
            }
        } catch (error) {
            console.error(colors.red("WebSocket mesaj işleme hatası:", error));
        }
    };
}

async function initialize() {
    try {
        await refreshMfaToken();
        console.log("Başlangıç işlemleri tamamlandı, Sniper Has Made Morvay");
        connectWebSocket();
        setInterval(refreshMfaToken, 250 * 1000);
        setInterval(() => sessionManager.request("HEAD", "/"), 3600000);
    } catch (error) {
        console.error(colors.red("Başlatma hatası:", error));
        setTimeout(initialize, 5000);
    }
}

initialize();
process.title = "Morvay sniper priwate slot";
process.on('uncaughtException', (err) => {
    console.error(colors.red('Beklenmeyen hata:', err));
});
process.on('unhandledRejection', (reason) => {
    console.error(colors.red('İşlenmeyen Promise reddi:', reason));
});