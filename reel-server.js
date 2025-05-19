require('dotenv').config();
const WebSocket = require('ws');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const sanitizeHtml = require('sanitize-html');

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 8080,
    RATE_LIMIT: {
        points: 100, // 100 requests
        duration: 60 // per 60 seconds
    },
    HEARTBEAT_INTERVAL: 30000, // 30 seconds
    TOKEN_EXPIRY: 3600000 // 1 hour in ms
};

// In-Memory Storage
const tokens = new Map([
    ['demo-token-123', { user_id: 1, username: 'user1', profile_pic: '/uploads/profiles/user1.jpg', expires: Date.now() + CONFIG.TOKEN_EXPIRY }],
    ['demo-token-456', { user_id: 2, username: 'user2', profile_pic: '/uploads/profiles/user2.jpg', expires: Date.now() + CONFIG.TOKEN_EXPIRY }]
]);
const reels = new Map([
    [1, { like_count: 0, comment_count: 0 }],
    [2, { like_count: 0, comment_count: 0 }]
]);
const clients = new Map(); // Map<ws, { userId: number, ip: string }>

// Initialize Rate Limiter
const rateLimiter = new RateLimiterMemory({
    points: CONFIG.RATE_LIMIT.points,
    duration: CONFIG.RATE_LIMIT.duration
});

// Initialize WebSocket Server
const wss = new WebSocket.Server({ port: CONFIG.PORT });

// Logging Utility
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);
}

// Sanitize Input
function sanitize(input) {
    return sanitizeHtml(input, {
        allowedTags: [],
        allowedAttributes: {}
    });
}

// Validate Token
function validateToken(token) {
    const userData = tokens.get(token);
    if (!userData || userData.expires < Date.now()) {
        throw new Error('Invalid or expired token');
    }
    return userData;
}

// Broadcast Message
function broadcast(message, targetUserId = null) {
    const messageString = JSON.stringify(message);
    clients.forEach((clientData, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            if (!targetUserId || clientData.userId === targetUserId) {
                ws.send(messageString);
            }
        }
    });
}

// Heartbeat Mechanism
function startHeartbeat() {
    setInterval(() => {
        clients.forEach((clientData, ws) => {
            if (ws.isAlive === false) {
                clients.delete(ws);
                ws.terminate();
                log(`Client ${clientData.ip} (user ${clientData.userId}) disconnected due to heartbeat failure`);
                return;
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, CONFIG.HEARTBEAT_INTERVAL);
}

// WebSocket Connection Handler
wss.on('connection', async (ws, req) => {
    const ip = req.socket.remoteAddress;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    try {
        // Rate Limit Connection Attempts
        await rateLimiter.consume(ip);

        // Validate Token
        const userData = validateToken(token);

        // Store Client Data
        clients.set(ws, { userId: userData.user_id, ip });
        ws.isAlive = true;

        log(`Client connected: IP ${ip}, User ID ${userData.user_id}, Username ${userData.username}`);

        // Handle Messages
        ws.on('message', async (message) => {
            try {
                // Rate Limit Messages
                await rateLimiter.consume(ip);

                const data = JSON.parse(message);
                if (!data.action || !['like', 'unlike', 'save', 'unsave', 'comment', 'delete', 'follow'].includes(data.action)) {
                    throw new Error('Invalid action');
                }

                const sanitizedData = {
                    action: sanitize(data.action),
                    reel_id: data.reel_id ? parseInt(data.reel_id) : null,
                    user_id: userData.user_id,
                    username: userData.username,
                    comment: data.comment ? {
                        username: userData.username,
                        profile_pic: userData.profile_pic,
                        comment_text: sanitize(data.comment.comment_text),
                        is_pinned: data.comment.is_pinned || false
                    } : null
                };

                // Update Reel Data
                if (sanitizedData.reel_id && sanitizedData.action !== 'follow') {
                    if (!reels.has(sanitizedData.reel_id)) {
                        throw new Error('Reel not found');
                    }
                    const reelData = reels.get(sanitizedData.reel_id);
                    sanitizedData.like_count = reelData.like_count;
                    sanitizedData.comment_count = reelData.comment_count;

                    if (sanitizedData.action === 'comment') {
                        reelData.comment_count += 1;
                    } else if (sanitizedData.action === 'like') {
                        reelData.like_count += 1;
                    } else if (sanitizedData.action === 'unlike') {
                        reelData.like_count = Math.max(0, reelData.like_count - 1);
                    }
                    reels.set(sanitizedData.reel_id, reelData);
                }

                // Broadcast Action
                broadcast(sanitizedData);
                log(`Action ${sanitizedData.action} by User ID ${userData.user_id} on Reel ${sanitizedData.reel_id || 'N/A'}`);
            } catch (error) {
                log(`Message processing failed: ${error.message}`, 'ERROR');
                ws.send(JSON.stringify({ error: error.message }));
            }
        });

        // Handle Pong
        ws.on('pong', () => {
            ws.isAlive = true;
        });

        // Handle Close
        ws.on('close', () => {
            clients.delete(ws);
            log(`Client disconnected: IP ${ip}, User ID ${userData.user_id}`);
        });

        // Handle Error
        ws.on('error', (error) => {
            log(`WebSocket error for IP ${ip}: ${error.message}`, 'ERROR');
        });

    } catch (error) {
        log(`Connection rejected for IP ${ip}: ${error.message}`, 'ERROR');
        ws.send(JSON.stringify({ error: error.message }));
        ws.terminate();
    }
});

// Start Heartbeat
startHeartbeat();

// Server Error Handling
wss.on('error', (error) => {
    log(`Server error: ${error.message}`, 'ERROR');
});

// Server Listening
wss.on('listening', () => {
    log(`WebSocket server running on ws://localhost:${CONFIG.PORT}`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
    log('Shutting down server');
    wss.close();
    process.exit(0);
});
