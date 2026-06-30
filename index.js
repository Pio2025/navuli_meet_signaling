require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const { verifyToken } = require('./middleware/auth');
const { registerRoomHandlers } = require('./handlers/room');
const { registerWebRTCHandlers } = require('./handlers/webrtc');
const { registerChatHandlers } = require('./handlers/chat');
const { registerWhiteboardHandlers } = require('./handlers/whiteboard');
const { registerWorkspaceHandlers }  = require('./handlers/workspace');
const rooms = require('./rooms');

const app    = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost')
  .split(',').map(o => o.trim());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 30000,
  pingInterval: 10000,
});

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

// Health check endpoint (for UptimeRobot keep-alive)
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Auth middleware for Socket.IO
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    console.warn(`[auth] REJECTED ${socket.id} — no token`);
    return next(new Error('Authentication token required'));
  }
  try {
    const decoded = verifyToken(token);
    socket.user = decoded;
    next();
  } catch (err) {
    console.warn(`[auth] REJECTED ${socket.id} — ${err.message}`);
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const who = socket.user?.guest_name
    ? `guest:${socket.user.guest_name}`
    : `user:${socket.user?.user_id ?? '?'}`;
  console.log(`[+] Connected   ${socket.id}  (${who})`);

  registerRoomHandlers(io, socket, rooms);
  registerWebRTCHandlers(io, socket, rooms);
  registerChatHandlers(io, socket, rooms);
  registerWhiteboardHandlers(io, socket, rooms);
  registerWorkspaceHandlers(io, socket);

  socket.on('disconnect', (reason) => {
    console.log(`[-] Disconnected ${socket.id}  (${who}) — ${reason}`);
    rooms.leaveAll(socket.id, (meetingUuid, displayName) => {
      // Use io.to().except() — socket.to() is unreliable here because Socket.IO
      // calls socket.leaveAll() before firing the disconnect event, so the socket
      // has already left its rooms and socket.to(room) finds no members.
      io.to(meetingUuid).except(socket.id).emit('peer-left', {
        socketId: socket.id,
        displayName,
      });
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[NavuliMeet Signaling] Listening on port ${PORT}`);
});
