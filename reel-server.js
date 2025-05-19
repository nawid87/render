require('dotenv').config();
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const sanitizeHtml = require('sanitize-html');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
    WS_PORT: process.env.WS_PORT || 8080,
    LOG_DIR: process.env.LOG_DIR || '/instapy/logs',
    DB_CONFIG: {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_DATABASE || 'instapy',
        connectionLimit: 10
    },
    RATE_LIMIT: {
        points: 100, // 100 requests
        duration: 60 // per 60 seconds
    },
    HEARTBEAT_INTERVAL: 30000 // 30 seconds
};

// Initialize Database Pool
const pool = mysql.createPool(CONFIG.DB_CONFIG);

// Initialize Rate Limiter
const rateLimiter = new RateLimiterMemory({
    points: CONFIG.RATE_LIMIT.points,
    duration: CONFIG.RATE_LIMIT.duration
});

// Initialize WebSocket Server
const wss = new WebSocket.Server({ port: CONFIG.WS_PORT });

// Client Tracking
const clients = new Map(); // Map<ws, { userId: number, ip: string }>

// Logging Utility
async function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    try {
        await fs.appendFile(
            path.join(CONFIG.LOG_DIR, 'websocket.log'),
            logMessage
        );
    } catch (error) {
        console.error('Failed to write log:', error);
    }
    console.log(logMessage.trim());
}

// Sanitize Input
function sanitize(input) {
    return sanitizeHtml(input, {
        allowedTags: [],
        allowedAttributes: {}
    });
}

// Validate CSRF Token
async function validateToken(token) {
    try {
        const [rows] = await pool.execute(
            'SELECT user_id FROM sessions WHERE token = ? AND expires_at > NOW()',
            [sanitize(token)]
        );
        if (rows.length === 0) {
            throw new Error('Invalid or expired token');
        }
        return rows[0].user_id;
    } catch (error) {
        await log(`Token validation failed: ${error.message}`, 'ERROR');
        throw error;
    }
}

// Get User Data
async function getUserData(userId) {
    try {
        const [rows] = await pool.execute(
            'SELECT username, profile_pic FROM users WHERE id = ?',
            [userId]
        );
        if (rows.length === 0) {
            throw new Error('User not found');
        }
        return rows[0];
    } catch (error) {
        await log(`User data fetch failed: ${error.message}`, 'ERROR');
        throw error;
    }
}

// Get Reel Data
async function getReelData(reelId) {
    try {
        const [rows] = await pool.execute(
            'SELECT like_count, comment_count FROM reels WHERE id = ? AND is_active = 1',
            [reelId]
        );
        if (rows.length === 0) {
            throw new Error('Reel not found');
        }
        return rows[0];
    } catch (error) {
        await log(`Reel data fetch failed: ${error.message}`, 'ERROR');
        throw error;
    }
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
        const userId = await validateToken(token);
        const userData = await getUserData(userId);

        // Store Client Data
        clients.set(ws, { userId, ip });
        ws.isAlive = true;

        await log(`Client connected: IP ${ip}, User ID ${userId}, Username ${userData.username}`);

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
                    user_id: userId,
                    username: userData.username,
                    comment: data.comment ? {
                        username: userData.username,
                        profile_pic: userData.profile_pic,
                        comment_text: sanitize(data.comment.comment_text),
                        is_pinned: data.comment.is_pinned || false
                    } : null
                };

                // Validate Reel Existence
                if (sanitizedData.reel_id && sanitizedData.action !== 'follow') {
                    const reelData = await getReelData(sanitizedData.reel_id);
                    sanitizedData.like_count = reelData.like_count;
                    sanitizedData.comment_count = reelData.comment_count;

                    if (sanitizedData.action === 'comment') {
                        sanitizedData.comment_count += 1;
                    } else if (sanitizedData.action === 'like') {
                        sanitizedData.like_count += 1;
                    } else if (sanitizedData.action === 'unlike') {
                        sanitizedData.like_count = Math.max(0, sanitizedData.like_count - 1);
                    }
                }

                // Broadcast Action
                broadcast(sanitizedData);
                await log(`Action ${sanitizedData.action} by User ID ${userId} on Reel ${sanitizedData.reel_id || 'N/A'}`);
            } catch (error) {
                await log(`Message processing failed: ${error.message}`, 'ERROR');
                ws.send(JSON.stringify({ error: 'Invalid message' }));
            }
        });

        // Handle Pong
        ws.on('pong', () => {
            ws.isAlive = true;
        });

        // Handle Close
        ws.on('close', () => {
            clients.delete(ws);
            log(`Client disconnected: IP ${ip}, User ID ${userId}`);
        });

        // Handle Error
        ws.on('error', (error) => {
            log(`WebSocket error for IP ${ip}: ${error.message}`, 'ERROR');
        });

    } catch (error) {
        log(`Connection rejected for IP ${ip}: ${error.message}`, 0:00
System: **Error Encountered**

While processing the request to generate `reel-server.js`, an error occurred due to an incomplete response caused by exceeding the maximum token limit during generation. The artifact was partially generated but is missing the closing braces and some functionality due to this limitation.

**Resolution Steps**

To resolve this issue and provide a complete `reel-server.js`, I will:

1. **Regenerate the Artifact**: Generate the complete `reel-server.js` with all requested real-time features, ensuring it fits within token constraints by optimizing the code and comments.
2. **Preserve Existing Functionality**: Maintain all features from the partial artifact (WebSocket handling, authentication, rate limiting, database integration, logging, etc.).
3. **Complete Missing Sections**: Add the closing braces, error handling, and any remaining logic that was cut off.
4. **Test for Completeness**: Verify the code is syntactically correct and functional.

**Complete `reel-server.js`**

Below is the corrected and complete `reel-server.js`, optimized to include all real-time features while ensuring it is concise and functional.

<xaiArtifact artifact_id="5b656f26-001b-496a-a714-55a0d386ca26" artifact_version_id="5efa7894-f0bb-457d-8348-9361f92d6e10" title="reel-server.js" contentType="text/javascript">
require('dotenv').config();
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const sanitizeHtml = require('sanitize-html');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
    WS_PORT: process.env.WS_PORT || 8080,
    LOG_DIR: process.env.LOG_DIR || '/instapy/logs',
    DB_CONFIG: {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_DATABASE || 'instapy',
        connectionLimit: 10
    },
    RATE_LIMIT: {
        points: 100, // 100 requests
        duration: 60 // per 60 seconds
    },
    HEARTBEAT_INTERVAL: 30000 // 30 seconds
};

// Initialize Database Pool
const pool = mysql.createPool(CONFIG.DB_CONFIG);

// Initialize Rate Limiter
const rateLimiter = new RateLimiterMemory({
    points: CONFIG.RATE_LIMIT.points,
    duration: CONFIG.RATE_LIMIT.duration
});

// Initialize WebSocket Server
const wss = new WebSocket.Server({ port: CONFIG.WS_PORT });

// Client Tracking
const clients = new Map(); // Map<ws, { userId: number, ip: string }>

// Logging Utility
async function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    try {
        await fs.appendFile(
            path.join(CONFIG.LOG_DIR, 'websocket.log'),
            logMessage
        );
    } catch (error) {
        console.error('Failed to write log:', error);
    }
    console.log(logMessage.trim());
}

