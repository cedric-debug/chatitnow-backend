const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

// Health Check
app.get("/", (req, res) => {
  res.send("ChatItNow Server is Running!");
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// --- CONFIGURATION ---
const INACTIVITY_LIMIT = 10 * 60 * 1000; // 10 Minutes
const RECONNECT_GRACE_PERIOD = 60 * 1000; // 1 Minute

// --- SOCKET SERVER SETUP ---
const io = new Server(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingTimeout: 60000, 
  pingInterval: 25000,
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// --- GLOBAL STATE ---
let waitingQueue = []; 
// Session Map: Key = sessionID, Value = { socketId, roomID, userData, timer }
const sessionMap = new Map(); 

// --- HELPER FUNCTIONS ---

// 1. Remove user from queue
function removeFromQueue(sessionID) {
  waitingQueue = waitingQueue.filter(u => u.sessionID !== sessionID);
}

// 2. Clean up a session (End chat fully)
function cleanupSession(sessionID) {
  if (!sessionMap.has(sessionID)) return;
  
  const session = sessionMap.get(sessionID);
  
  // Stop grace period timer
  if (session.timer) clearTimeout(session.timer);
  
  // Notify partner
  if (session.roomID) {
    io.to(session.roomID).emit('partner_disconnected');
    
    // Force everyone to leave the room so they don't get ghost messages
    io.in(session.roomID).socketsLeave(session.roomID);
  }
  
  removeFromQueue(sessionID);
  sessionMap.delete(sessionID);
}

// 3. Match two users
function matchUsers(socket1, socket2) {
  if (!socket1 || !socket2) return;

  const roomID = `${socket1.id}#${socket2.id}`;
  
  socket1.join(roomID);
  socket2.join(roomID);
  
  // Update session map with room info
  if (socket1.sessionID && sessionMap.has(socket1.sessionID)) {
    sessionMap.get(socket1.sessionID).roomID = roomID;
  }
  if (socket2.sessionID && sessionMap.has(socket2.sessionID)) {
    sessionMap.get(socket2.sessionID).roomID = roomID;
  }

  // Remove from queue
  removeFromQueue(socket1.sessionID);
  removeFromQueue(socket2.sessionID);

  // Safe Data Access
  const user1Data = socket1.userData || {};
  const user2Data = socket2.userData || {};

  io.to(socket1.id).emit('matched', {
    name: user2Data.username || 'Stranger',
    field: user2Data.field || '',
    roomID: roomID
  });

  io.to(socket2.id).emit('matched', {
    name: user1Data.username || 'Stranger',
    field: user1Data.field || '',
    roomID: roomID
  });
}

// --- IDLE CHECKER ---
setInterval(() => {
  const now = Date.now();
  io.sockets.sockets.forEach((socket) => {
    if (socket.lastActive && (now - socket.lastActive > INACTIVITY_LIMIT)) {
      socket.disconnect(true);
    }
  });
}, 60 * 1000);


// --- MAIN CONNECTION LOGIC ---
io.on('connection', (socket) => {
  const sessionID = socket.handshake.auth.sessionID;
  
  if (!sessionID) {
    console.log(`Rejected connection ${socket.id} (No Session ID)`);
    socket.disconnect();
    return;
  }

  socket.sessionID = sessionID;
  socket.lastActive = Date.now();

  console.log(`Connected: ${socket.id} (Session: ${sessionID})`);

  // --- RECONNECTION HANDLER ---
  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    
    // User came back! Cancel the disconnect timer.
    if (session.timer) {
      console.log(`Restored session: ${sessionID}`);
      clearTimeout(session.timer);
      session.timer = null;
    }

    // Update socket reference
    session.socketId = socket.id;
    socket.userData = session.userData;

    // CRITICAL FIX: Explicitly rejoin the room if it exists
    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected');
      console.log(`Socket ${socket.id} rejoined room ${session.roomID}`);
    } 
    
    // Update Queue Reference if they were waiting
    const queueItem = waitingQueue.find(q => q.sessionID === sessionID);
    if (queueItem) {
      queueItem.socket = socket;
    }

  } else {
    // New Session
    sessionMap.set(sessionID, { 
      socketId: socket.id, 
      roomID: null, 
      userData: null, 
      timer: null 
    });
  }

  socket.onAny(() => {
    socket.lastActive = Date.now();
  });

  // --- SEARCH LOGIC ---
  socket.on('find_partner', (userData) => {
    socket.userData = userData;
    
    if (sessionMap.has(socket.sessionID)) {
      sessionMap.get(socket.sessionID).userData = userData;
    }

    if (waitingQueue.find(q => q.sessionID === socket.sessionID)) return;

    const isGenericField = userData.field === '' || userData.field === 'Others';

    setTimeout(() => {
      if (!socket.connected) return;

      const potentialMatches = waitingQueue.filter(u => u.sessionID !== socket.sessionID);

      // 1. Priority Match
      if (!isGenericField) {
        const exactMatch = potentialMatches.find(u => 
          u.userData.field === userData.field && 
          u.userData.field !== '' && 
          u.userData.field !== 'Others'
        );
        if (exactMatch) {
          matchUsers(socket, exactMatch.socket);
          return;
        }
      }

      // 2. Any Match
      if (potentialMatches.length > 0) {
         matchUsers(socket, potentialMatches[0].socket);
         return;
      }

      // 3. Add to Queue
      if (!waitingQueue.find(q => q.sessionID === socket.sessionID)) {
        waitingQueue.push({ 
          sessionID: socket.sessionID, 
          socket: socket, 
          userData: userData, 
          joinedAt: Date.now() 
        });
      }
    }, 2000);
  });

  // --- SEND MESSAGE (ROBUST) ---
  socket.on('send_message', (messageData) => {
    // Lookup roomID from Session Map (Source of Truth)
    const session = sessionMap.get(socket.sessionID);
    const currentRoomID = session ? session.roomID : null;

    if (currentRoomID) {
      // Safety: Ensure socket is actually in the room (Socket.io glitch prevention)
      if (!socket.rooms.has(currentRoomID)) {
        console.log(`Socket ${socket.id} missing from room ${currentRoomID}, forcing join.`);
        socket.join(currentRoomID);
      }

      socket.to(currentRoomID).emit('receive_message', {
        text: messageData.text,
        type: 'stranger',
        replyTo: messageData.replyTo,
        timestamp: messageData.timestamp
      });
    } else {
      console.log(`Socket ${socket.id} tried to send message but has no roomID.`);
    }
  });

  socket.on('typing', (isTyping) => {
    const session = sessionMap.get(socket.sessionID);
    const currentRoomID = session ? session.roomID : null;
    
    if (currentRoomID) {
      socket.to(currentRoomID).emit('partner_typing', isTyping);
    }
  });

  socket.on('disconnect_partner', () => {
    cleanupSession(socket.sessionID);
  });

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id} (${reason})`);

    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      
      // If just waiting, remove immediately
      removeFromQueue(socket.sessionID);

      if (session.roomID) {
        // If chatting, wait 60s
        socket.to(session.roomID).emit('partner_reconnecting_server');
        
        session.timer = setTimeout(() => {
          console.log(`Session expired: ${socket.sessionID}`);
          cleanupSession(socket.sessionID);
        }, RECONNECT_GRACE_PERIOD);
      } else {
        sessionMap.delete(socket.sessionID);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});