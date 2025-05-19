require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const sanitizeHtml = require('sanitize-html');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: 'https://nashville-zimbabwe-corporation-selecting.trycloudflare.com',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Configuration
const CONFIG = {
    RATE_LIMIT: {
        points: 100, // 100 requests
        duration: 60 // per 60 seconds
    },
    HEARTBEAT_INTERVAL: 30000, // 30 seconds
    TOKEN_EXPIRY: 3600000 // 1 hour in ms
};

// In-Memory Storage
const activeCalls = new Map(); // Track active calls by callId
const tokens = new Map([
    ['demo-token-123', { user_id: 1, username: 'user1', profile_pic: '/uploads/profiles/user1.jpg', expires: Date.now() + CONFIG.TOKEN_EXPIRY }],
    ['demo-token-456', { user_id: 2, username: 'user2', profile_pic: '/uploads/profiles/user2.jpg', expires: Date.now() + CONFIG.TOKEN_EXPIRY }]
]);
const reels = new Map([
    [1, { like_count: 0, comment_count: 0 }],
    [2, { like_count: 0, comment_count: 0 }]
]);
const users = [
    { id: 1, username: 'user1', full_name: 'User One', profile_pic: '/uploads/profiles/user1.jpg' },
    { id: 2, username: 'user2', full_name: 'User Two', profile_pic: '/uploads/profiles/user2.jpg' }
];
const clients = new Map();

// Initialize Rate Limiter
const rateLimiter = new RateLimiterMemory({
    points: CONFIG.RATE_LIMIT.points,
    duration: CONFIG.RATE_LIMIT.duration
});

// Logging Utility
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
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

// Heartbeat Mechanism
function startHeartbeat() {
    setInterval(() => {
        io.sockets.sockets.forEach((socket) => {
            if (!socket.isAlive) {
                const clientData = clients.get(socket.id);
                if (clientData) {
                    clients.delete(socket.id);
                    socket.disconnect(true);
                    log(`Client ${clientData.ip} (user ${clientData.userId}) disconnected due to heartbeat failure`);
                }
                return;
            }
            socket.isAlive = false;
            socket.emit('heartbeat');
        });
    }, CONFIG.HEARTBEAT_INTERVAL);
}

io.on('connection', (socket) => {
    const ip = socket.handshake.address;
    log(`User connected: ${socket.id}, IP: ${ip}`);
    socket.isAlive = true;

    socket.on('register', ({ userId, token }) => {
        try {
            const userData = validateToken(token);
            if (userData.user_id !== userId) {
                throw new Error('Token does not match user ID');
            }
            clients.set(socket.id, { userId, ip });
            socket.join(userId.toString());
            log(`Registered user: ${userId}`);
            socket.emit('register-success', { userId });
        } catch (error) {
            log(`Registration failed for ${socket.id}: ${error.message}`, 'ERROR');
            socket.emit('register-error', { error: error.message });
            socket.disconnect(true);
        }
    });

    // Calling Events
    socket.on('offer', async (data) => {
        try {
            await rateLimiter.consume(ip);
            log(`Offer from: ${data.from} to: ${data.to}, callId: ${data.callId}`);
            if (!activeCalls.has(data.callId)) {
                activeCalls.set(data.callId, { from: data.from, to: data.to });
                io.to(data.to.toString()).emit('offer', {
                    offer: data.offer,
                    from: data.from,
                    to: data.to,
                    callType: data.callType,
                    callId: data.callId
                });
            } else {
                log(`Call already active: ${data.callId}`);
            }
        } catch (error) {
            log(`Offer failed: ${error.message}`, 'ERROR');
        }
    });

    socket.on('answer', async (data) => {
        try {
            await rateLimiter.consume(ip);
            log(`Answer from: ${data.from} to: ${data.to}, callId: ${data.callId}`);
            if (activeCalls.has(data.callId)) {
                io.to(data.to.toString()).emit('answer', {
                    answer: data.answer,
                    from: data.from,
                    to: data.to,
                    callId: data.callId
                });
            } else {
                log(`No active call for answer: ${data.callId}`);
            }
        } catch (error) {
            log(`Answer failed: ${error.message}`, 'ERROR');
        }
    });

    socket.on('ice-candidate', async (data) => {
        try {
            await rateLimiter.consume(ip);
            log(`ICE candidate from: ${data.from} to: ${data.to}, callId: ${data.callId}`);
            if (activeCalls.has(data.callId)) {
                io.to(data.to.toString()).emit('ice-candidate', {
                    candidate: data.candidate,
                    to: data.to,
                    from: data.from,
                    callId: data.callId
                });
            } else {
                log(`No active call for ICE candidate: ${data.callId}`);
            }
        } catch (error) {
            log(`ICE candidate failed: ${error.message}`, 'ERROR');
        }
    });

    socket.on('end-call', async (data) => {
        try {
            await rateLimiter.consume(ip);
            log(`End call from: ${data.from} to: ${data.to}, callId: ${data.callId}`);
            if (activeCalls.has(data.callId)) {
                const call = activeCalls.get(data.callId);
                activeCalls.delete(data.callId);
                io.to(call.to.toString()).emit('end-call', { to: call.to, from: call.from, callId: data.callId });
                io.to(call.from.toString()).emit('end-call', { to: call.from, from: call.to, callId: data.callId });
            } else {
                log(`No active call to end: ${data.callId}`);
            }
        } catch (error) {
            log(`End call failed: ${error.message}`, 'ERROR');
        }
    });

    // Reels Events
    socket.on('reel-action', async (data) => {
        try {
            await rateLimiter.consume(ip);
            const clientData = clients.get(socket.id);
            if (!clientData) {
                throw new Error('Client not registered');
            }
            const userData = tokens.get(data.token);
            if (!userData || userData.user_id !== clientData.userId) {
                throw new Error('Invalid token');
            }
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
                } else if (sanitizedData.action === 'delete') {
                    reels.delete(sanitizedData.reel_id);
                }
                if (sanitizedData.action !== 'delete') {
                    reels.set(sanitizedData.reel_id, reelData);
                }
            }

            io.emit('reel-action', sanitizedData);
            log(`Reel action ${sanitizedData.action} by User ID ${userData.user_id} on Reel ${sanitizedData.reel_id || 'N/A'}`);
        } catch (error) {
            log(`Reel action failed: ${error.message}`, 'ERROR');
            socket.emit('reel-error', { error: error.message });
        }
    });

    // Search Users (In-Memory)
    socket.on('search-users', async ({ query, userId }) => {
        try {
            await rateLimiter.consume(ip);
            const searchTerm = query.toLowerCase().trim();
            const results = users.filter(user =>
                user.username.toLowerCase().includes(searchTerm) ||
                user.full_name.toLowerCase().includes(searchTerm)
            ).slice(0, 20);
            socket.emit('search-results', results);
            log(`Search by User ID ${userId}: ${query}, found ${results.length} users`);
        } catch (error) {
            log(`Search failed: ${error.message}`, 'ERROR');
            socket.emit('search-results', []);
        }
    });

    socket.on('heartbeat', () => {
        socket.isAlive = true;
    });

    socket.on('disconnect', () => {
        const clientData = clients.get(socket.id);
        if (clientData) {
            clients.delete(socket.id);
            log(`User disconnected: ${socket.id}, User ID ${clientData.userId}, IP: ${ip}`);
        }
    });

    socket.on('error', (error) => {
        log(`Socket error for ${socket.id}: ${error.message}`, 'ERROR');
    });
});

// Start Heartbeat
startHeartbeat();

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK' });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
    log('Shutting down server');
    io.close();
    server.close(() => process.exit(0));
});