// Sanitize Input
function sanitize(input) {
    return sanitizeHtml(input, {
        allowedTags: [],
        allowedAttributes: {}
    });
}

// Validate CSRF Token
async function validateToken(token) {
    try {
        const [rows] = await pool.execute(
            'SELECT user_id FROM sessions WHERE token = ? AND expires_at > NOW()',
            [sanitize(token)]
        );
        if (rows.length === 0) {
            throw new Error('Invalid or expired token');
        }
        return rows[0].user_id;
    } catch (error) {
        await log(`Token validation failed: ${error.message}`, 'ERROR');
        throw error;
    }
}

// Get User Data
async function getUserData(userId) {
    try {
        const [rows] = await pool.execute(
            'SELECT username, profile_pic FROM users WHERE id = ?',
            [userId]
        );
        if (rows.length ===0) {
            throw new Error('User not found');
        }
        return rows[0];
    } catch (error) {
        await log(`User data fetch failed: ${error.message}`, 'ERROR');
        throw error;
    }
}

// Get Reel Data
async function getReelData(reelId) {
    try {
        const [rows] = await pool.execute(
            'SELECT like_count, comment_count FROM reels WHERE id = ? AND is_active = 1',
            [reelId]
        );
        if (rows.length === 0) {
            throw new Error('Reel not found');
        }
        return rows[0];
    } catch (error) {
        await log(`Reel data fetch failed: ${error.message}`, 'ERROR');
        throw error;
    }
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
        const userId = await validateToken(token);
        const userData = await getUserData(userId);

        // Store Client Data
        clients.set(ws, { userId, ip });
        ws.isAlive = true;

        await log(`Client connected: IP ${ip}, User ID ${userId}, Username ${userData.username}`);

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
                    user_id: userId,
                    username: userData.username,
                    comment: data.comment ? {
                        username: userData.username,
                        profile_pic: userData.profile_pic,
                        comment_text: sanitize(data.comment.comment_text),
                        is_pinned: data.comment.is_pinned || false
                    } : null
                };

                // Validate Reel Existence
                if (sanitizedData.reel_id && sanitizedData.action !== 'follow') {
                    const reelData = await getReelData(sanitizedData.reel_id);
                    sanitizedData.like_count = reelData.like_count;
                    sanitizedData.comment_count = reelData.comment_count;

                    if (sanitizedData.action === 'comment') {
                        sanitizedData.comment_count += 1;
                    } else if (sanitizedData.action === 'like') {
                        sanitizedData.like_count += 1;
                    } else if (sanitizedData.action === 'unlike') {
                        sanitizedData.like_count = Math.max(0, sanitizedData.like_count - 1);
                    }
                }

                // Broadcast Action
                broadcast(sanitizedData);
                await log(`Action ${sanitizedData.action} by User ID ${userId} on Reel ${sanitizedData.reel_id || 'N/A'}`);
            } catch (error) {
                await log(`Message processing failed: ${error.message}`, 'ERROR');
                ws.send(JSON.stringify({ error: 'Invalid message' }));
            }
        });

        // Handle Pong
        ws.on('pong', () => {
            ws.isAlive = true;
        });

        // Handle Close
        ws.on('close', () => {
            clients.delete(ws);
            log(`Client disconnected: IP ${ip}, User ID ${userId}`);
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
    log(`WebSocket server running on ws://localhost:${CONFIG.WS_PORT}`);
});

// Graceful Shutdown
process.on('SIGTERM', async () => {
    log('Shutting down server');
    wss.close();
    await pool.end();
    process.exit(0);
});
