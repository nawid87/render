const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: 'https://pepper-transport-database-appreciated.trycloudflare.com',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

const activeCalls = new Map(); // Track active calls by callId

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('register', (userId) => {
        console.log(`Registering user: ${userId}`);
        socket.join(userId.toString());
    });

    socket.on('offer', (data) => {
        console.log(`Offer from: ${data.from} to: ${data.to}, callId: ${data.callId}`);
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
            console.log(`Call already active: ${data.callId}`);
        }
    });

    socket.on('answer', (data) => {
        console.log(`Answer from: ${data.from} to: ${data.to}, callId: ${data.callId}`);
        if (activeCalls.has(data.callId)) {
            io.to(data.to.toString()).emit('answer', {
                answer: data.answer,
                from: data.from,
                to: data.to,
                callId: data.callId
            });
        } else {
            console.log(`No active call for answer: ${data.callId}`);
        }
    });

    socket.on('ice-candidate', (data) => {
        console.log(`ICE candidate from: ${data.from} to: ${data.to}, callId: ${data.callId}`);
        if (activeCalls.has(data.callId)) {
            io.to(data.to.toString()).emit('ice-candidate', {
                candidate: data.candidate,
                to: data.to,
                from: data.from,
                callId: data.callId
            });
        } else {
            console.log(`No active call for ICE candidate: ${data.callId}`);
        }
    });

    socket.on('end-call', (data) => {
        console.log(`End call from: ${data.from} to: ${data.to}, callId: ${data.callId}`);
        if (activeCalls.has(data.callId)) {
            const call = activeCalls.get(data.callId);
            activeCalls.delete(data.callId);
            io.to(call.to.toString()).emit('end-call', { to: call.to, from: call.from, callId: data.callId });
            io.to(call.from.toString()).emit('end-call', { to: call.from, from: call.to, callId: data.callId });
        } else {
            console.log(`No active call to end: ${data.callId}`);
        }
    });

    socket.on('heartbeat', (data) => {
        console.log(`Heartbeat from user: ${data.userId}`);
        socket.emit('heartbeat-response', { userId: data.userId });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
