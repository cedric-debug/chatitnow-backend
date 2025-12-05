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

// --- CONSTANTS ---
const INACTIVITY_LIMIT = 10 * 60 * 1000; // 10 Minutes
const RECONNECT_GRACE_PERIOD = 60 * 1000; // 1 Minute

// --- SOCKET SETUP ---
const io = new Server(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  cors: {
    origin: "*", // Allows connections from anywhere (Vercel/Localhost)
    methods: ["GET", "POST"]
  }
});

// --- GLOBAL STATE ---
let waitingQueue = []; 
const sessionMap = new Map(); // Stores active sessions: sessionID -> { socketId, roomID, userData, timer }

// --- HELPER FUNCTIONS ---

// 1. Remove a user from the waiting queue by Session ID
function removeFromQueue(sessionID) {
  waitingQueue = waitingQueue.filter(u => u.sessionID !== sessionID);
}

// 2. Cleanup a session (Disconnect fully)
function cleanupSession(sessionID) {
  if (!sessionMap.has(sessionID)) return;
  
  const session = sessionMap.get(sessionID);
  
  // Stop the countdown if it exists
  if (session.timer) clearTimeout(session.timer);
  
  // Notify the partner that this user is GONE
  if (session.roomID) {
    io.to(session.roomID).emit('partner_disconnected');
    
    // Clear the room
    const room = io.sockets.adapter.rooms.get(session.roomID);
    if (room) {
      io.in(session.roomID).socketsLeave(session.roomID);
    }
  }
  
  // Remove from queue and map
  removeFromQueue(sessionID);
  sessionMap.delete(sessionID);
}

// 3. Match two sockets together
function matchUsers(socket1, socket2) {
  // Safety check: connections must exist
  if (!socket1 || !socket2) return;

  const roomID = `${socket1.id}#${socket2.id}`;
  
  // Join both to the room
  socket1.join(roomID);
  socket2.join(roomID);
  
  // Save room ID to socket object
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  // Update the persistent session map with the new Room ID
  if (socket1.sessionID && sessionMap.has(socket1.sessionID)) {
    sessionMap.get(socket1.sessionID).roomID = roomID;
  }
  if (socket2.sessionID && sessionMap.has(socket2.sessionID)) {
    sessionMap.get(socket2.sessionID).roomID = roomID;
  }

  // Remove both from the waiting queue
  removeFromQueue(socket1.sessionID);
  removeFromQueue(socket2.sessionID);

  // Get User Data safely (default to empty object if missing)
  const user1Data = socket1.userData || {};
  const user2Data = socket2.userData || {};

  // Notify User 1
  io.to(socket1.id).emit('matched', {
    name: user2Data.username || 'Stranger',
    field: user2Data.field || '',
    roomID: roomID
  });

  // Notify User 2
  io.to(socket2.id).emit('matched', {
    name: user1Data.username || 'Stranger',
    field: user1Data.field || '',
    roomID: roomID
  });
}

// --- IDLE CHECKER LOOP ---
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
  
  // Reject connection if no sessionID (Client must send one)
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
    
    // 1. Cancel Grace Period Timer (User came back in time!)
    if (session.timer) {
      console.log(`Restored session: ${sessionID}`);
      clearTimeout(session.timer);
      session.timer = null;
    }

    // 2. Update Session with new Socket ID
    session.socketId = socket.id;
    socket.userData = session.userData;
    socket.roomID = session.roomID;

    // 3. If they were in a chat, rejoin them
    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected'); // Tell partner "I'm back"
    } 
    
    // 4. If they were in the queue, update the queue reference
    const queueItem = waitingQueue.find(q => q.sessionID === sessionID);
    if (queueItem) {
      queueItem.socket = socket;
    }

  } else {
    // --- NEW SESSION ---
    sessionMap.set(sessionID, { 
      socketId: socket.id, 
      roomID: null, 
      userData: null, 
      timer: null 
    });
  }

  // Track activity on any event
  socket.onAny(() => {
    socket.lastActive = Date.now();
  });

  // --- FIND PARTNER ---
  socket.on('find_partner', (userData) => {
    socket.userData = userData;
    
    // Save data to session map
    if (sessionMap.has(socket.sessionID)) {
      sessionMap.get(socket.sessionID).userData = userData;
    }

    // Prevent duplicates in queue
    if (waitingQueue.find(q => q.sessionID === socket.sessionID)) return;

    const isGenericField = userData.field === '' || userData.field === 'Others';

    // Delay matching slightly to simulate "searching"
    setTimeout(() => {
      if (!socket.connected) return;

      // Filter out self
      const potentialMatches = waitingQueue.filter(u => u.sessionID !== socket.sessionID);

      // 1. Priority Match (Same Field)
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

      // 2. Any Match (Desperate users or open field)
      if (potentialMatches.length > 0) {
         // Match with the longest waiting user
         const anyMatch = potentialMatches[0]; 
         matchUsers(socket, anyMatch.socket);
         return;
      }

      // 3. No match? Add to queue
      // Double check we aren't already there
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

  // --- SEND MESSAGE ---
  socket.on('send_message', (messageData) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('receive_message', {
        text: messageData.text,
        type: 'stranger',
        replyTo: messageData.replyTo,
        timestamp: messageData.timestamp
      });
    }
  });

  // --- TYPING ---
  socket.on('typing', (isTyping) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('partner_typing', isTyping);
    }
  });

  // --- MANUAL DISCONNECT (Next/End) ---
  socket.on('disconnect_partner', () => {
    cleanupSession(socket.sessionID);
  });

  // --- SOCKET DISCONNECT (Tab close / Internet lost) ---
  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id} (${reason})`);

    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      
      // If user was just in queue, remove immediately (no grace period for queue)
      removeFromQueue(socket.sessionID);

      if (session.roomID) {
        // If in chat, tell partner "Reconnecting..."
        socket.to(session.roomID).emit('partner_reconnecting_server');
        
        // Start 1 Minute Grace Timer
        session.timer = setTimeout(() => {
          console.log(`Session expired: ${socket.sessionID}`);
          cleanupSession(socket.sessionID);
        }, RECONNECT_GRACE_PERIOD);
      } else {
        // Not in chat? Delete session immediately
        sessionMap.delete(socket.sessionID);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});